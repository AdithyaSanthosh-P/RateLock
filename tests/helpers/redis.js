// Shared helpers for Lua tests. They run against the docker Redis; every key starts with "test:".
import { randomUUID } from 'node:crypto'
import { redis } from '../../src/db/redis.js'

export { redis }

// A fresh pair of keys per test, so tests never see each other's state.
export function testKeys() {
    const id = randomUUID().slice(0, 8)
    return { bucket: `test:{${id}}:b:e`, debt: `test:{${id}}:debt`, tier: `test:{${id}}:tier` }
}

export async function cleanup(...keys) {
    if (keys.length) await redis.del(...keys)
}

export async function nowMs() {
    const [s, us] = await redis.time()
    return Number(s) * 1000 + Math.floor(Number(us) / 1000)
}

// Calls admit and turns the reply into an object.
export async function admit(keys, { cap = 10, rate = 0, cost = 1, ttl = 60000, decay = 0 } = {}) {
    const r = await redis.admit(keys.bucket, keys.debt, cap, rate, cost, ttl, decay)
    return {
        allowed: r[0] === 1,
        remaining: parseFloat(r[1]),
        retryMs: parseFloat(r[2]),
        reason: r[3],
        debt: parseFloat(r[4]),
    }
}
