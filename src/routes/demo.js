// Demo handlers used by the experiments. Each takes a `db` object with { query, withClient }.
// For now db is backed by sysPool; P3.3 swaps in ContentionPool, which has the same two methods.
import { redis } from '../db/redis.js'

const MAX_PARAM = 10000

// Reads a numeric query param, falling back to a default and clamping to [0, 10000].
function param(value, def) {
    const n = Number(value)
    if (value === undefined || !Number.isFinite(n)) return def
    return Math.min(MAX_PARAM, Math.max(0, n))
}

// Injected extra DB latency (set through /admin/inject), refreshed from Redis once a second.
let injectedDelayMs = 0
let refresher = null
function ensureDelayRefresher() {
    if (refresher) return
    const refresh = async () => {
        try {
            injectedDelayMs = Number(await redis.get('ratelock:inject:dbdelay_ms')) || 0
        } catch { /* keep the last value */ }
    }
    refresh()
    refresher = setInterval(refresh, 1000)
    refresher.unref()
}

export function makeDemoHandlers(db) {
    ensureDelayRefresher()

    // Runs fn on one client; if a delay is injected, sleep on that same client first so the delay
    // is time spent *holding* a connection.
    function run(fn) {
        return db.withClient(async client => {
            if (injectedDelayMs > 0) await client.query('SELECT pg_sleep($1)', [injectedDelayMs / 1000])
            return fn(client)
        })
    }

    return {
        root: (req, res) => {
            res.send('Random : ' + Math.random() * 100)
        },

        cheap: async (req, res) => {
            await run(client => client.query('SELECT 1'))
            res.json({ ok: true })
        },

        slow: async (req, res) => {
            const ms = param(req.query.ms, 2000)
            await run(client => client.query('SELECT pg_sleep($1)', [ms / 1000]))
            res.json({ ok: true, ms })
        },

        // BEGIN; [lock the hot row]; sleep `hold` ms; COMMIT, all on one connection.
        txn: async (req, res) => {
            const hold = param(req.query.hold, 50)
            const lock = req.query.lock === '1'
            await run(async client => {
                await client.query('BEGIN')
                try {
                    if (lock) await client.query('SELECT v FROM hot_rows WHERE id = 1 FOR UPDATE')
                    await client.query('SELECT pg_sleep($1)', [hold / 1000])
                    await client.query('COMMIT')
                } catch (err) {
                    await client.query('ROLLBACK').catch(() => {})
                    throw err
                }
            })
            res.json({ ok: true, hold, lock })
        },

        hotrow: async (req, res) => {
            const r = await run(client => client.query('UPDATE hot_rows SET v = v + 1 WHERE id = 1 RETURNING v'))
            res.json({ ok: true, v: r.rows[0].v })
        },

        // Synchronous busy loop: blocks the event loop, uses no DB.
        cpu: (req, res) => {
            const ms = param(req.query.ms, 50)
            const start = performance.now()
            while (performance.now() - start < ms) { /* spin */ }
            res.json({ ok: true, ms })
        },
    }
}
