// Per-request context carried across awaits (decision D5). rateLock() starts it after admission;
// ContentionPool.acquire() reads it to learn who is asking for a connection.
//
// store shape: { reqId, apiKey, endpointId, cost, tier: { cap, ratePerMs }, policy, t0, tAdmit }
import { AsyncLocalStorage } from 'node:async_hooks'

export const als = new AsyncLocalStorage()

export function currentCtx() {
    return als.getStore() ?? null
}
