// Small in-memory ring of notable pool holds, read by GET /admin/live for the dashboard.
// Only holds that imposed or suffered real waiting are kept, so the buffer never fills with 1 ms queries.
const MAX_EVENTS = 300
const MIN_IMPOSED_MS = 100
const MIN_WAIT_MS = 200

const events = []
let seq = 0

export const telemetry = {
    pushHold(hold) {
        if (hold.imposedMs < MIN_IMPOSED_MS && hold.waitMs < MIN_WAIT_MS) return
        events.push({
            seq: ++seq,
            ts: Date.now(),
            apiKey: hold.apiKey,
            endpointId: hold.endpointId,
            holdMs: hold.holdMs,
            waitMs: hold.waitMs,
            imposedMs: hold.imposedMs,
            debit: hold.debit,
            credit: hold.credit,
        })
        if (events.length > MAX_EVENTS) events.shift()
    },
    since(cursor) {
        return { seq, events: events.filter(e => e.seq > cursor) }
    },
}
