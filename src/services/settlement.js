// Settlement: turns the pool's events (milliseconds of imposed waiting) into token debits and credits
// and sends them to Redis through settle.lua. Decision D8: fire-and-forget; a Redis failure is logged and
// counted, never thrown into the request path, and nothing here ever delays a request holding a connection.
//
//   holder debit   = min(RL_HOLD_DEBIT_CAP, alpha * imposedMs / 1000)           (holder_*, conex)
//   waiter credit  = min(admittedCost, beta * waitedMs / 1000)                  (holder_* only)
//   conex waiter   = min(RL_HOLD_DEBIT_CAP, alpha * chargeMs / 1000), as a debit (conex only)

const HOLDER_PAYS = new Set(['holder_whole', 'holder_overstay', 'conex'])
const WAITER_CREDITED = new Set(['holder_whole', 'holder_overstay'])

export function makeSettlement({ redis, config, logger = console }) {
    const holderPays = HOLDER_PAYS.has(config.RL_POLICY)
    const waiterCredited = WAITER_CREDITED.has(config.RL_POLICY)
    const waiterPays = config.RL_POLICY === 'conex'

    const idleTtlMs = config.RL_BUCKET_IDLE_TTL_SEC * 1000
    const decayPerMs = config.RL_DEBT_DECAY_PER_SEC / 1000

    const stats = { calls: 0, errors: 0, debitTokens: 0, creditTokens: 0 }

    // Pure conversions, also used to fill the debit/credit columns of pool_holds.
    const debitTokens = imposedMs =>
        holderPays ? Math.min(config.RL_HOLD_DEBIT_CAP, config.RL_ALPHA * imposedMs / 1000) : 0
    const creditTokens = (waitedMs, admittedCost) =>
        waiterCredited ? Math.min(admittedCost, config.RL_BETA * waitedMs / 1000) : 0
    const chargeTokens = chargeMs =>
        waiterPays ? Math.min(config.RL_HOLD_DEBIT_CAP, config.RL_ALPHA * chargeMs / 1000) : 0

    const debtKey = apiKey => `ratelock:{${apiKey}}:debt`
    const bucketKey = w => `ratelock:{${w.apiKey}}:b:${w.endpointId}`

    // One settle.lua call. Empty key = skip that half. Errors never escape.
    function send(holderDebtKey, debit, waiterBucketKey, credit, tier) {
        stats.calls++
        stats.debitTokens += debit
        stats.creditTokens += credit
        redis
            .settle(
                holderDebtKey, waiterBucketKey,
                debit, config.RL_DEBT_CAP, decayPerMs,
                credit, tier?.cap ?? 0, tier?.ratePerMs ?? 0, idleTtlMs
            )
            .catch(err => {
                stats.errors++
                logger.error('settle failed:', err.message)
            })
    }

    // Credit and (for conex) charge for a waiter that got the slot or gave up.
    function settleWaiter(w, holderDebit, holderApiKey) {
        const credit = w && w.tier ? creditTokens(w.waitedMs, w.admittedCost) : 0
        const holderKey = holderDebit > 0 ? debtKey(holderApiKey) : ''
        if (holderKey || credit > 0) {
            send(holderKey, holderDebit, credit > 0 ? bucketKey(w) : '', credit, w?.tier)
        }
        const charge = w ? chargeTokens(w.chargeMs) : 0
        if (charge > 0) send(debtKey(w.apiKey), charge, '', 0, null)
    }

    function onSettle(event) {
        try {
            if (event.kind === 'release') {
                const { holder, grantedWaiter } = event
                const debit = debitTokens(holder.imposedMs)
                if (grantedWaiter) {
                    settleWaiter(grantedWaiter, debit, holder.apiKey)
                } else if (debit > 0) {
                    send(debtKey(holder.apiKey), debit, '', 0, null)
                }
            } else if (event.kind === 'timeout') {
                settleWaiter(event.waiter, 0, null)
            }
        } catch (err) {
            stats.errors++
            logger.error('settlement failed:', err.message)
        }
    }

    return { onSettle, stats: () => ({ ...stats }), debitTokens, creditTokens }
}
