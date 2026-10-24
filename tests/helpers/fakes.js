// Fakes for ContentionPool tests: a clock you move by hand, a pg pool that connects instantly,
// and a context you switch before each acquire(). All times are in ms.
import { ContentionPool } from '../../src/pool/contentionPool.js'

// setImmediate lets promise continuations (the `await pgPool.connect()` inside acquire) run.
export const tick = () => new Promise(resolve => setImmediate(resolve))

export function makeFakePgPool({ clientReleaseThrows = false } = {}) {
    return {
        async connect() {
            return {
                query: async () => ({ rows: [] }),
                release: () => { if (clientReleaseThrows) throw new Error('client.release failed') },
            }
        },
    }
}

export function makeEnv({
    size = 1, policy = 'holder_whole', gamma = 1, baselines = {}, acquireTimeoutMs = 10000, pgPool = makeFakePgPool(),
} = {}) {
    const env = {
        now: 0,
        ctx: null,           // what getContext returns; set with as()
        holds: [],           // onHold records
        settles: [],         // onSettle events
    }
    env.pool = new ContentionPool({
        pgPool,
        size,
        policy,
        gamma,
        acquireTimeoutMs,
        clock: () => env.now,
        getContext: () => env.ctx,
        getBaselineMs: endpointId => baselines[endpointId] ?? 0,
        onSettle: e => env.settles.push(e),
        onHold: h => env.holds.push(h),
        logger: { warn() {}, error() {}, log() {} },
    })

    // Starts an acquire for `apiKey` at time `t` and returns the promise.
    env.as = (apiKey, endpointId = 'e') => {
        env.ctx = { apiKey, endpointId, cost: 1, tier: { cap: 20, ratePerMs: 0.01 } }
    }
    env.acquire = (apiKey, t, endpointId = 'e') => {
        env.now = t
        env.as(apiKey, endpointId)
        return env.pool.acquire()
    }
    env.release = (holdId, t, err) => {
        env.now = t
        env.pool.release(holdId, err)
    }
    env.holdFor = apiKey => env.holds.find(h => h.apiKey === apiKey)
    return env
}
