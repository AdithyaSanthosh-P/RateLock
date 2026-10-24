// Open-model load for the experiment (constant-arrival-rate, so a slow server cannot slow the senders down).
// Workloads (docs/plan/phase7-experiment.md):
//   a  culprit holds connections too long + 20 victims         d  no culprit (false-positive control)
//   e  one legitimately slow key + 20 victims (fairness)       b, c  diagnostics (row lock, CPU hog)
// Every run is WARMUP_S seconds of normal traffic followed by MEASURE_S seconds of the workload.
import http from 'k6/http'
import exec from 'k6/execution'
import { Trend, Counter } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const WORKLOAD = __ENV.WORKLOAD || 'a'
const WARMUP_S = Number(__ENV.WARMUP_S || 30)
const MEASURE_S = Number(__ENV.MEASURE_S || 60)
const RUN_ID = __ENV.RUN_ID || 'dev'
const RESULTS_DIR = __ENV.RESULTS_DIR || `experiments/results/${RUN_ID}`
const keys = JSON.parse(open(__ENV.KEYS_FILE || '../keys.json'))

// Rates are starting points; the pilot (P7.3) tunes them. Totals are requests per second for the whole role.
const CULPRIT_RATE = Number(__ENV.CULPRIT_RATE || 8)
const VICTIM_RATE_PER_KEY = Number(__ENV.VICTIM_RATE_PER_KEY || 5)
const CULPRIT_HOLD_MS = Number(__ENV.CULPRIT_HOLD_MS || 1500)
const SLOW_RATE = Number(__ENV.SLOW_RATE || 4.8)   // workload e: ~9.6 of the 10 connections busy with legitimate 2 s calls

const VICTIM_TIGHT_RATE = Number(__ENV.VICTIM_TIGHT_RATE || 11)   // workload a2: just above the 10/s quota

const victims = keys.victims
const victimRole = (list = victims, perKey = VICTIM_RATE_PER_KEY) => ({
    role: 'victim', keys: list, method: 'GET', rate: perKey * list.length,
    warm: '/demo/cheap', meas: '/demo/cheap',
})

// role: label used in tags and metric names. warm/meas: path during each phase.
const WORKLOADS = {
    a: [
        { role: 'culprit', keys: keys.culprit, method: 'GET', rate: CULPRIT_RATE, warm: '/demo/txn?hold=50', meas: `/demo/txn?hold=${CULPRIT_HOLD_MS}` },
        victimRole(),
    ],
    // a2: same culprit as (a), but victims run just above their own quota. Used for the credit (beta) ablation:
    // a refunded token is the difference between a 429 and a 200 for a victim near its limit.
    a2: [
        { role: 'culprit', keys: keys.culprit, method: 'GET', rate: CULPRIT_RATE, warm: '/demo/txn?hold=50', meas: `/demo/txn?hold=${CULPRIT_HOLD_MS}` },
        victimRole(victims, VICTIM_TIGHT_RATE),
    ],
    b: [
        { role: 'culprit', keys: keys.culprit, method: 'GET', rate: 2, warm: '/demo/txn?hold=50&lock=1', meas: `/demo/txn?hold=${CULPRIT_HOLD_MS}&lock=1` },
        { role: 'hotvictim', keys: victims.slice(0, 10), method: 'POST', rate: 30, warm: '/demo/hotrow', meas: '/demo/hotrow' },
        victimRole(victims.slice(10)),
    ],
    c: [
        { role: 'culprit', keys: keys.culprit, method: 'GET', rate: 5, warm: '/demo/cpu?ms=5', meas: '/demo/cpu?ms=100' },
        victimRole(),
    ],
    d: [
        victimRole(),
        { role: 'other', keys: keys.spare.slice(0, 5), method: 'GET', rate: 10, warm: '/demo/txn?hold=50', meas: '/demo/txn?hold=50' },
    ],
    e: [
        { role: 'slow', keys: keys.dominant, method: 'GET', rate: SLOW_RATE, warm: '/demo/slow?ms=2000', meas: '/demo/slow?ms=2000' },
        victimRole(),
    ],
}

const roles = WORKLOADS[WORKLOAD]
if (!roles) throw new Error(`unknown WORKLOAD ${WORKLOAD}`)

// ---- metrics (must be created up front) ---------------------------------------------------
const ALL_ROLES = ['culprit', 'victim', 'hotvictim', 'slow', 'other']
const PHASES = ['warmup', 'measure']
const OUTCOMES = ['ok', 'rate', 'debt', 'timeout', 'other']
const lat = {}
const cnt = {}
for (const r of ALL_ROLES) for (const p of PHASES) {
    lat[`${r}_${p}`] = new Trend(`lat_${r}_${p}`, true)
    for (const o of OUTCOMES) cnt[`${r}_${p}_${o}`] = new Counter(`n_${r}_${p}_${o}`)
}

function record(role, phase, res) {
    let outcome = 'other'
    if (res.status === 200) {
        outcome = 'ok'
        lat[`${role}_${phase}`].add(res.timings.duration)
    } else if (res.status === 429) {
        const reason = res.json('reason')
        outcome = reason === 'contention_debt' ? 'debt' : 'rate'
    } else if (res.status === 503) {
        outcome = 'timeout'
    }
    cnt[`${role}_${phase}_${outcome}`].add(1)
}

// ---- scenarios ----------------------------------------------------------------------------
function scenarioFor(def, phase) {
    const warm = phase === 'warmup'
    const rate = Math.max(1, Math.round(def.rate * 10))   // per 10 s, so rates like 4.8/s are allowed
    return {
        executor: 'constant-arrival-rate',
        rate, timeUnit: '10s',
        duration: `${warm ? WARMUP_S : MEASURE_S}s`,
        startTime: warm ? '0s' : `${WARMUP_S}s`,
        preAllocatedVUs: Math.min(100, Math.round(def.rate) * 2 + 10),
        maxVUs: 600,
        exec: 'send',
        gracefulStop: '20s',
        env: { ROLE_INDEX: String(roles.indexOf(def)), PHASE: phase },
    }
}

const scenarios = {}
for (const def of roles) for (const phase of PHASES) scenarios[`${def.role}_${phase}`] = scenarioFor(def, phase)

export const options = {
    scenarios,
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    discardResponseBodies: false,
}

export function send() {
    const def = roles[Number(__ENV.ROLE_INDEX)]
    const phase = __ENV.PHASE
    // spread requests evenly over the role's keys
    const keyIndex = exec.scenario.iterationInTest % def.keys.length
    const url = BASE_URL + (phase === 'warmup' ? def.warm : def.meas)
    const params = {
        headers: { 'user-api-key': def.keys[keyIndex] },
        tags: { role: def.role, key_index: String(keyIndex), phase, endpoint: url.split('?')[0].replace('/demo/', '') },
        timeout: '30s',
        responseCallback: http.expectedStatuses(200, 429, 503),
    }
    const res = def.method === 'POST' ? http.post(url, null, params) : http.get(url, params)
    record(def.role, phase, res)
}

export function handleSummary(data) {
    const out = { workload: WORKLOAD, run_id: RUN_ID, warmup_s: WARMUP_S, measure_s: MEASURE_S, metrics: {} }
    for (const [name, m] of Object.entries(data.metrics)) {
        if (name.startsWith('lat_') || name.startsWith('n_') || name === 'http_reqs' || name === 'dropped_iterations') {
            out.metrics[name] = m.values
        }
    }
    const lines = Object.entries(out.metrics)
        .filter(([n, v]) => n.startsWith('n_') && n.includes('_measure_') && v.count > 0)
        .map(([n, v]) => `${n}=${v.count}`)
    return {
        [`${RESULTS_DIR}/k6_summary.json`]: JSON.stringify(out, null, 2),
        stdout: `\nmeasure-phase counts: ${lines.join(' ')}\n`,
    }
}
