// Live demo dashboard. One process that
//   1. starts the RateLock API (index.js) with the policy you pick in the browser,
//   2. drives it with traffic you can switch on and off (same roles and rates as the experiment workloads),
//   3. polls the API and Redis and streams everything to the page over Server-Sent Events.
// Usage: npm run dashboard   then open http://localhost:4000
import express from 'express'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Redis from 'ioredis'
import pg from 'pg'
import { config } from '../src/config.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DASH_PORT = Number(process.env.DASH_PORT || 4000)
const API = `http://localhost:${config.PORT}`
const POLICIES = ['plain', 'own_usage', 'conex', 'holder_whole', 'holder_overstay']
const RUN_ID = 'live_demo'

const keysFile = path.join(ROOT, 'experiments', 'keys.json')
if (!fs.existsSync(keysFile)) {
    console.error('experiments/keys.json is missing. Run: node experiments/seed.js')
    process.exit(1)
}
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'))

// api key -> who it is on screen
const who = new Map()
who.set(keys.culprit[0], { role: 'culprit', label: 'culprit' })
who.set(keys.dominant[0], { role: 'slow', label: 'slow key' })
keys.victims.forEach((k, i) => who.set(k, { role: 'victim', label: 'V' + String(i + 1).padStart(2, '0') }))
const whoIs = apiKey => who.get(apiKey) ?? { role: 'other', label: '?' }

const redis = new Redis(config.REDIS_URL)
const pgPool = new pg.Pool({
    host: config.PG_HOST, port: config.PG_PORT, user: config.PG_USER,
    password: config.PG_PASSWORD, database: config.PG_DATABASE, max: 2,
})

// ---- the API process --------------------------------------------------------------------------

const state = {
    policy: process.env.DEMO_POLICY || 'plain',
    ready: false,
    switching: true,
    traffic: { victims: true, culprit: 'normal', slow: false },   // culprit: off | normal | hog
}
let apiProc = null
let eventCursor = 0

async function waitForHealth(timeoutMs = 30000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        try {
            const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })
            if (r.ok) return true
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 250))
    }
    return false
}

async function startApi(policy) {
    eventCursor = 0
    apiProc = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: { ...process.env, RL_POLICY: policy, RL_RUN_ID: RUN_ID, RL_LOAD_MULTIPLIER: 'off', LOG_BATCH_MS: '1000' },
        stdio: ['ignore', 'ignore', 'inherit'],
    })
    apiProc.once('exit', () => { apiProc = null; state.ready = false })
    state.ready = await waitForHealth()
    if (!state.ready) console.error('API did not start')
}

async function stopApi() {
    const proc = apiProc
    if (!proc) return
    await new Promise(resolve => {
        const force = setTimeout(() => proc.kill('SIGKILL'), 5000)
        proc.once('exit', () => { clearTimeout(force); resolve() })
        proc.kill('SIGTERM')
    })
}

// Clears limiter state (buckets and debts) so every scene starts from a clean slate.
async function resetLimiterState() {
    for (const pattern of ['ratelock:{*}:debt', 'ratelock:{*}:b:*']) {
        const found = []
        for await (const batch of redis.scanStream({ match: pattern, count: 500 })) found.push(...batch)
        if (found.length) await redis.unlink(...found)
    }
    await pgPool.query('UPDATE endpoint_costs SET token_cost = base_token_cost, live_hold_ms = NULL')
}

let switchChain = Promise.resolve()
function switchPolicy(policy) {
    switchChain = switchChain.then(async () => {
        state.switching = true
        state.ready = false
        await stopApi()
        await resetLimiterState()
        state.policy = policy
        marks.push({ t: Date.now(), policy })
        await startApi(policy)
        state.switching = false
    }).catch(err => { console.error('policy switch failed:', err); state.switching = false })
    return switchChain
}

// ---- traffic generator ------------------------------------------------------------------------

const roles = {
    victim: { keys: keys.victims, rate: () => (state.traffic.victims ? 5 * keys.victims.length : 0), path: () => '/demo/cheap' },
    culprit: {
        keys: keys.culprit,
        rate: () => (state.traffic.culprit === 'off' ? 0 : 8),
        path: () => (state.traffic.culprit === 'hog' ? '/demo/txn?hold=1500' : '/demo/txn?hold=50'),
    },
    slow: { keys: keys.dominant, rate: () => (state.traffic.slow ? 4.8 : 0), path: () => '/demo/slow?ms=2000' },
}
for (const r of Object.values(roles)) { r.acc = 0; r.next = 0 }

const emptyBucket = () => ({ ok: 0, rate: 0, debt: 0, timeout: 0, err: 0, lat: [] })
let current = Object.fromEntries(Object.keys(roles).map(r => [r, emptyBucket()]))

async function fire(roleName) {
    const role = roles[roleName]
    const key = role.keys[role.next++ % role.keys.length]
    const t0 = performance.now()
    let outcome = 'err'
    try {
        const res = await fetch(API + role.path(), { headers: { 'user-api-key': key }, signal: AbortSignal.timeout(20000) })
        if (res.status === 200) outcome = 'ok'
        else if (res.status === 429) {
            const body = await res.json().catch(() => ({}))
            outcome = body.reason === 'contention_debt' ? 'debt' : 'rate'
        } else if (res.status === 503) outcome = 'timeout'
        await res.arrayBuffer().catch(() => {})
    } catch { /* connection refused while the API restarts */ }
    const b = current[roleName]
    b[outcome]++
    if (outcome === 'ok') b.lat.push(performance.now() - t0)
}

let lastTick = performance.now()
setInterval(() => {
    const now = performance.now()
    const dt = (now - lastTick) / 1000
    lastTick = now
    if (!state.ready || state.switching) return
    for (const [name, role] of Object.entries(roles)) {
        role.acc += role.rate() * dt
        let n = Math.min(Math.floor(role.acc), 60)
        role.acc -= Math.floor(role.acc)
        while (n-- > 0) fire(name)
    }
}, 25)

// ---- history and streaming --------------------------------------------------------------------

const HISTORY_SEC = 180
const history = []   // one entry per second
const marks = [{ t: Date.now(), policy: state.policy }]
const clients = new Set()

function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
function broadcast(event, data) {
    for (const c of clients) send(c, event, data)
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null)

setInterval(() => {
    const entry = { t: Date.now(), policy: state.policy, roles: {} }
    for (const [name, b] of Object.entries(current)) {
        const sorted = b.lat.sort((x, y) => x - y)
        entry.roles[name] = {
            ok: b.ok, rate: b.rate, debt: b.debt, timeout: b.timeout, err: b.err,
            p50: pct(sorted, 0.5), p99: pct(sorted, 0.99),
        }
    }
    current = Object.fromEntries(Object.keys(roles).map(r => [r, emptyBucket()]))
    history.push(entry)
    if (history.length > HISTORY_SEC) history.shift()
    broadcast('sec', entry)
}, 1000)

// Bucket and debt of a few keys, read straight from Redis with the same decay and refill math as admit.lua.
const tracked = [
    { label: 'culprit', role: 'culprit', key: keys.culprit[0], endpoint: 'demo.txn' },
    { label: 'slow key', role: 'slow', key: keys.dominant[0], endpoint: 'demo.slow' },
    { label: 'V01', role: 'victim', key: keys.victims[0], endpoint: 'demo.cheap' },
    { label: 'V08', role: 'victim', key: keys.victims[7], endpoint: 'demo.cheap' },
    { label: 'V15', role: 'victim', key: keys.victims[14], endpoint: 'demo.cheap' },
]
const DEBT_DECAY_PER_MS = config.RL_DEBT_DECAY_PER_SEC / 1000

async function readKeyStates() {
    const p = redis.pipeline()
    for (const t of tracked) {
        p.hmget(`ratelock:{${t.key}}:b:${t.endpoint}`, 'tokens', 'ts')
        p.hmget(`ratelock:{${t.key}}:debt`, 'd', 'ts')
        p.hmget(`ratelock:{${t.key}}:tier`, 'cap', 'rate_per_ms')
    }
    const out = await p.exec()
    const now = Date.now()
    return tracked.map((t, i) => {
        const [tokens, bts] = out[i * 3][1]
        const [d, dts] = out[i * 3 + 1][1]
        const [capRaw, rateRaw] = out[i * 3 + 2][1]
        const cap = Number(capRaw) || 20
        const rate = Number(rateRaw) || 0.01
        const tok = tokens == null ? cap : Math.min(cap, Number(tokens) + Math.max(0, now - Number(bts)) * rate)
        const debt = d == null ? 0 : Math.max(0, Number(d) - Math.max(0, now - Number(dts)) * DEBT_DECAY_PER_MS)
        return { label: t.label, role: t.role, tokens: tok, cap, debt }
    })
}

async function pollOnce() {
    const frame = { t: Date.now(), policy: state.policy, switching: state.switching, apiUp: state.ready, traffic: state.traffic }
    if (state.ready && !state.switching) {
        try {
            const r = await fetch(`${API}/admin/live?since=${eventCursor}`, {
                headers: { 'x-admin-token': config.ADMIN_TOKEN }, signal: AbortSignal.timeout(800),
            })
            const live = await r.json()
            if (live.seq < eventCursor) eventCursor = 0
            else eventCursor = live.seq
            const named = x => ({ ...x, ...whoIs(x.apiKey), apiKey: undefined })
            frame.pool = {
                size: live.pool.size,
                gamma: live.pool.gamma,
                holders: live.pool.holders.map(named),
                waiterCount: live.pool.waiterCount,
                waiters: live.pool.waiters.map(named),
            }
            frame.settlement = live.settlement
            frame.events = live.events.map(named)
        } catch { frame.apiUp = false }
        try { frame.keys = await readKeyStates() } catch { /* redis hiccup: skip this frame's gauges */ }
    }
    broadcast('frame', frame)
}

;(async function pollLoop() {
    for (;;) {
        await pollOnce().catch(err => console.error('poll failed:', err.message))
        await new Promise(r => setTimeout(r, 250))
    }
})()

// ---- web server -------------------------------------------------------------------------------

const app = express()
app.use(express.json())
app.use(express.static(path.join(ROOT, 'dashboard', 'public')))

app.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    send(res, 'init', { history, marks, policies: POLICIES, state, quota: { cap: 20, ratePerSec: 10 } })
    clients.add(res)
    req.on('close', () => clients.delete(res))
})

function applyTraffic(t = {}) {
    if (typeof t.victims === 'boolean') state.traffic.victims = t.victims
    if (['off', 'normal', 'hog'].includes(t.culprit)) state.traffic.culprit = t.culprit
    if (typeof t.slow === 'boolean') state.traffic.slow = t.slow
}

app.post('/api/traffic', (req, res) => {
    applyTraffic(req.body)
    res.json(state.traffic)
})

app.post('/api/policy', async (req, res) => {
    if (!POLICIES.includes(req.body?.policy)) return res.status(400).json({ error: 'unknown policy' })
    switchPolicy(req.body.policy)
    res.json({ ok: true })
})

// A scene sets policy and traffic together, for the one-click demo buttons.
app.post('/api/scene', (req, res) => {
    const { policy, traffic } = req.body ?? {}
    if (!POLICIES.includes(policy)) return res.status(400).json({ error: 'unknown policy' })
    applyTraffic(traffic)
    if (policy !== state.policy || state.switching) switchPolicy(policy)
    else resetLimiterState().catch(err => console.error(err))
    res.json({ ok: true })
})

app.post('/api/reset', async (req, res) => {
    await resetLimiterState().catch(err => console.error(err))
    res.json({ ok: true })
})

async function main() {
    try {
        await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) })
        console.error(`Something is already serving ${API}. Stop it first (the dashboard starts its own API).`)
        process.exit(1)
    } catch { /* port free, good */ }

    // Earlier live sessions leave rows behind; the experiment results are not touched.
    await pgPool.query(`DELETE FROM usage_logs WHERE run_id = $1`, [RUN_ID])
    await pgPool.query(`DELETE FROM pool_holds WHERE run_id = $1`, [RUN_ID])
    await resetLimiterState()

    app.listen(DASH_PORT, 'localhost', () => console.log(`RateLock dashboard on http://localhost:${DASH_PORT}`))
    await startApi(state.policy)
    state.switching = false
}

// Stop sending traffic first, otherwise the API keeps getting requests after it has closed its pools.
// A second Ctrl+C quits at once and kills the API.
let shuttingDown = false
async function shutdown() {
    if (shuttingDown) {
        apiProc?.kill('SIGKILL')
        process.exit(1)
    }
    shuttingDown = true
    state.switching = true
    await stopApi()
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch(err => { console.error(err); process.exit(1) })
