import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { redis, testKeys, cleanup, nowMs, admit } from './helpers/redis.js'

after(() => redis.quit())

test('missing bucket starts full; first request allowed', async () => {
    const k = testKeys()
    const r = await admit(k, { cap: 10 })
    assert.equal(r.allowed, true)
    assert.equal(r.remaining, 9)
    await cleanup(k.bucket, k.debt)
})

test('cap requests allowed, next denied with reason=rate and retry_ms > 0', async () => {
    const k = testKeys()
    for (let i = 0; i < 5; i++) assert.equal((await admit(k, { cap: 5, rate: 0.001 })).allowed, true)
    const r = await admit(k, { cap: 5, rate: 0.001 })
    assert.equal(r.allowed, false)
    assert.equal(r.reason, 'rate')
    assert.ok(r.retryMs > 0)
    await cleanup(k.bucket, k.debt)
})

test('refill: tokens grow with elapsed time', async () => {
    const k = testKeys()
    await redis.hset(k.bucket, 'tokens', '0', 'ts', String((await nowMs()) - 1000))
    const r = await admit(k, { cap: 100, rate: 0.01, cost: 1 })
    assert.equal(r.allowed, true)
    // about 10 tokens refilled, 1 spent
    assert.ok(r.remaining > 8.5 && r.remaining < 9.5, `remaining=${r.remaining}`)
    await cleanup(k.bucket, k.debt)
})

test('debt blocks admission with reason=contention_debt', async () => {
    const k = testKeys()
    await redis.hset(k.bucket, 'tokens', '10', 'ts', String(await nowMs()))
    await redis.hset(k.debt, 'd', '5', 'ts', String(await nowMs()))
    const r = await admit(k, { cap: 10, cost: 6 })
    assert.equal(r.allowed, false)
    assert.equal(r.reason, 'contention_debt')
    await cleanup(k.bucket, k.debt)
})

test('debt decays with time', async () => {
    const k = testKeys()
    await redis.hset(k.debt, 'd', '5', 'ts', String((await nowMs()) - 2000))
    const r = await admit(k, { cap: 10, decay: 0.001 })
    assert.ok(r.debt > 2.5 && r.debt < 3.5, `debt=${r.debt}`)
    await cleanup(k.bucket, k.debt)
})

test('floats keep their decimals in the reply', async () => {
    const k = testKeys()
    const r = await admit(k, { cap: 10, cost: 0.25 })
    assert.equal(r.remaining, 9.75)
    await redis.hset(k.debt, 'd', '1.5', 'ts', String(await nowMs()))
    const r2 = await admit(k, { cap: 10, cost: 0.25 })
    assert.ok(Math.abs(r2.debt - 1.5) < 0.01, `debt=${r2.debt}`)
    await cleanup(k.bucket, k.debt)
})

test('50 parallel calls on cap=20 allow exactly 20', async () => {
    const k = testKeys()
    const results = await Promise.all(Array.from({ length: 50 }, () => admit(k, { cap: 20, rate: 0 })))
    assert.equal(results.filter(r => r.allowed).length, 20)
    await cleanup(k.bucket, k.debt)
})

test('TTL set on both keys; debt key deleted once debt reaches 0', async () => {
    const k = testKeys()
    await redis.hset(k.debt, 'd', '1', 'ts', String(await nowMs()))
    await admit(k, { cap: 10, ttl: 60000 })
    assert.ok((await redis.pttl(k.bucket)) > 0)
    assert.ok((await redis.pttl(k.debt)) > 0)
    // d=1 with a huge decay and old ts -> 0 -> key deleted
    await redis.hset(k.debt, 'd', '1', 'ts', String((await nowMs()) - 5000))
    await admit(k, { cap: 10, decay: 1 })
    assert.equal(await redis.exists(k.debt), 0)
    await cleanup(k.bucket, k.debt)
})
