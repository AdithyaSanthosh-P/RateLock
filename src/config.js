// Central configuration. Reads env vars (and .env), validates them, exports one frozen object.
// Names and defaults come from docs/plan/contracts.md section 1.
import 'dotenv/config'

const POLICIES = ['plain', 'own_usage', 'conex', 'holder_whole', 'holder_overstay']

function str(name, def) {
    const v = process.env[name]
    return v === undefined || v === '' ? def : v
}

function num(name, def, { min = -Infinity, int = false } = {}) {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return def
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`Config: ${name}="${raw}" is not a number`)
    if (int && !Number.isInteger(n)) throw new Error(`Config: ${name}="${raw}" must be an integer`)
    if (n < min) throw new Error(`Config: ${name}=${n} must be >= ${min}`)
    return n
}

function oneOf(name, def, allowed) {
    const v = str(name, def)
    if (!allowed.includes(v)) throw new Error(`Config: ${name}="${v}" must be one of ${allowed.join(' | ')}`)
    return v
}

function bool(name, def) {
    return oneOf(name, String(def), ['true', 'false']) === 'true'
}

export const config = Object.freeze({
    PORT: num('PORT', 3000, { min: 1, int: true }),

    PG_HOST: str('PG_HOST', 'localhost'),
    PG_PORT: num('PG_PORT', 54321, { min: 1, int: true }),
    PG_USER: str('PG_USER', 'ratelock'),
    PG_PASSWORD: str('PG_PASSWORD', 'ratelock123'),
    PG_DATABASE: str('PG_DATABASE', 'ratelock'),
    REDIS_URL: str('REDIS_URL', 'redis://localhost:6379'),

    APP_POOL_SIZE: num('APP_POOL_SIZE', 10, { min: 1, int: true }),
    SYS_POOL_SIZE: num('SYS_POOL_SIZE', 4, { min: 1, int: true }),
    ACQUIRE_TIMEOUT_MS: num('ACQUIRE_TIMEOUT_MS', 10000, { min: 1 }),

    RL_POLICY: oneOf('RL_POLICY', 'holder_overstay', POLICIES),
    RL_ALPHA: num('RL_ALPHA', 1, { min: 0 }),
    RL_BETA: num('RL_BETA', 1, { min: 0 }),
    RL_HOLD_DEBIT_CAP: num('RL_HOLD_DEBIT_CAP', 20, { min: 0 }),
    RL_DEBT_CAP: num('RL_DEBT_CAP', 50, { min: 0 }),
    RL_DEBT_DECAY_PER_SEC: num('RL_DEBT_DECAY_PER_SEC', 0.5, { min: 0 }),
    RL_GAMMA: num('RL_GAMMA', 1.2, { min: 0 }),
    RL_BASELINE_WINDOW_SEC: num('RL_BASELINE_WINDOW_SEC', 300, { min: 1 }),
    RL_BASELINE_MIN_HOLDS: num('RL_BASELINE_MIN_HOLDS', 20, { min: 1, int: true }),
    RL_BASELINE_MIN_KEYS: num('RL_BASELINE_MIN_KEYS', 3, { min: 1, int: true }),
    RL_BASELINE_REFRESH_MS: num('RL_BASELINE_REFRESH_MS', 2000, { min: 100 }),
    RL_LOAD_MULTIPLIER: oneOf('RL_LOAD_MULTIPLIER', 'off', ['on', 'off']),
    RL_FAIL_OPEN: bool('RL_FAIL_OPEN', true),
    RL_BUCKET_IDLE_TTL_SEC: num('RL_BUCKET_IDLE_TTL_SEC', 7200, { min: 1 }),
    RL_TIER_CACHE_TTL_SEC: num('RL_TIER_CACHE_TTL_SEC', 300, { min: 1 }),
    RL_CALIBRATOR_INTERVAL_SEC: num('RL_CALIBRATOR_INTERVAL_SEC', 15, { min: 1 }),
    RL_RUN_ID: str('RL_RUN_ID', 'dev'),
    LOG_BATCH_MS: num('LOG_BATCH_MS', 500, { min: 10 }),

    // contracts.md says "required"; a dev default keeps `npm run dev` and the acceptance checks simple.
    ADMIN_TOKEN: str('ADMIN_TOKEN', 'dev-admin-token'),
})
