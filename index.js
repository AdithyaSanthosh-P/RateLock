import express from 'express'
import Redis from 'ioredis'
import pkg from 'pg'

const { Pool } = pkg

const pool = new Pool({
    user: 'ratelock',
    password: 'ratelock123',
    host: 'localhost',
    port: 54321,
    database: 'ratelock'
})

// Create a Redis instance.
// By default, it will connect to :6379.

const redis = new Redis();
const app = express()

redis.defineCommand("checkAndDecrementTokens", {
    numberOfKeys: 1,
    lua: `
        local tokens = redis.call('GET', KEYS[1])
        if tonumber(tokens) >= tonumber(ARGV[1]) then
        redis.call('DECRBY', KEYS[1], ARGV[1])
        return 1
        else
        return 0
        end
    `
});

app.use(async (req, res, next) => {
    //hardcoded users and endpoints
    const apiKey = req.headers["user-api-key"];
    const endpoint = "endpoint-a";

    //change: using api key instead of user id to avoid the postgres speed bottleneck

    const key = `ratelock:tokens:${apiKey}:${endpoint}`
    const cost = parseInt(await redis.get(`ratelock:endpoint_cost:${endpoint}`)) || 1;

    try {
        const exists = await redis.exists(key);
        const startTime = Date.now();
        //deal with unknown api keys
        if (!exists) {
            const result = await pool.query(
                'SELECT tiers.tokens_per_hour FROM users JOIN tiers ON users.tier_id = tiers.id WHERE users.api_key=$1',
                [apiKey]
            );
            if (result.rowCount === 0) {
                return res.status(401).send('Invalid API key');
            }
            const { tokens_per_hour } = result.rows[0];
            await redis.set(key, tokens_per_hour, 'EX', 3600);
        }

        const allowed = await redis.checkAndDecrementTokens(key, cost);

        if (allowed) {
            // let log usage run in background in single round trip 
            res.on('finish', () => {
                const latency_ms = Date.now() - startTime;
                pool.query(
                    'INSERT INTO usage_logs (user_id, endpoint, tokens_deducted, allowed, latency_ms) SELECT id, $2, $3, $4, $5 FROM users WHERE api_key = $1',
                    [apiKey, endpoint, cost, true, latency_ms]
                ).catch(err => console.error('Log failed:', err));
            });
            next();
        } else {
            return res.status(429).send('Token limit reached');
        }

    } catch (err) {
        console.error(err);
        res.status(500).send("Server error");
    }
})


app.get('/', (req, res) => {
    res.send("Random : " + Math.random() * 100);
})

async function main() {
    await loadEndpointCosts()
    startCostCalibrator()
    app.listen(3000, () => {
        console.log('Server is running on http://localhost:3000')
    })
}

main().catch(err => {
    console.error('Startup failed:', err)
    process.exit(1)
})

async function loadEndpointCosts() {
    const result = await pool.query('SELECT endpoint, token_cost FROM endpoint_costs')
    for (const row of result.rows) {
        await redis.set(`ratelock:endpoint_cost:${row.endpoint}`, row.token_cost)
    }
    console.log(`Loaded ${result.rowCount} endpoint cost(s) into Redis`)
}

function startCostCalibrator() {
    setInterval(async () => {
        try {
            const result = await pool.query(`
                SELECT ul.endpoint,
                       AVG(ul.latency_ms) as avg_latency,
                       COUNT(*) as sample_count,
                       ec.base_token_cost,
                       ec.expected_latency_ms
                FROM usage_logs ul
                JOIN endpoint_costs ec ON ul.endpoint = ec.endpoint
                WHERE ul.timestamp > NOW() - INTERVAL '5 minutes'
                AND ul.latency_ms IS NOT NULL
                GROUP BY ul.endpoint, ec.base_token_cost, ec.expected_latency_ms
                HAVING COUNT(*) >= 5
            `)

            for (const row of result.rows) {
                const deviation = (row.avg_latency - row.expected_latency_ms) / row.expected_latency_ms
                const newCost = Math.max(1, Math.ceil(row.base_token_cost * (1 + deviation)))

                await pool.query(
                    `UPDATE endpoint_costs
                     SET token_cost = $2, avg_latency_ms = $3, sample_count = $4, updated_at = NOW()
                     WHERE endpoint = $1`,
                    [row.endpoint, newCost, parseFloat(row.avg_latency), parseInt(row.sample_count)]
                )

                await redis.set(`ratelock:endpoint_cost:${row.endpoint}`, newCost)
                console.log(`Cost calibrator: ${row.endpoint} → ${newCost} token(s)  (avg ${Math.round(row.avg_latency)}ms vs expected ${row.expected_latency_ms}ms, ${deviation >= 0 ? '+' : ''}${Math.round(deviation * 100)}% deviation)`)
            }

        } catch (err) {
            console.error('Cost calibrator failed:', err)
        }
    }, 15 * 1000)
}
