// Open-loop replay of the Azure schedule (D26): every trace call is sent at its own offset, whatever the
// server does, so a slow server cannot slow the senders down (same property as k6 constant-arrival-rate).
// Node instead of k6 because k6 has no executor for an arbitrary per-request schedule.
// Usage: node experiments/azure/replay.js RESULTS_DIR   (BASE_URL env, default http://localhost:3000)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const dir = process.argv[2]
if (!dir) throw new Error('usage: node experiments/azure/replay.js RESULTS_DIR')

const keys = JSON.parse(fs.readFileSync(OUT + 'keys.json', 'utf8'))
const [header, ...lines] = fs.readFileSync(OUT + 'schedule.csv', 'utf8').trim().split('\n')
const cols = header.split(',')
const schedule = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])))

async function send(row, t0) {
    const sentAt = performance.now()
    const url = `${BASE_URL}/replay/${row.ep}?ms=${row.hold_ms}`
    let status = 0, reason = ''
    try {
        const res = await fetch(url, { headers: { 'user-api-key': keys[Number(row.app)] }, signal: AbortSignal.timeout(130000) })
        status = res.status
        const body = await res.json().catch(() => ({}))
        reason = body.reason || body.error || ''
    } catch (err) {
        reason = err.name === 'TimeoutError' ? 'client_timeout' : 'client_error'
    }
    return {
        ...row,
        lag_ms: (sentAt - t0 - Number(row.offset_ms)).toFixed(1),   // how late the send was versus the schedule
        latency_ms: (performance.now() - sentAt).toFixed(1),
        status, reason,
    }
}

const t0 = performance.now() + 500
const results = await Promise.all(schedule.map(row => new Promise(resolve => {
    setTimeout(() => send(row, t0).then(resolve), Math.max(0, t0 + Number(row.offset_ms) - performance.now()))
})))

const outCols = [...cols, 'lag_ms', 'latency_ms', 'status', 'reason']
fs.writeFileSync(`${dir}/requests.csv`, [outCols.join(','), ...results.map(r => outCols.map(c => r[c]).join(','))].join('\n') + '\n')
const byStatus = {}
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1
console.log(`replayed ${results.length} calls:`, JSON.stringify(byStatus))
