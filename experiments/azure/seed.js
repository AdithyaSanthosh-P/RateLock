// Seeds the Azure replay (D26, D27): one key and one tier per trace app, one endpoint_costs row per replay endpoint.
// Run after experiments/azure/prepare.py.
// Usage: node experiments/azure/seed.js   (idempotent; reuses out/keys.json)
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sysPool } from '../../src/db/postgres.js'

const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const KEYS_FILE = OUT + 'keys.json'

async function main() {
    const { n_apps, tiers } = JSON.parse(fs.readFileSync(OUT + 'apps.json', 'utf8'))
    const endpoints = JSON.parse(fs.readFileSync(OUT + 'endpoints.json', 'utf8'))

    let keys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : []
    while (keys.length < n_apps) keys.push(randomBytes(16).toString('hex'))
    keys = keys.slice(0, n_apps)
    // One tier per app, sized to that app's own traffic (D27): a tenant running near its plan.
    for (const t of tiers) {
        const tier = await sysPool.query(
            `INSERT INTO tiers (name, tokens_per_hour, burst) VALUES ($1, $2, $3)
             ON CONFLICT (name) DO UPDATE SET tokens_per_hour = EXCLUDED.tokens_per_hour, burst = EXCLUDED.burst RETURNING id`,
            [`azure_app_${t.app}`, t.tokens_per_hour, t.burst]
        )
        await sysPool.query(
            `INSERT INTO users (username, api_key, tier_id) VALUES ($1, $2, $3)
             ON CONFLICT (username) DO UPDATE SET api_key = EXCLUDED.api_key, tier_id = EXCLUDED.tier_id`,
            [`azure_app_${t.app}`, keys[t.app], tier.rows[0].id]
        )
    }

    // Static baseline = 14-day p95 of the function, scaled by k (prepare.py). Cost 1, like the demo routes.
    for (const e of endpoints) {
        await sysPool.query(
            `INSERT INTO endpoint_costs (endpoint, base_token_cost, token_cost, expected_latency_ms, static_hold_ms)
             VALUES ($1, 1, 1, $2, $3)
             ON CONFLICT (endpoint) DO UPDATE SET expected_latency_ms = EXCLUDED.expected_latency_ms,
                                                  static_hold_ms = EXCLUDED.static_hold_ms`,
            [e.endpointId, e.baseline_ms, e.baseline_ms]   // $2 float column, $3 numeric column
        )
    }

    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n')
    console.log(`seeded ${keys.length} azure keys and ${endpoints.length} replay endpoints`)
}

main().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => sysPool.end())
