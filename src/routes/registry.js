// Route registry: the only place endpoint IDs are defined (decision D1).
// Table is in docs/plan/contracts.md section 6.
import { makeDemoHandlers } from './demo.js'

export function buildRegistry(db) {
    const h = makeDemoHandlers(db)
    return [
        { endpointId: 'endpoint-a',  method: 'get',  path: '/',             handler: h.root },
        { endpointId: 'demo.cheap',  method: 'get',  path: '/demo/cheap',   handler: h.cheap },
        { endpointId: 'demo.slow',   method: 'get',  path: '/demo/slow',    handler: h.slow },
        { endpointId: 'demo.txn',    method: 'get',  path: '/demo/txn',     handler: h.txn },
        { endpointId: 'demo.hotrow', method: 'post', path: '/demo/hotrow',  handler: h.hotrow },
        { endpointId: 'demo.cpu',    method: 'get',  path: '/demo/cpu',     handler: h.cpu },
    ]
}
