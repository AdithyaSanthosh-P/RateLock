import fs from 'node:fs'
import Redis from 'ioredis'
import { config } from '../config.js'

export const redis = new Redis(config.REDIS_URL)

const luaDir = new URL('../lua/', import.meta.url)

function lua(name) {
    return fs.readFileSync(new URL(name, luaDir), 'utf8')
}

// admit(bucketKey, debtKey, cap, ratePerMs, cost, idleTtlMs, debtDecayPerMs)
redis.defineCommand('admit', { numberOfKeys: 2, lua: lua('admit.lua') })

// settle.lua is added in phase 4 (P4.2).
if (fs.existsSync(new URL('settle.lua', luaDir))) {
    // settle(holderDebtKey, waiterBucketKey, debit, debtCap, debtDecayPerMs, credit, waiterCap, waiterRatePerMs, idleTtlMs)
    redis.defineCommand('settle', { numberOfKeys: 2, lua: lua('settle.lua') })
}
