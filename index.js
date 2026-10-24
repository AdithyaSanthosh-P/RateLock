import { config } from './src/config.js'
import { redis } from './src/db/redis.js'
import { sysPool, appPgPool } from './src/db/postgres.js'
import { createApp } from './src/app.js'
import { logWriter } from './src/services/logWriter.js'
import { loadEndpointCosts, startCostCalibrator } from './src/services/costCalibrator.js'

// Until P3.3, demo routes use sysPool directly through the same { query, withClient } interface
// that ContentionPool will provide.
const db = {
    query: (text, params) => sysPool.query(text, params),
    async withClient(fn) {
        const client = await sysPool.connect()
        try { return await fn(client) } finally { client.release() }
    },
}

async function main() {
    await loadEndpointCosts()
    if (config.RL_POLICY === 'own_usage') startCostCalibrator()

    const app = createApp({ db, getPoolStats: () => null })
    const server = app.listen(config.PORT, () => {
        console.log(`RateLock on http://localhost:${config.PORT} (policy=${config.RL_POLICY}, run=${config.RL_RUN_ID})`)
    })

    // Flush buffered logs before exiting, so experiment runs lose nothing.
    async function shutdown() {
        server.close()
        await logWriter.stop()
        await Promise.allSettled([sysPool.end(), appPgPool.end(), redis.quit()])
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

main().catch(err => {
    console.error('Startup failed:', err)
    process.exit(1)
})
