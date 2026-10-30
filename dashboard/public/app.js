// RateLock live dashboard (browser side). Receives three kinds of Server-Sent Events from dashboard/server.js:
//   init  : history and current state, once on connect
//   sec   : one entry per second (client-side latency and request counts per role)
//   frame : ~4 per second (pool snapshot, key buckets and debt, new events)
const $ = id => document.getElementById(id)
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const COLORS = { victim: css('--victim'), culprit: css('--culprit'), slow: css('--slow'), ok: css('--ok'), debt: css('--debt'), muted: css('--muted'), line: css('--hair') }

const POLICY_INFO = {
    plain: ['Plain', 'Only each key\'s own quota. Nothing looks at who is hogging the database, so one greedy key can starve everyone.'],
    own_usage: ['Own-usage', 'Prices slow endpoints higher, based on their average latency. It reacts to how slow a call is, not to who it hurts.'],
    conex: ['ConEx', 'Shared blame: holders and waiters are both charged for the waiting. Fair-ish, but innocent waiters pay too.'],
    holder_whole: ['Holder · whole', 'The holder pays for all the waiting it causes from the moment it takes a connection. Waiters get a credit.'],
    holder_overstay: ['Holder · overstay (ours)', 'The holder pays only for waiting after it overstays its endpoint\'s normal hold time (1.2x). Legitimately slow endpoints are never charged. Waiters get a credit.'],
}

const SCENES = {
    1: { policy: 'plain', traffic: { victims: true, culprit: 'hog', slow: false } },
    2: { policy: 'holder_overstay', traffic: { victims: true, culprit: 'hog', slow: false } },
    3: { policy: 'holder_overstay', traffic: { victims: true, culprit: 'normal', slow: true } },
}

let state = null
let history = []
let frame = null
let poolSize = 0
const slotOf = new Map()   // holder id -> slot index
const keySeries = []       // culprit tokens and debt at frame rate, for the third chart
const seenSeq = new Set()

// ---- small helpers ------------------------------------------------------------------------------

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const fmtMs = ms => (ms == null ? '-' : ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + ' s' : Math.round(ms) + ' ms')
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0)
const clock = t => new Date(t).toLocaleTimeString([], { hour12: false })

// ---- controls -----------------------------------------------------------------------------------

function buildPolicyButtons(policies) {
    const box = $('policies')
    box.innerHTML = ''
    for (const p of policies) {
        const b = document.createElement('button')
        b.dataset.p = p
        b.textContent = POLICY_INFO[p][0]
        if (p === 'holder_overstay') b.classList.add('ours')
        b.onclick = () => post('/api/policy', { policy: p })
        box.appendChild(b)
    }
}

function wireSeg(id, key, parse) {
    $(id).querySelectorAll('button').forEach(b => {
        b.onclick = () => post('/api/traffic', { [key]: parse(b.dataset.v) })
    })
}
wireSeg('tVictims', 'victims', v => v === 'true')
wireSeg('tCulprit', 'culprit', v => v)
wireSeg('tSlow', 'slow', v => v === 'true')
$('reset').onclick = () => post('/api/reset')
document.querySelectorAll('.scene').forEach(b => {
    b.onclick = () => post('/api/scene', SCENES[b.dataset.scene])
})

function markSeg(id, value) {
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(value)))
}

function syncControls(f) {
    document.querySelectorAll('#policies button').forEach(b => b.classList.toggle('on', b.dataset.p === f.policy))
    $('policyText').textContent = POLICY_INFO[f.policy]?.[1] ?? ''
    markSeg('tVictims', f.traffic.victims)
    markSeg('tCulprit', f.traffic.culprit)
    markSeg('tSlow', f.traffic.slow)
    document.querySelectorAll('.scene').forEach(b => {
        const s = SCENES[b.dataset.scene]
        const same = s.policy === f.policy && s.traffic.victims === f.traffic.victims
            && s.traffic.culprit === f.traffic.culprit && s.traffic.slow === f.traffic.slow
        b.classList.toggle('active', same)
    })
    const el = $('status')
    el.className = 'status ' + (f.switching ? 'busy' : f.apiUp ? 'live' : 'down')
    $('statusText').textContent = f.switching ? `Switching to ${POLICY_INFO[f.policy][0]}` : f.apiUp ? `Live on ${POLICY_INFO[f.policy][0]}` : 'API is down'
}

// ---- connection pool ----------------------------------------------------------------------------

function buildSlots(size) {
    poolSize = size
    const box = $('slots')
    box.innerHTML = ''
    for (let i = 0; i < size; i++) {
        const d = document.createElement('div')
        d.className = 'slot free'
        d.innerHTML = '<div class="who"><span>free</span><em></em></div><div><div class="held"></div><div class="imp"></div></div><div class="bar"><i></i><u hidden></u></div>'
        box.appendChild(d)
    }
}

const BAR_SCALE_MS = 2000

function renderPool(pool) {
    if (poolSize !== pool.size) buildSlots(pool.size)

    // keep each holder in the same tile while it holds a connection
    const live = new Set(pool.holders.map(h => h.id))
    for (const id of slotOf.keys()) if (!live.has(id)) slotOf.delete(id)
    const used = new Set(slotOf.values())
    for (const h of pool.holders) {
        if (slotOf.has(h.id)) continue
        let i = 0
        while (used.has(i)) i++
        slotOf.set(h.id, i)
        used.add(i)
    }
    const byslot = new Map(pool.holders.map(h => [slotOf.get(h.id), h]))

    const tiles = $('slots').children
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i]
        const h = byslot.get(i)
        if (!h) {
            t.className = 'slot free'
            t.querySelector('.who span').textContent = 'free'
            t.querySelector('.who em').textContent = ''
            t.querySelector('.held').textContent = ''
            t.querySelector('.imp').textContent = ''
            t.querySelector('.bar i').style.width = '0'
            t.querySelector('.bar u').hidden = true
            continue
        }
        const over = h.overstayAfterMs > 0 && h.heldMs > h.overstayAfterMs
        const imposing = h.imposedMs > 50
        t.className = `slot busy ${h.role}${imposing ? ' imposing' : ''}${over ? ' over' : ''}`
        t.querySelector('.who span').textContent = h.label
        t.querySelector('.who em').textContent = h.endpointId.replace('demo.', '')
        t.querySelector('.held').textContent = fmtMs(h.heldMs)
        t.querySelector('.imp').innerHTML = imposing ? `others lost <b>${(h.imposedMs / 1000).toFixed(1)}</b> s` : ''
        t.querySelector('.bar i').style.width = Math.min(100, (h.heldMs / BAR_SCALE_MS) * 100) + '%'
        const mark = t.querySelector('.bar u')
        mark.hidden = !(h.overstayAfterMs > 0)
        mark.style.left = Math.min(100, (h.overstayAfterMs / BAR_SCALE_MS) * 100) + '%'
    }

    const q = $('queue')
    if (pool.waiterCount === 0) {
        q.innerHTML = '<span class="empty">nobody is waiting</span>'
    } else {
        q.innerHTML = pool.waiters.slice(0, 120)
            .map(w => `<span class="q ${w.role}${w.waitedMs > 2000 ? ' old' : ''}" title="${w.label} waiting ${fmtMs(w.waitedMs)}"></span>`).join('')
            + (pool.waiterCount > 120 ? `<span class="more">+${pool.waiterCount - 120}</span>` : '')
    }
    $('poolHint').textContent = `${pool.holders.length} of ${pool.size} in use`
}

// ---- keys, ledger, KPIs, feed ---------------------------------------------------------------------

function renderGauges(keys) {
    const box = $('gauges')
    if (!box.children.length) {
        box.innerHTML = keys.map(k => `<div class="gauge" data-l="${k.label}"><div class="row"><span style="color:${COLORS[k.role]}">${k.label}</span><span></span></div><div class="track"><div class="eff"></div><div class="debt"></div></div></div>`).join('')
    }
    for (const k of keys) {
        const g = box.querySelector(`[data-l="${k.label}"]`)
        const eff = Math.max(0, k.tokens - k.debt)
        g.classList.toggle('neg', k.debt >= k.tokens)
        g.querySelector('.eff').style.width = (eff / k.cap) * 100 + '%'
        const debtEl = g.querySelector('.debt')
        const from = Math.min(k.tokens, k.cap) / k.cap
        const w = Math.min(k.debt, k.tokens) / k.cap
        debtEl.style.left = (from - w) * 100 + '%'
        debtEl.style.width = w * 100 + '%'
        g.querySelector('.row span:last-child').textContent = `tokens ${k.tokens.toFixed(1)} · debt ${k.debt.toFixed(1)} · usable ${eff.toFixed(1)}`
    }
}

function renderLedger(f) {
    const pool = f.pool
    const el = $('ledger')
    const top = [...pool.holders].sort((a, b) => b.imposedMs - a.imposedMs)[0]
    const k = pool.holders.length
    const w = pool.waiterCount
    const formula = '<div class="formula">E += Δt × waiting ÷ holders<br>debit = min(20, α · E)</div>'
    const charged = f.policy.startsWith('holder') || f.policy === 'conex'
    if (!top || top.imposedMs < 100) {
        el.innerHTML = formula + `<div class="row"><span>holders k</span><b>${k}</b></div><div class="row"><span>waiting w</span><b>${w}</b></div><p style="margin-top:8px">No holder is hurting anyone right now.</p>`
        return
    }
    const E = top.imposedMs / 1000
    el.innerHTML = formula
        + `<div class="row"><span>worst holder</span><b style="color:${COLORS[top.role]}">${top.label}</b></div>`
        + `<div class="row"><span>holding for</span><b>${fmtMs(top.heldMs)}</b></div>`
        + `<div class="row"><span>holders k · waiting w</span><b>${k} · ${w}</b></div>`
        + `<div class="row"><span>waiting imposed E</span><b>${E.toFixed(2)} req·s</b></div>`
        + `<div class="row"><span>debit at release</span><b class="big">${charged ? Math.min(20, E).toFixed(2) + ' tokens' : 'none (' + POLICY_INFO[f.policy][0] + ')'}</b></div>`
}

// One live sentence for the presenter, built from what is on screen right now.
function renderStory(f) {
    const el = $('story')
    if (f.switching) { el.innerHTML = `Restarting the API with <b>${POLICY_INFO[f.policy][0]}</b>…`; return }
    const pool = f.pool
    if (!pool) return
    const culpritHolds = pool.holders.filter(h => h.role === 'culprit').length
    const slowHolds = pool.holders.filter(h => h.role === 'slow').length
    const culprit = f.keys?.find(k => k.role === 'culprit')
    const waits = pool.waiters.map(w => w.waitedMs)
    const avgWait = waits.length ? sum(waits, x => x) / waits.length : 0
    const charged = f.policy.startsWith('holder') || f.policy === 'conex'
    const lastC = history.slice(-3)
    const blocked = sum(lastC, e => e.roles.culprit.debt)
    let html
    if (culprit && culprit.debt > 0.5 && blocked > 0) {
        html = `The culprit owes <span class="deb"><b>${culprit.debt.toFixed(1)} tokens</b> of contention debt</span>, so its requests are refused with <b>HTTP 429</b>, ${culpritHolds > 0 ? `so it holds only <b>${culpritHolds}</b> of ${pool.size} connections` : 'so it is shut out of the pool'}. Victims get their connections back: <b>${pool.waiterCount}</b> waiting.`
    } else if (culpritHolds > 0 && pool.waiterCount > 20) {
        html = `The culprit holds <span class="bad"><b>${culpritHolds} of ${pool.size}</b></span> connections. <b>${pool.waiterCount}</b> requests are queued and wait <b>~${fmtMs(avgWait)}</b>. ` +
            (charged ? 'Its debt is building up...' : `Nothing under <b>${POLICY_INFO[f.policy][0]}</b> notices who is to blame.`)
    } else if (slowHolds > 0) {
        html = `The slow key holds <b>${slowHolds}</b> of ${pool.size} connections for 2 s each` +
            (pool.waiterCount > 0 ? `, so <b>${pool.waiterCount}</b> victims wait <b>~${fmtMs(avgWait)}</b>. ` : '. ') +
            (f.policy === 'holder_overstay' ? '<span class="good">That is normal for its endpoint, so it is <b>not charged</b>; waiters are credited.</span>'
                : (charged ? '<span class="bad">This policy charges it anyway: a false accusation.</span>' : 'No debit under this policy.'))
    } else if (pool.waiterCount > 20) {
        html = `<b>${pool.waiterCount}</b> requests are queued and wait <b>~${fmtMs(avgWait)}</b>.`
    } else {
        html = '<span class="good">Healthy.</span> Connections are free and nobody is waiting. Switch the culprit to <b>hog</b> to create a noisy neighbour.'
    }
    el.innerHTML = html
}

function renderKpis(f) {
    const last = history.slice(-5)
    const last3 = history.slice(-3)
    const vp99 = Math.max(0, ...last3.map(e => e.roles.victim.p99 ?? 0))
    const vTotal = sum(last, e => e.roles.victim.ok + e.roles.victim.rate + e.roles.victim.debt + e.roles.victim.timeout)
    const vRef = sum(last, e => e.roles.victim.rate + e.roles.victim.debt)
    const cBlk = sum(last, e => e.roles.culprit.debt) / Math.max(1, last.length)
    const set = (id, text, cls) => { const e = $(id); e.textContent = text; e.className = cls || '' }
    set('kP99', vp99 ? fmtMs(vp99) : '-', vp99 > 1000 ? 'bad' : vp99 > 300 ? 'warn' : vp99 ? 'good' : '')
    set('kVRef', vTotal ? (vRef / vTotal * 100).toFixed(1) + '%' : '-', vTotal && vRef / vTotal > 0.05 ? 'bad' : 'good')
    set('kCBlk', cBlk.toFixed(1), cBlk > 0.5 ? 'warn' : '')
    if (f.pool) {
        const use = f.pool.holders.length
        set('kPool', `${use}/${f.pool.size}`, use >= f.pool.size ? 'bad' : '')
        set('kQueue', String(f.pool.waiterCount), f.pool.waiterCount > 20 ? 'bad' : f.pool.waiterCount > 0 ? 'warn' : 'good')
    }
    if (f.settlement) set('kDebit', f.settlement.debitTokens.toFixed(0), '')
}

function renderEvents(events) {
    const feed = $('feed')
    for (const e of events) {
        if (seenSeq.has(e.seq)) continue
        seenSeq.add(e.seq)
        const parts = []
        if (e.imposedMs >= 100) {
            parts.push(`held ${fmtMs(e.holdMs)}, made others wait <b>${(e.imposedMs / 1000).toFixed(2)} req·s</b>` +
                (e.debit > 0 ? ` → <span class="debit">debit ${e.debit.toFixed(2)}</span>` : ' (not charged under this policy)'))
        }
        if (e.waitMs >= 200) {
            parts.push(`waited ${fmtMs(e.waitMs)}` + (e.credit > 0 ? ` → <span class="credit">credit ${e.credit.toFixed(2)}</span>` : ''))
        }
        const row = document.createElement('div')
        row.className = 'ev'
        row.innerHTML = `<time>${clock(e.ts)}</time><span class="chip ${e.role}">${e.label}</span><span>${parts.join(' · ')}</span>`
        feed.prepend(row)
    }
    while (feed.children.length > 60) feed.lastChild.remove()
}

// ---- charts -------------------------------------------------------------------------------------

class Chart {
    // series: [{ key, label, color }]; points: [{ t, <key>: value|null }]
    constructor(canvas, { series, log = false, minMax = 1, fmt = v => v.toFixed(0) }) {
        this.c = canvas
        this.series = series
        this.log = log
        this.minMax = minMax
        this.fmt = fmt
    }

    draw(points, marks, windowMs = 120000) {
        const c = this.c
        const dpr = window.devicePixelRatio || 1
        const w = c.clientWidth, h = c.clientHeight
        if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
        const g = c.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)

        const L = 40, R = 8, T = 22, B = 18
        const t1 = Date.now(), t0 = t1 - windowMs
        let max = this.minMax
        for (const p of points) for (const s of this.series) if (p[s.key] != null && p.t >= t0) max = Math.max(max, p[s.key])
        max *= 1.15
        const yOf = v => {
            const f = this.log ? Math.log10(Math.max(1, v)) / Math.log10(max) : v / max
            return T + (1 - Math.min(1, Math.max(0, f))) * (h - T - B)
        }
        const xOf = t => L + ((t - t0) / windowMs) * (w - L - R)

        g.font = '11px system-ui, sans-serif'
        g.textBaseline = 'middle'
        g.strokeStyle = COLORS.line
        g.fillStyle = COLORS.muted
        g.lineWidth = 1
        const ticks = this.log ? [1, 10, 100, 1000, 10000].filter(v => v <= max) : [0, 0.25, 0.5, 0.75, 1].map(f => f * max)
        for (const v of ticks) {
            const y = Math.round(yOf(v)) + .5
            g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke()
            g.textAlign = 'right'
            g.fillText(this.fmt(v), L - 5, y)
        }
        g.textAlign = 'center'
        g.fillText('2 min ago', L + 24, h - 6)
        g.fillText('now', w - R - 14, h - 6)

        // policy switches
        let prev = null
        for (const p of points) {
            if (prev && p.policy && p.policy !== prev && p.t >= t0) {
                const x = xOf(p.t)
                g.setLineDash([3, 3]); g.strokeStyle = '#56627a'
                g.beginPath(); g.moveTo(x, T); g.lineTo(x, h - B); g.stroke()
                g.setLineDash([])
                g.fillStyle = '#9aa7c2'; g.textAlign = 'left'
                g.fillText(POLICY_INFO[p.policy][0].replace(' (ours)', ''), x + 4, T + 8)
            }
            prev = p.policy ?? prev
        }

        for (const s of this.series) {
            g.strokeStyle = s.color
            g.lineWidth = 2
            g.lineJoin = 'round'
            g.beginPath()
            let pen = false
            for (const p of points) {
                if (p.t < t0 || p[s.key] == null) { pen = false; continue }
                const x = xOf(p.t), y = yOf(p[s.key])
                if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true }
            }
            g.stroke()
        }

        let lx = L
        g.textAlign = 'left'
        for (const s of this.series) {
            g.fillStyle = s.color
            g.fillRect(lx, 7, 9, 9)
            g.fillStyle = COLORS.muted
            g.fillText(s.label, lx + 13, 12)
            lx += 22 + g.measureText(s.label).width
        }
    }
}

const chLat = new Chart($('chLat'), {
    log: true, minMax: 100,
    series: [
        { key: 'vp99', label: 'victim p99', color: COLORS.victim },
        { key: 'vp50', label: 'victim p50', color: '#8be0ff' },
        { key: 'cp50', label: 'culprit p50', color: COLORS.culprit },
    ],
    fmt: v => (v >= 1000 ? v / 1000 + 's' : v + 'ms'),
})
const chRps = new Chart($('chRps'), {
    minMax: 10,
    series: [
        { key: 'vok', label: 'victim ok', color: COLORS.victim },
        { key: 'cok', label: 'culprit ok', color: COLORS.culprit },
        { key: 'cdebt', label: 'culprit 429 (debt)', color: COLORS.debt },
        { key: 'vref', label: 'victim 429', color: '#ffffff' },
    ],
})
const chDebt = new Chart($('chDebt'), {
    minMax: 10,
    series: [
        { key: 'tokens', label: 'tokens', color: COLORS.ok },
        { key: 'debt', label: 'debt', color: COLORS.debt },
        { key: 'usable', label: 'usable', color: '#ffffff' },
    ],
    fmt: v => v.toFixed(0),
})

function drawCharts() {
    const pts = history.map(e => ({
        t: e.t, policy: e.policy,
        vp99: e.roles.victim.p99, vp50: e.roles.victim.p50, cp50: e.roles.culprit.p50,
        vok: e.roles.victim.ok, cok: e.roles.culprit.ok, cdebt: e.roles.culprit.debt,
        vref: e.roles.victim.rate + e.roles.victim.debt,
    }))
    chLat.draw(pts)
    chRps.draw(pts)
    chDebt.draw(keySeries)
}

// ---- wiring -------------------------------------------------------------------------------------

const es = new EventSource('/events')

es.addEventListener('init', e => {
    const d = JSON.parse(e.data)
    state = d.state
    history = d.history
    buildPolicyButtons(d.policies)
    syncControls({ ...d.state, apiUp: d.state.ready, traffic: d.state.traffic })
    drawCharts()
})

es.addEventListener('sec', e => {
    history.push(JSON.parse(e.data))
    if (history.length > 180) history.shift()
    drawCharts()
    if (frame) renderKpis(frame)
})

es.addEventListener('frame', e => {
    frame = JSON.parse(e.data)
    syncControls(frame)
    if (frame.pool) {
        renderPool(frame.pool)
        renderLedger(frame)
        renderStory(frame)
        renderEvents(frame.events ?? [])
    }
    if (frame.keys) {
        renderGauges(frame.keys)
        const c = frame.keys.find(k => k.role === 'culprit')
        keySeries.push({ t: frame.t, policy: frame.policy, tokens: c.tokens, debt: c.debt, usable: Math.max(0, c.tokens - c.debt) })
        if (keySeries.length > 600) keySeries.shift()
    }
    renderKpis(frame)
})

es.onerror = () => {
    $('status').className = 'status down'
    $('statusText').textContent = 'dashboard server not reachable'
}

window.addEventListener('resize', drawCharts)
