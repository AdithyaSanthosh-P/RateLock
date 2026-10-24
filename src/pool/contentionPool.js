// ContentionPool: a connection pool wrapper that measures, per hold, how much waiting the holder
// imposed on other requests. Spec: docs/plan/phase3-contention-pool.md. Decisions: D3, D4, D8.
//
// Idea: the pool has `size` slots. A request takes a slot (waiting in OUR FIFO queue if none is free),
// then gets a client from pg. Because we own the queue, we know exactly when each waiter starts and
// stops waiting, so the waiting a holder causes can be integrated exactly with no sampling:
//
//     while w requests wait and k requests hold:  each holder is charged  dt * w / k
//
// "whole" policies charge from the moment of acquire; "overstay" charges only after the endpoint's
// normal hold time (gamma * baseline). The pool never talks to Redis: it only emits events (onHold,
// onSettle) and never delays a holder because of accounting.

export class AcquireTimeoutError extends Error {
    constructor() {
        super('timed out waiting for a database connection')
        this.name = 'AcquireTimeoutError'
    }
}

// Used when acquire() is called outside a request (no context): such holds are logged but never settled.
const SYSTEM_CTX = Object.freeze({ apiKey: '__system', endpointId: '__system', cost: 1, tier: null })

export class ContentionPool {
    constructor({
        pgPool, size, policy, gamma, acquireTimeoutMs,
        clock = () => performance.now(),
        getContext, getBaselineMs, onSettle, onHold,
        logger = console,
    }) {
        this.pgPool = pgPool
        this.size = size
        this.policy = policy
        this.gamma = gamma
        this.acquireTimeoutMs = acquireTimeoutMs
        this.clock = clock
        this.getContext = getContext
        this.getBaselineMs = getBaselineMs
        this.onSettle = onSettle
        this.onHold = onHold
        this.logger = logger

        // How the policy changes the accounting (decision D12).
        this.useBaseline = policy === 'holder_overstay'   // overstay: real baseline. Others: baseline 0.
        this.shared = policy === 'conex'                  // conex: holders AND waiters pay

        this.holders = new Map()   // holdId -> holder
        this.waiters = []          // FIFO of waiters
        this.lastT = this.clock()  // time of the last accounting step
        this.nextHoldId = 1
        this.warnedSystem = false
    }

    // ---- accounting ------------------------------------------------------------------------

    // Brings every holder's (and, for conex, every waiter's) total up to `now`.
    // Called at the start of EVERY event, before any state changes. Between two events the number of
    // waiters w and holders k cannot change, so the result is exact.
    advance(now) {
        const dt = now - this.lastT
        if (dt <= 0) {
            this.lastT = now
            return
        }
        const w = this.waiters.length
        const k = this.holders.size
        if (w > 0 && k > 0) {
            if (this.shared) {
                const share = dt * w / (k + w)
                for (const h of this.holders.values()) h.imposedMs += share
                for (const x of this.waiters) x.chargeMs += share
            } else {
                for (const h of this.holders.values()) {
                    // only the part of [lastT, now] after the holder's overstay start counts
                    const over = Math.max(0, now - Math.max(this.lastT, h.overstayStartT))
                    h.imposedMs += over * w / k
                }
            }
        }
        this.lastT = now
    }

    // ---- acquire ---------------------------------------------------------------------------

    async acquire() {
        let ctx = this.getContext()
        if (!ctx) {
            if (!this.warnedSystem) {
                this.logger.warn('ContentionPool.acquire() called without request context; counting as a system hold')
                this.warnedSystem = true
            }
            ctx = SYSTEM_CTX
        }

        const now = this.clock()
        this.advance(now)

        let holdId
        if (this.holders.size < this.size) {
            holdId = this.grant(ctx, now, 0)
        } else {
            holdId = await new Promise((resolve, reject) => {
                const waiter = { ctx, enqT: now, chargeMs: 0, resolve, reject, timer: null }
                waiter.timer = setTimeout(() => this.timeoutWaiter(waiter), this.acquireTimeoutMs)
                this.waiters.push(waiter)
            })
        }

        try {
            const client = await this.pgPool.connect()
            this.holders.get(holdId).client = client
            return { client, holdId }
        } catch (err) {
            this.release(holdId, err)
            throw err
        }
    }

    // Gives a slot to a request. Synchronous. Returns the new holdId.
    grant(ctx, now, waitedMs) {
        const baselineMs = this.useBaseline ? this.getBaselineMs(ctx.endpointId) : 0
        const holdId = this.nextHoldId++
        this.holders.set(holdId, {
            holdId,
            ctx,
            client: null,
            acquireT: now,
            acquiredAtWall: Date.now(),
            waitedMs,
            baselineMs,
            overstayStartT: now + this.gamma * baselineMs,
            imposedMs: 0,
        })
        return holdId
    }

    // ---- release ---------------------------------------------------------------------------

    // Synchronous, idempotent, never throws. Hands the slot to the next waiter, then emits events.
    release(holdId, err) {
        try {
            const h = this.holders.get(holdId)
            if (!h) return

            const now = this.clock()
            this.advance(now)
            this.holders.delete(holdId)

            try {
                h.client?.release(err)
            } catch (e) {
                this.logger.error('client.release failed:', e.message)
            }

            const holdMs = now - h.acquireT
            const overstayMs = Math.max(0, holdMs - this.gamma * h.baselineMs)

            // Hand the slot to the longest-waiting request.
            let grantedWaiter = null
            if (this.waiters.length > 0) {
                const next = this.waiters.shift()
                clearTimeout(next.timer)
                const waitedMs = now - next.enqT
                const newHoldId = this.grant(next.ctx, now, waitedMs)
                next.resolve(newHoldId)
                if (next.ctx !== SYSTEM_CTX) grantedWaiter = this.waiterInfo(next, waitedMs)
            }

            this.emitHold(h, holdMs, overstayMs)
            if (h.ctx !== SYSTEM_CTX) {
                this.emitSettle({
                    kind: 'release',
                    holder: {
                        apiKey: h.ctx.apiKey,
                        endpointId: h.ctx.endpointId,
                        imposedMs: h.imposedMs,
                        overstayMs,
                        holdMs,
                    },
                    grantedWaiter,
                })
            }
        } catch (e) {
            this.logger.error('ContentionPool.release failed:', e)
        }
    }

    // A waiter ran out of patience: reject it, but it still gets credit for the time it waited.
    timeoutWaiter(waiter) {
        const idx = this.waiters.indexOf(waiter)
        if (idx === -1) return
        const now = this.clock()
        this.advance(now)
        this.waiters.splice(idx, 1)
        waiter.reject(new AcquireTimeoutError())
        if (waiter.ctx !== SYSTEM_CTX) {
            this.emitSettle({ kind: 'timeout', waiter: this.waiterInfo(waiter, now - waiter.enqT) })
        }
    }

    waiterInfo(waiter, waitedMs) {
        return {
            apiKey: waiter.ctx.apiKey,
            endpointId: waiter.ctx.endpointId,
            waitedMs,
            chargeMs: waiter.chargeMs,
            admittedCost: waiter.ctx.cost,
            tier: waiter.ctx.tier,
        }
    }

    emitHold(h, holdMs, overstayMs) {
        try {
            this.onHold({
                apiKey: h.ctx.apiKey,
                endpointId: h.ctx.endpointId,
                acquiredAt: h.acquiredAtWall,
                holdMs,
                waitMs: h.waitedMs,
                imposedMs: h.imposedMs,
                overstayMs,
                baselineMs: h.baselineMs,
                admittedCost: h.ctx.cost,
            })
        } catch (e) {
            this.logger.error('onHold failed:', e)
        }
    }

    emitSettle(event) {
        try {
            this.onSettle(event)
        } catch (e) {
            this.logger.error('onSettle failed:', e)
        }
    }

    // ---- convenience wrappers --------------------------------------------------------------

    async query(text, params) {
        const { client, holdId } = await this.acquire()
        let brokenErr
        try {
            return await client.query(text, params)
        } catch (err) {
            brokenErr = brokenConnection(err)
            throw err
        } finally {
            this.release(holdId, brokenErr)
        }
    }

    async withClient(fn) {
        const { client, holdId } = await this.acquire()
        let brokenErr
        try {
            return await fn(client)
        } catch (err) {
            brokenErr = brokenConnection(err)
            throw err
        } finally {
            this.release(holdId, brokenErr)
        }
    }

    stats() {
        return { size: this.size, holders: this.holders.size, waiters: this.waiters.length }
    }
}

// SQL errors (constraint violations, syntax errors) carry a `severity` from the server and leave the
// connection usable. Anything else (reset, terminated) means the client is broken: pg should discard it.
function brokenConnection(err) {
    return err && err.severity ? undefined : err
}
