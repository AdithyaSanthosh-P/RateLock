import { config } from './src/config.js'
import { redis } from './src/db/redis.js'
import { sysPool, appPgPool } from './src/db/postgres.js'
import { currentCtx } from './src/context.js'
import { createApp } from './src/app.js'
import { ContentionPool } from './src/pool/contentionPool.js'
import { logWriter } from './src/services/logWriter.js'
import { makeBaselines } from './src/services/baselines.js'
import { makeSettlement } from './src/services/settlement.js'
import { loadEndpointCosts, startCostCalibrator } from './src/services/costCalibrator.js'

async function main() {
    await loadEndpointCosts()
    if (config.RL_POLICY === 'own_usage') startCostCalibrator()

    const baselines = makeBaselines({ sysPool })
    await baselines.start()
    const settlement = makeSettlement({ redis, config })

    // Every request handler gets its database connections through this pool, so every hold is measured
    // under every policy (decision D12).
    const contentionPool = new ContentionPool({
        pgPool: appPgPool,
        size: config.APP_POOL_SIZE,
        policy: config.RL_POLICY,
        gamma: config.RL_GAMMA,
        acquireTimeoutMs: config.ACQUIRE_TIMEOUT_MS,
        getContext: currentCtx,
        getBaselineMs: baselines.getBaselineMs,
        onSettle: settlement.onSettle,
        onHold: hold => logWriter.logHold({
            run_id: config.RL_RUN_ID,
            policy: config.RL_POLICY,
            api_key: hold.apiKey,
            endpoint: hold.endpointId,
            acquired_at: new Date(hold.acquiredAt).toISOString(),
            hold_ms: hold.holdMs,
            wait_ms: hold.waitMs,
            imposed_ms: hold.imposedMs,
            overstay_ms: hold.overstayMs,
            baseline_ms: hold.baselineMs,
            // nominal amounts (before the bucket and debt caps in settle.lua)
            debit_tokens: settlement.debitTokens(hold.imposedMs),
            credit_tokens: settlement.creditTokens(hold.waitMs, hold.admittedCost),
        }),
    })

    const app = createApp({ db: contentionPool, getPoolStats: () => contentionPool.stats() })
    const server = app.listen(config.PORT, () => {
        console.log(`RateLock on http://localhost:${config.PORT} (policy=${config.RL_POLICY}, run=${config.RL_RUN_ID}, pool=${config.APP_POOL_SIZE})`)
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
