// Batched writes to usage_logs and pool_holds. Rows are buffered in memory and flushed every LOG_BATCH_MS
// with one multi-row INSERT per table through sysPool, so logging never competes with request handling.
import { config } from '../config.js'
import { sysPool } from '../db/postgres.js'

const USAGE_COLS = [
    ['api_key', 'text'], ['endpoint', 'text'], ['tokens', 'int'], ['allowed', 'boolean'], ['latency_ms', 'int'],
    ['status_code', 'int'], ['reason', 'text'], ['overhead_us', 'int'], ['handler_ms', 'numeric'],
    ['cost', 'numeric'], ['debt_at_admit', 'numeric'], ['policy', 'text'], ['run_id', 'text'],
]

const HOLD_COLS = [
    ['run_id', 'text'], ['policy', 'text'], ['api_key', 'text'], ['endpoint', 'text'], ['acquired_at', 'timestamptz'],
    ['hold_ms', 'numeric'], ['wait_ms', 'numeric'], ['imposed_ms', 'numeric'], ['overstay_ms', 'numeric'],
    ['baseline_ms', 'numeric'], ['debit_tokens', 'numeric'], ['credit_tokens', 'numeric'],
]

// Turns row objects into one array per column, so a whole batch is a single unnest() statement.
function columnArrays(rows, cols) {
    return cols.map(([name]) => rows.map(r => r[name] ?? null))
}

function unnestSql(cols) {
    return cols.map(([, type], i) => `$${i + 1}::${type}[]`).join(', ')
}

export function makeLogWriter({ sysPool, config }) {
    let usageBuf = []
    let holdBuf = []
    let timer = null
    let flushing = Promise.resolve()

    async function writeBatches(usage, holds) {
        if (usage.length) {
            const names = USAGE_COLS.map(([n]) => n).join(', ')
            await sysPool.query(
                `INSERT INTO usage_logs (user_id, endpoint, tokens_deducted, allowed, latency_ms, status_code, reason,
                                         overhead_us, handler_ms, cost, debt_at_admit, policy, run_id)
                 SELECT u.id, t.endpoint, t.tokens, t.allowed, t.latency_ms, t.status_code, t.reason,
                        t.overhead_us, t.handler_ms, t.cost, t.debt_at_admit, t.policy, t.run_id
                 FROM unnest(${unnestSql(USAGE_COLS)}) AS t(${names})
                 JOIN users u ON u.api_key = t.api_key`,
                columnArrays(usage, USAGE_COLS)
            )
        }
        if (holds.length) {
            const names = HOLD_COLS.map(([n]) => n).join(', ')
            await sysPool.query(
                `INSERT INTO pool_holds (${names})
                 SELECT * FROM unnest(${unnestSql(HOLD_COLS)}) AS t(${names})`,
                columnArrays(holds, HOLD_COLS)
            )
        }
    }

    // Flushes are chained so two flushes never write at the same time and flush() really waits for pending rows.
    function flush() {
        const usage = usageBuf
        const holds = holdBuf
        usageBuf = []
        holdBuf = []
        flushing = flushing
            .then(() => writeBatches(usage, holds))
            .catch(err => console.error('Log flush failed:', err.message))
        return flushing
    }

    function ensureTimer() {
        if (timer) return
        timer = setInterval(flush, config.LOG_BATCH_MS)
        timer.unref()
    }

    return {
        logRequest(row) { ensureTimer(); usageBuf.push(row) },
        logHold(row) { ensureTimer(); holdBuf.push(row) },
        flush,
        async stop() {
            if (timer) clearInterval(timer)
            timer = null
            await flush()
        },
    }
}

// Shared instance for the app.
export const logWriter = makeLogWriter({ sysPool, config })
