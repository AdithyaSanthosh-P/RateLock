// Settlement service: unit conversion and policy switches, against a fake redis that records settle() calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSettlement } from '../src/services/settlement.js'

const baseConfig = {
    RL_POLICY: 'holder_overstay', RL_ALPHA: 1, RL_BETA: 1, RL_HOLD_DEBIT_CAP: 20, RL_DEBT_CAP: 50,
    RL_DEBT_DECAY_PER_SEC: 0.5, RL_BUCKET_IDLE_TTL_SEC: 7200,
}

function setup(overrides = {}, redisImpl) {
    const calls = []
    const redis = {
        settle: redisImpl ?? (async (...args) => { calls.push(args); return ['0', '0'] }),
    }
    const settlement = makeSettlement({ redis, config: { ...baseConfig, ...overrides }, logger: { error() {} } })
    return { settlement, calls }
}

const waiter = (extra = {}) => ({
    apiKey: 'W', endpointId: 'demo.cheap', waitedMs: 500, chargeMs: 0, admittedCost: 1,
    tier: { cap: 20, ratePerMs: 0.01 }, ...extra,
})
const release = (imposedMs, grantedWaiter) => ({
    kind: 'release',
    holder: { apiKey: 'H', endpointId: 'demo.txn', imposedMs, overstayMs: 0, holdMs: 0 },
    grantedWaiter,
})

test('holder_overstay: debits the holder and credits the waiter in one call', () => {
    const { settlement, calls } = setup()
    settlement.onSettle(release(2000, waiter()))
    assert.equal(calls.length, 1)
    const [debtKey, bucketKey, debit, debtCap, , credit, cap, rate] = calls[0]
    assert.equal(debtKey, 'ratelock:{H}:debt')
    assert.equal(bucketKey, 'ratelock:{W}:b:demo.cheap')
    assert.equal(debit, 2)          // alpha * 2 s
    assert.equal(debtCap, 50)
    assert.equal(credit, 0.5)       // beta * 0.5 s
    assert.equal(cap, 20)
    assert.equal(rate, 0.01)
})

test('debit is capped at RL_HOLD_DEBIT_CAP', () => {
    const { settlement, calls } = setup()
    settlement.onSettle(release(100000, null))
    assert.equal(calls[0][2], 20)
})

test('credit never exceeds the admitted cost', () => {
    const { settlement, calls } = setup()
    settlement.onSettle(release(0, waiter({ waitedMs: 5000 })))
    assert.equal(calls[0][5], 1)
})

test('plain and own_usage settle nothing', () => {
    for (const RL_POLICY of ['plain', 'own_usage']) {
        const { settlement, calls } = setup({ RL_POLICY })
        settlement.onSettle(release(5000, waiter()))
        settlement.onSettle({ kind: 'timeout', waiter: waiter() })
        assert.equal(calls.length, 0, RL_POLICY)
    }
})

test('beta = 0 turns victim credit off but keeps the debit', () => {
    const { settlement, calls } = setup({ RL_BETA: 0 })
    settlement.onSettle(release(2000, waiter()))
    assert.equal(calls.length, 1)
    assert.equal(calls[0][2], 2)    // debit
    assert.equal(calls[0][1], '')   // no waiter bucket
    assert.equal(calls[0][5], 0)    // no credit
})

test('conex: holder debit, and the waiter is charged on its own debt key, never credited', () => {
    const { settlement, calls } = setup({ RL_POLICY: 'conex' })
    settlement.onSettle(release(1000, waiter({ chargeMs: 1000 })))
    assert.equal(calls.length, 2)
    assert.deepEqual([calls[0][0], calls[0][1], calls[0][2], calls[0][5]], ['ratelock:{H}:debt', '', 1, 0])
    assert.deepEqual([calls[1][0], calls[1][1], calls[1][2]], ['ratelock:{W}:debt', '', 1])
})

test('timeout: the waiter is still credited for the time it waited', () => {
    const { settlement, calls } = setup()
    settlement.onSettle({ kind: 'timeout', waiter: waiter({ waitedMs: 400 }) })
    assert.equal(calls.length, 1)
    assert.deepEqual([calls[0][0], calls[0][1], calls[0][2], calls[0][5]], ['', 'ratelock:{W}:b:demo.cheap', 0, 0.4])
})

test('a waiter without a tier gets no credit', () => {
    const { settlement, calls } = setup()
    settlement.onSettle(release(0, waiter({ tier: null })))
    assert.equal(calls.length, 0)
})

test('a redis failure is counted, never thrown', async () => {
    const { settlement } = setup({}, async () => { throw new Error('redis down') })
    assert.doesNotThrow(() => settlement.onSettle(release(2000, null)))
    await new Promise(r => setImmediate(r))
    assert.equal(settlement.stats().errors, 1)
})

test('the pure conversions match what the events use', () => {
    const { settlement } = setup()
    assert.equal(settlement.debitTokens(3000), 3)
    assert.equal(settlement.creditTokens(300, 1), 0.3)
    const plain = setup({ RL_POLICY: 'plain' }).settlement
    assert.equal(plain.debitTokens(3000), 0)
})
