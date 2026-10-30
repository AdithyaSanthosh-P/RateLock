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

// Cache-aside tier lookup: check Redis first, fall back to Postgres
async function loadTier(apiKey) {
    // Note: curly braces {apiKey} make Redis hash only this part, keeping all keys for this user on the same shard
    const tierKey = `ratelock:{${apiKey}}:tier`
    const cached = await redis.hgetall(tierKey)
    if (cached.cap) {
        return { cap: Number(cached.cap), ratePerMs: Number(cached.rate_per_ms), tier: cached.tier }
    }
    // Cache miss: query Postgres via sysPool (use sysPool so we don't steal connections from our 10-slot appPool!)
    const result = await sysPool.query(TIER_SQL, [apiKey])
    if (result.rowCount === 0) return null
    const { name, tokens_per_hour, burst } = result.rows[0]
    const tier = {
        cap: burst ?? tokens_per_hour,
        ratePerMs: tokens_per_hour / 3_600_000, // Precompute tokens/ms so admit.lua doesn't have to do division
        tier: name,
    }
    // Save to Redis with 5 min TTL so future requests are fast cache hits
    // are we resetting every 5 mins from redis
    await redis.multi()
        .hset(tierKey, { cap: tier.cap, rate_per_ms: tier.ratePerMs, tier: tier.tier })
        .expire(tierKey, config.RL_TIER_CACHE_TTL_SEC)
        .exec()
    return tier
}

//tf is this
function ns(from) {
    return Number(process.hrtime.bigint() - from)
}

export function rateLock(endpointId) {
    return async (req, res, next) => {
        // Start timer to measure pure rate-limiting overhead (middleware entry to decision)
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

            // Get dynamic cost if calibrator is active (own_usage), otherwise default to 1 token
            // each endpoint has its own cost
            cost = parseFloat(await redis.get(`ratelock:cost:${endpointId}`)) || 1

            // Call Lua script atomically:
            // 1. Refills bucket based on elapsed time
            // 2. Decays user's contention debt
            // 3. Checks if (tokens - debt >= cost)
            // Note: Bucket is per (user, endpoint), but debt is global per user (can't switch routes to dodge debt!)
            const r = await redis.admit(
                `ratelock:{${apiKey}}:b:${endpointId}`,
                `ratelock:{${apiKey}}:debt`,
                tier.cap, tier.ratePerMs, cost, idleTtlMs, debtDecayPerMs
            )
            decision = { allowed: r[0] === 1, retryMs: parseFloat(r[2]), reason: r[3], debt: parseFloat(r[4]) }             //learn this
        } catch (err) {
            console.error('Admission error:', err.message)
            // Fail open: if Redis is down, let the request pass instead of taking down the whole API
            if (!config.RL_FAIL_OPEN) return res.status(503).json({ error: 'limiter_unavailable' })
            failOpen = true
            decision = { allowed: true, retryMs: 0, reason: 'fail_open', debt: 0 }
        }

        const tAdmit = process.hrtime.bigint()
        const overheadUs = Math.round(ns(t0) / 1000) // Pure limiter overhead in microseconds

        const baseRow = {
            api_key: apiKey,
            endpoint: endpointId,
            cost,
            debt_at_admit: decision.debt,
            policy: config.RL_POLICY,
            run_id: config.RL_RUN_ID,
            overhead_us: overheadUs,
        }

        // Tell client if they have active contention debt slowing them down
        if (decision.debt > 0) res.set('RateLock-Debt', decision.debt.toFixed(3))

        // --- IF REJECTED (429) ---
        if (!decision.allowed) {
            res.set('Retry-After', String(Math.ceil(decision.retryMs / 1000)))
            if (decision.reason === 'contention_debt') {
                // Explainability: tell the user they got throttled because of past connection hogging
                res.set('RateLock-Reason', `contention-debit; amount=${decision.debt.toFixed(3)}`)
            }
            res.status(429).json({ error: 'rate_limited', reason: decision.reason, retry_after_ms: decision.retryMs })
            // Log denied request immediately (handler didn't run, so handler_ms = 0)
            logWriter.logRequest({
                ...baseRow, tokens: 0, allowed: false, latency_ms: 0, status_code: 429,
                reason: decision.reason, handler_ms: 0,
            })
            return // Stop here, don't execute route handler!
        }

        // --- IF ADMITTED ---
        // Wait for response to finish, then log actual route handler execution time
        res.once('finish', () => {
            const handlerMs = ns(tAdmit) / 1e6 // Time spent in actual route handler / DB queries
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

        // Put request info into AsyncLocalStorage:
        // This lets ContentionPool know which API key is borrowing a DB connection without passing it in function arguments!
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
