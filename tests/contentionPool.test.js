// ContentionPool accounting tests (docs/plan/phase3-contention-pool.md, T1-T14).
// A fake clock and fake pg pool make every number exact; no Postgres or Redis involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, makeFakePgPool, tick } from './helpers/fakes.js'
import { AcquireTimeoutError } from '../src/pool/contentionPool.js'

test('T1: a lone holder imposes no waiting', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 0)
    assert.equal(env.holdFor('A').holdMs, 100)
})

test('T2: a waiter is charged to the holder and gets the slot on release', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    const pw = env.acquire('W', 20)
    await tick()
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 80)
    const ev = env.settles.find(e => e.kind === 'release')
    assert.equal(ev.grantedWaiter.waitedMs, 80)
    assert.equal(ev.grantedWaiter.apiKey, 'W')
    const w = await pw
    env.release(w.holdId, 130)
    assert.equal(env.holdFor('W').waitMs, 80)
    assert.equal(env.holdFor('W').holdMs, 30)
})

test('T3: imposed waiting is split equally between holders', async () => {
    const env = makeEnv({ size: 2 })
    const a = await env.acquire('A', 0)
    const b = await env.acquire('B', 0)
    const pw = env.acquire('W', 10)
    await tick()
    env.release(a.holdId, 60)
    const w = await pw
    env.release(b.holdId, 200)
    env.release(w.holdId, 300)
    assert.equal(env.holdFor('A').imposedMs, 25)
    assert.equal(env.holdFor('B').imposedMs, 25)
    assert.equal(env.holdFor('W').waitMs, 50)
    assert.equal(env.holdFor('W').imposedMs, 0)
})

test('T4: overstay mode counts only waiting after the baseline', async () => {
    const env = makeEnv({ size: 1, policy: 'holder_overstay', gamma: 1, baselines: { e: 50 } })
    const a = await env.acquire('A', 0)
    env.acquire('W', 0)
    await tick()
    env.release(a.holdId, 100)
    const h = env.holdFor('A')
    assert.equal(h.imposedMs, 50)
    assert.equal(h.overstayMs, 50)
    assert.equal(h.baselineMs, 50)
})

test('T5: gamma slack delays the start of overstay', async () => {
    const env = makeEnv({ size: 1, policy: 'holder_overstay', gamma: 1.2, baselines: { e: 50 } })
    const a = await env.acquire('A', 0)
    env.acquire('W', 0)
    await tick()
    env.release(a.holdId, 100)
    const h = env.holdFor('A')
    assert.equal(h.imposedMs, 40)
    assert.equal(h.overstayMs, 40)
})

test('T6: conex splits the same waiting between holder and waiter', async () => {
    const env = makeEnv({ size: 1, policy: 'conex' })
    const a = await env.acquire('A', 0)
    env.acquire('W', 20)
    await tick()
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 40)
    const ev = env.settles.find(e => e.kind === 'release')
    assert.equal(ev.grantedWaiter.chargeMs, 40)
})

test('T7: two waiters double the imposed waiting', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    const p1 = env.acquire('W1', 10)
    const p2 = env.acquire('W2', 30)
    await tick()
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 160)
    const ev = env.settles.find(e => e.kind === 'release')
    assert.equal(ev.grantedWaiter.apiKey, 'W1')
    assert.equal(ev.grantedWaiter.waitedMs, 90)
    assert.equal(env.pool.stats().waiters, 1)
    // drain the queue so no timeout timer is left running
    env.release((await p1).holdId, 110)
    env.release((await p2).holdId, 120)
})

test('T8: waiters are served first come, first served', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    const order = []
    const track = name => p => p.then(r => { order.push(name); return r })
    const p1 = track('W1')(env.acquire('W1', 1))
    const p2 = track('W2')(env.acquire('W2', 2))
    const p3 = track('W3')(env.acquire('W3', 3))
    await tick()
    env.release(a.holdId, 10)
    env.release((await p1).holdId, 20)
    env.release((await p2).holdId, 30)
    await p3
    assert.deepEqual(order, ['W1', 'W2', 'W3'])
})

test('T9: a waiter that times out is rejected and still reported', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const env = makeEnv({ size: 1, acquireTimeoutMs: 50 })
    const a = await env.acquire('A', 0)
    const pw = env.acquire('W', 0)
    pw.catch(() => {})
    await tick()
    env.now = 50
    t.mock.timers.tick(50)
    await assert.rejects(pw, AcquireTimeoutError)
    const ev = env.settles.find(e => e.kind === 'timeout')
    assert.equal(ev.waiter.waitedMs, 50)
    assert.equal(ev.waiter.apiKey, 'W')
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 50)   // W only counted until it gave up
})

test('T10: release is idempotent and ignores unknown ids', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    env.release(a.holdId, 10)
    env.release(a.holdId, 20)
    env.release(999, 30)
    assert.equal(env.holds.length, 1)
    assert.equal(env.settles.length, 1)
})

test('T11: a throwing client.release does not stop the handoff', async () => {
    const env = makeEnv({ size: 1, pgPool: makeFakePgPool({ clientReleaseThrows: true }) })
    const a = await env.acquire('A', 0)
    const pw = env.acquire('W', 5)
    await tick()
    assert.doesNotThrow(() => env.release(a.holdId, 10))
    const w = await pw
    assert.ok(w.holdId)
})

test('T12: a request without context is a system hold: logged, never settled', async () => {
    const env = makeEnv({ size: 1 })
    env.ctx = null
    env.now = 0
    const a = await env.pool.acquire()
    env.release(a.holdId, 10)
    assert.equal(env.holds[0].apiKey, '__system')
    assert.equal(env.settles.length, 0)
})

test('T13: conservation, total imposed waiting equals the integral of waiters over time', async () => {
    // Small seeded generator so a failure is reproducible.
    let seed = 12345
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296

    const SIZE = 3
    const env = makeEnv({ size: SIZE, policy: 'holder_whole' })
    const active = []        // holdIds currently held
    let pending = 0          // acquires waiting for a slot
    let holders = 0
    let expected = 0         // independent model of the integral of w dt over k > 0
    let last = 0
    let t = 0
    const promises = []

    const advanceModel = to => {
        if (holders > 0) expected += pending * (to - last)
        last = to
    }

    for (let i = 0; i < 200; i++) {
        t += 1 + Math.floor(rand() * 20)
        const doAcquire = active.length === 0 || rand() < 0.55
        advanceModel(t)
        if (doAcquire) {
            if (holders < SIZE) holders++; else pending++
            promises.push(env.acquire(`K${i % 7}`, t).then(r => active.push(r.holdId)))
        } else {
            const holdId = active.splice(Math.floor(rand() * active.length), 1)[0]
            holders--
            if (pending > 0) { pending--; holders++ }
            env.release(holdId, t)
        }
        await tick()
    }
    while (active.length || pending) {
        t += 5
        advanceModel(t)
        const holdId = active.shift()
        holders--
        if (pending > 0) { pending--; holders++ }
        env.release(holdId, t)
        await tick()
    }
    await Promise.all(promises)

    const total = env.holds.reduce((s, h) => s + h.imposedMs, 0)
    assert.ok(Math.abs(total - expected) < 1e-6, `total=${total} expected=${expected}`)
})

test('T14: overstay with a zero baseline matches whole mode', async () => {
    const run = async policy => {
        const env = makeEnv({ size: 1, policy, gamma: 1.2, baselines: { e: 0 } })
        const a = await env.acquire('A', 0)
        env.acquire('W', 10)
        await tick()
        env.release(a.holdId, 90)
        return env.holdFor('A').imposedMs
    }
    assert.equal(await run('holder_overstay'), await run('holder_whole'))
})

test('snapshot: shows holders, waiters and the imposed total so far, without changing the final accounting', async () => {
    const env = makeEnv({ size: 1 })
    const a = await env.acquire('A', 0)
    env.acquire('W', 20)
    await tick()
    env.now = 60
    const snap = env.pool.snapshot()
    assert.equal(snap.holders.length, 1)
    assert.equal(snap.holders[0].apiKey, 'A')
    assert.equal(snap.holders[0].heldMs, 60)
    assert.equal(snap.holders[0].imposedMs, 40)
    assert.equal(snap.waiterCount, 1)
    assert.equal(snap.waiters[0].waitedMs, 40)
    env.release(a.holdId, 100)
    assert.equal(env.holdFor('A').imposedMs, 80)
})
