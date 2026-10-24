// Cost Calibrator: the "own usage" cost policy. Every tick it compares each endpoint's recent average
// handler time with its expected latency and sets token_cost = max(1, ceil(base * (1 + deviation))).
// Only started when RL_POLICY=own_usage; the other policies keep the base cost.
import { config } from '../config.js'
import { redis } from '../db/redis.js'
import { sysPool } from '../db/postgres.js'

export async function loadEndpointCosts() {
    const result = await sysPool.query('SELECT endpoint, token_cost FROM endpoint_costs')
    for (const row of result.rows) {
        await redis.set(`ratelock:cost:${row.endpoint}`, row.token_cost)
    }
    console.log(`Loaded ${result.rowCount} endpoint cost(s) into Redis`)
}

async function tick() {
    const result = await sysPool.query(`
        SELECT ul.endpoint,
               AVG(ul.handler_ms) AS avg_latency,
               COUNT(*) AS sample_count,
               ec.base_token_cost,
               ec.expected_latency_ms
        FROM usage_logs ul
        JOIN endpoint_costs ec ON ul.endpoint = ec.endpoint
        WHERE ul.timestamp > NOW() - INTERVAL '5 minutes'
          AND ul.allowed
          AND ul.handler_ms IS NOT NULL
          AND ul.run_id = $1
        GROUP BY ul.endpoint, ec.base_token_cost, ec.expected_latency_ms
        HAVING COUNT(*) >= 5
    `, [config.RL_RUN_ID])

    for (const row of result.rows) {
        const avg = parseFloat(row.avg_latency)
        const deviation = (avg - row.expected_latency_ms) / row.expected_latency_ms
        const newCost = Math.max(1, Math.ceil(row.base_token_cost * (1 + deviation)))

        await sysPool.query(
            `UPDATE endpoint_costs
             SET token_cost = $2, avg_latency_ms = $3, sample_count = $4, updated_at = NOW()
             WHERE endpoint = $1`,
            [row.endpoint, newCost, avg, parseInt(row.sample_count)]
        )
        await redis.set(`ratelock:cost:${row.endpoint}`, newCost)
        console.log(`Cost calibrator: ${row.endpoint} -> ${newCost} token(s) (avg ${Math.round(avg)}ms vs expected ${row.expected_latency_ms}ms)`)
    }
}

export function startCostCalibrator() {
    const timer = setInterval(async () => {
        try {
            await tick()
        } catch (err) {
            console.error('Cost calibrator failed:', err.message)
        }
    }, config.RL_CALIBRATOR_INTERVAL_SEC * 1000)
    timer.unref()
    return () => clearInterval(timer)
}
