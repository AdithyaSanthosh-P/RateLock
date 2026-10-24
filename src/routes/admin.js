// Admin routes, protected by the x-admin-token header.
import express from 'express'
import { config } from '../config.js'
import { redis } from '../db/redis.js'

export function makeAdminRouter({ getPoolStats = () => null } = {}) {
    const router = express.Router()

    router.use((req, res, next) => {
        if (req.headers['x-admin-token'] !== config.ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' })
        next()
    })

    // Fault injection: extra DB latency on every demo call (workload f / manual demos).
    router.post('/inject', express.json(), async (req, res) => {
        const n = Number(req.body?.dbdelay_ms)
        const ms = Number.isFinite(n) ? Math.min(5000, Math.max(0, Math.round(n))) : 0
        await redis.set('ratelock:inject:dbdelay_ms', ms)
        res.json({ dbdelay_ms: ms })
    })

    router.get('/stats', async (req, res) => {
        res.json({
            policy: config.RL_POLICY,
            runId: config.RL_RUN_ID,
            pool: getPoolStats(),
            loadflag: await redis.get('ratelock:loadflag'),
        })
    })

    return router
}
