// Seeds the experiment tier ("exp") and keys. Idempotent: re-running reuses experiments/keys.json.
// Usage: node experiments/seed.js
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sysPool } from '../src/db/postgres.js'

const KEYS_FILE = fileURLToPath(new URL('./keys.json', import.meta.url))
const N_EXP_KEYS = 30   // 1 culprit + 1 dominant + 20 victims + 8 spare

const newKey = () => randomBytes(16).toString('hex')   // same 32-hex format as data generation/initialise.py

async function ensureUser(username, apiKey, tierId) {
    await sysPool.query(
        `INSERT INTO users (username, api_key, tier_id) VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET api_key = EXCLUDED.api_key, tier_id = EXCLUDED.tier_id`,
        [username, apiKey, tierId]
    )
}

async function main() {
    // 36000 tokens/hour = 10/s, burst 20.
    const tier = await sysPool.query(
        `INSERT INTO tiers (name, tokens_per_hour, burst) VALUES ('exp', 36000, 20)
         ON CONFLICT (name) DO UPDATE SET tokens_per_hour = 36000, burst = 20 RETURNING id`
    )
    const expTier = tier.rows[0].id
    const premium = await sysPool.query(`SELECT id FROM tiers WHERE name = 'premium'`)

    let keys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : null
    if (!keys) {
        const all = Array.from({ length: N_EXP_KEYS }, newKey)
        keys = {
            culprit: [all[0]],
            dominant: [all[1]],
            victims: all.slice(2, 22),
            spare: all.slice(22),
            premium: [newKey()],
        }
    }

    const expKeys = [...keys.culprit, ...keys.dominant, ...keys.victims, ...keys.spare]
    for (let i = 0; i < expKeys.length; i++) await ensureUser(`exp_${i}`, expKeys[i], expTier)
    if (premium.rowCount) await ensureUser('exp_premium', keys.premium[0], premium.rows[0].id)

    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n')
    console.log(`seeded ${expKeys.length} exp keys (+1 premium) -> ${KEYS_FILE}`)
}

main().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => sysPool.end())
