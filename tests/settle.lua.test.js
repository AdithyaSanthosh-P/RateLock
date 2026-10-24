import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { redis, testKeys, cleanup, nowMs, settle } from './helpers/redis.js'

after(() => redis.quit())

test('debit creates the debt key with a TTL', async () => {
    const k = testKeys()
    const r = await settle({ debtKey: k.debt, debit: 3 })
    assert.equal(r.debt, 3)
    assert.equal(parseFloat(await redis.hget(k.debt, 'd')), 3)
    assert.ok((await redis.pttl(k.debt)) > 0)
    await cleanup(k.debt)
})

test('debits accumulate and are capped', async () => {
    const k = testKeys()
    await settle({ debtKey: k.debt, debit: 30, debtCap: 50 })
    const r = await settle({ debtKey: k.debt, debit: 30, debtCap: 50 })
    assert.equal(r.debt, 50)
    await cleanup(k.debt)
})

test('existing debt decays before the new debit is added', async () => {
    const k = testKeys()
    await redis.hset(k.debt, 'd', '5', 'ts', String((await nowMs()) - 2000))
    const r = await settle({ debtKey: k.debt, debit: 2, decay: 0.001 })
    assert.ok(r.debt > 4.5 && r.debt < 5.5, `debt=${r.debt}`)   // 5 - 2 + 2
    await cleanup(k.debt)
})

test('credit to a missing bucket leaves it full, never above cap', async () => {
    const k = testKeys()
    const r = await settle({ bucketKey: k.bucket, credit: 4, cap: 10 })
    assert.equal(r.tokens, 10)
    await cleanup(k.bucket)
})

test('credit refills the bucket first, then adds', async () => {
    const k = testKeys()
    await redis.hset(k.bucket, 'tokens', '2', 'ts', String((await nowMs()) - 1000))
    const r = await settle({ bucketKey: k.bucket, credit: 3, cap: 100, rate: 0.001 })
    assert.ok(r.tokens > 5.5 && r.tokens < 6.5, `tokens=${r.tokens}`)   // 2 + 1 refill + 3
    await cleanup(k.bucket)
})

test('credit is capped at the bucket size', async () => {
    const k = testKeys()
    await redis.hset(k.bucket, 'tokens', '8', 'ts', String(await nowMs()))
    const r = await settle({ bucketKey: k.bucket, credit: 5, cap: 10 })
    assert.equal(r.tokens, 10)
    await cleanup(k.bucket)
})

test('empty keys skip their part and create nothing', async () => {
    const r = await settle({ debit: 5, credit: 5 })
    assert.equal(r.debt, -1)
    assert.equal(r.tokens, -1)
})

test('debit and credit in one call', async () => {
    const h = testKeys()
    const w = testKeys()
    await redis.hset(w.bucket, 'tokens', '1', 'ts', String(await nowMs()))
    const r = await settle({ debtKey: h.debt, bucketKey: w.bucket, debit: 2.5, credit: 1.5, cap: 10 })
    assert.equal(r.debt, 2.5)
    assert.equal(r.tokens, 2.5)
    await cleanup(h.debt, w.bucket)
})

test('a settled debt blocks the next admit with reason=contention_debt', async () => {
    const k = testKeys()
    await settle({ debtKey: k.debt, debit: 9.5 })
    const r = await redis.admit(k.bucket, k.debt, 10, 0, 1, 60000, 0)
    assert.equal(r[0], 0)
    assert.equal(r[3], 'contention_debt')
    await cleanup(k.bucket, k.debt)
})
