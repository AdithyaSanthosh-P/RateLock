// Baseline provider: B_e, the normal hold time of each endpoint, in ms.
// Course-project version (P5.1): static values from endpoint_costs.static_hold_ms, loaded once.
// The live baseline (median of per-key medians with a drift cap) is described in the report, not built.
export function makeBaselines({ sysPool }) {
    let staticMs = new Map()

    return {
        getBaselineMs(endpointId) {
            return staticMs.get(endpointId) ?? 0
        },
        async start() {
            const result = await sysPool.query('SELECT endpoint, static_hold_ms FROM endpoint_costs WHERE static_hold_ms IS NOT NULL')
            staticMs = new Map(result.rows.map(r => [r.endpoint, Number(r.static_hold_ms)]))
        },
        stop() {},
    }
}
