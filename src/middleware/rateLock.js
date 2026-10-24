// rateLock(endpointId): per-route admission middleware (decision D1).
//   1. authenticate the key and find its tier (Redis cache, Postgres on a miss)
//   2. ask admit.lua for a decision (refill + debt check + spend, atomic)
//   3. on admit, run the rest of the request inside an AsyncLocalStorage context
// Every admitted or denied request is logged with overhead and handler time separated.
import { config } from '../config.js'
import { redis } from '../db/redis.js'
import { sysPool } from '../db/postgres.js'
import { als } from '../context.js'
import { logWriter } from '../services/logWriter.js'

const TIER_SQL = `SELECT t.name, t.tokens_per_hour, t.burst
                  FROM users u JOIN tiers t ON u.tier_id = t.id
                  WHERE u.api_key = $1`

const idleTtlMs = config.RL_BUCKET_IDLE_TTL_SEC * 1000
const debtDecayPerMs = config.RL_DEBT_DECAY_PER_SEC / 1000

let nextReqId = 1

// Cache-aside tier lookup. Returns { cap, ratePerMs, tier } or null for an unknown key.
async function loadTier(apiKey) {
    const tierKey = `ratelock:{${apiKey}}:tier`
    const cached = await redis.hgetall(tierKey)
    if (cached.cap) {
        return { cap: Number(cached.cap), ratePerMs: Number(cached.rate_per_ms), tier: cached.tier }
    }
    const result = await sysPool.query(TIER_SQL, [apiKey])
    if (result.rowCount === 0) return null
    const { name, tokens_per_hour, burst } = result.rows[0]
    const tier = {
        cap: burst ?? tokens_per_hour,
        ratePerMs: tokens_per_hour / 3_600_000,
        tier: name,
    }
    await redis.multi()
        .hset(tierKey, { cap: tier.cap, rate_per_ms: tier.ratePerMs, tier: tier.tier })
        .expire(tierKey, config.RL_TIER_CACHE_TTL_SEC)
        .exec()
    return tier
}

function ns(from) {
    return Number(process.hrtime.bigint() - from)
}

export function rateLock(endpointId) {
    return async (req, res, next) => {
        const t0 = process.hrtime.bigint()
        const apiKey = req.headers['user-api-key']
        if (!apiKey) return res.status(401).json({ error: 'invalid_api_key' })

        let tier = null
        let decision
        let cost = 1
        let failOpen = false

        try {
            tier = await loadTier(apiKey)
            if (!tier) return res.status(401).json({ error: 'invalid_api_key' })

            cost = parseFloat(await redis.get(`ratelock:cost:${endpointId}`)) || 1
            const r = await redis.admit(
                `ratelock:{${apiKey}}:b:${endpointId}`,
                `ratelock:{${apiKey}}:debt`,
                tier.cap, tier.ratePerMs, cost, idleTtlMs, debtDecayPerMs
            )
            decision = { allowed: r[0] === 1, retryMs: parseFloat(r[2]), reason: r[3], debt: parseFloat(r[4]) }
        } catch (err) {
            console.error('Admission error:', err.message)
            if (!config.RL_FAIL_OPEN) return res.status(503).json({ error: 'limiter_unavailable' })
            failOpen = true
            decision = { allowed: true, retryMs: 0, reason: 'fail_open', debt: 0 }
        }

        const tAdmit = process.hrtime.bigint()
        const overheadUs = Math.round(ns(t0) / 1000)

        const baseRow = {
            api_key: apiKey,
            endpoint: endpointId,
            cost,
            debt_at_admit: decision.debt,
            policy: config.RL_POLICY,
            run_id: config.RL_RUN_ID,
            overhead_us: overheadUs,
        }

        if (decision.debt > 0) res.set('RateLock-Debt', decision.debt.toFixed(3))

        if (!decision.allowed) {
            res.set('Retry-After', String(Math.ceil(decision.retryMs / 1000)))
            if (decision.reason === 'contention_debt') {
                res.set('RateLock-Reason', `contention-debit; amount=${decision.debt.toFixed(3)}`)
            }
            res.status(429).json({ error: 'rate_limited', reason: decision.reason, retry_after_ms: decision.retryMs })
            logWriter.logRequest({
                ...baseRow, tokens: 0, allowed: false, latency_ms: 0, status_code: 429,
                reason: decision.reason, handler_ms: 0,
            })
            return
        }

        res.once('finish', () => {
            const handlerMs = ns(tAdmit) / 1e6
            logWriter.logRequest({
                ...baseRow,
                tokens: failOpen ? 0 : Math.ceil(cost),
                allowed: true,
                latency_ms: Math.round(handlerMs),
                status_code: res.statusCode,
                reason: failOpen ? 'fail_open' : (res.locals.rlReason ?? null),
                handler_ms: handlerMs,
            })
        })

        const store = {
            reqId: nextReqId++,
            apiKey,
            endpointId,
            cost,
            tier: tier ? { cap: tier.cap, ratePerMs: tier.ratePerMs } : null,
            policy: config.RL_POLICY,
            t0,
            tAdmit,
        }
        als.run(store, next)
    }
}
