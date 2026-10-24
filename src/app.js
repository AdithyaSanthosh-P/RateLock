import express from 'express'
import { buildRegistry } from './routes/registry.js'
import { makeAdminRouter } from './routes/admin.js'
import { rateLock } from './middleware/rateLock.js'

// db: { query, withClient } used by the demo routes. getPoolStats feeds /admin/stats.
export function createApp({ db, getPoolStats }) {
    const app = express()

    app.get('/health', (req, res) => res.json({ ok: true }))
    app.use('/admin', makeAdminRouter({ getPoolStats }))

    for (const r of buildRegistry(db)) {
        app[r.method](r.path, rateLock(r.endpointId), r.handler)
    }

    // Express 5 forwards async errors here.
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err)
        if (err?.name === 'AcquireTimeoutError') {
            res.locals.rlReason = 'acquire_timeout'
            return res.status(503).json({ error: 'pool_acquire_timeout' })
        }
        console.error(err)
        res.status(500).json({ error: 'server_error' })
    })

    return app
}
