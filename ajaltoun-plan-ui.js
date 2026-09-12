// Ajaltoun 4193 — the Budget and Plan tabs of ajaltoun.html.
// Reads window.D (the Accounts data: Odoo lines with their section) and window.P (items + settings from
// /api/ajaltoun/plan). One model: BOQ items per villa type → budget by trade → the Odoo lines spent against it →
// the remaining budget placed in years per villa → the cashflow, with the D3 / services-fee mechanism.
(function () {
  const esc = Admin.esc;
  const usd = n => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const usd0 = n => Math.abs(n) < 0.5 ? '' : usd(n);
  const VILLAS = ['U1', 'U2', 'U3', 'D1', 'D2', 'D3'];
  const PHASES = { site: 'Site works', structure: 'Structure', finishing: 'Finishing' };
  // the 14 divisions of the Fanar 212 BOQ (Sayed Saadeh, Jul 2026) — our bill numbers follow them; 00 = summary
  const DIVISIONS = ['Summary', 'Excavation', 'Concrete', 'Block work', 'Waterproofing', 'Wood work', 'Metal & aluminium', 'Plaster work', 'Tiling & cladding', 'Painting', 'Suspended ceiling', 'Plumbing', 'Electrical', 'Ventilation', 'Lift',
    'Lift (ours)', 'Pool', 'Kitchen', 'General — permits, connections, insurance', , 'Landscape'];   // 15+ = our own bills beyond Fanar's 14
  const fanarPdf = n => `/api/ajaltoun/plan/fanar/${String(n).padStart(2, '0')}`;
  const divName = b => DIVISIONS[b] || (b ? 'Bill ' + b : 'Other');
  const THIS_YEAR = new Date().getFullYear();
  let P = null, tab = 'U', scenario = 'expected', editing = null;
  const openDivs = new Set();   // divisions unfolded on the BOQ grid (key type:bill); everything starts collapsed

  const secName = id => ((window.D && D.sections.find(s => s.id === id)) || { name: id }).name;
  const isEquip = id => !!((window.D && D.sections.find(s => s.id === id)) || {}).equipment;
  const sum = (a, f) => a.reduce((x, i) => x + (f ? f(i) : i), 0);

  async function load() { P = await Admin.api('GET', '/api/ajaltoun/plan'); return P; }

  // ── budget maths ─────────────────────────────────────────────────────────
  function budget() {
    const byType = { U: P.items.filter(i => i.type === 'U'), D: P.items.filter(i => i.type === 'D') };
    const perVilla = { U: sum(byType.U, i => i.total || 0), D: sum(byType.D, i => i.total || 0) };
    const villaBudget = v => perVilla[P.settings.villas[v].type];
    const project = sum(VILLAS, villaBudget);
    // by trade, six villas
    const trades = {};
    for (const v of VILLAS) for (const i of byType[P.settings.villas[v].type]) trades[i.trade] = (trades[i.trade] || 0) + (i.total || 0);
    // spent by trade from the Odoo lines (equipment aside)
    const spent = {};
    for (const l of (window.D ? D.lines : [])) spent[l.section] = (spent[l.section] || 0) + l.amount;
    return { byType, perVilla, villaBudget, project, trades, spent };
  }

  // ── plan maths ───────────────────────────────────────────────────────────
  // Where each villa's phases land in time, given its status; budget already spent (per trade) is consumed first.
  function plan() {
    const S = P.settings, years = S.years, B = budget();
    const on = v => { const s = S.villas[v].status; return s === 'sold' || s === 'mario' || (scenario === 'expected' && s === 'expected'); };
    const yearsOf = (v, phase) => {
      const c = S.villas[v];
      const struct = c.structureYear || c.saleYear || S.siteYear, fin = c.finishYear || (struct + 1);
      if (phase === 'site') return [[S.siteYear, 1]];
      if (phase === 'structure') return [[struct, 1]];
      return [[fin, 0.5], [fin + 1, 0.5]];
    };
    // planned costs: villa × phase × trade × year
    const planned = [];
    for (const v of VILLAS) {
      const items = B.byType[S.villas[v].type];
      for (const ph of Object.keys(PHASES)) {
        if (ph !== 'site' && !on(v)) continue;   // an unsold villa is not built in this scenario; the site works happen anyway
        const byTrade = {};
        for (const i of items.filter(i => (i.phase || 'finishing') === ph)) byTrade[i.trade] = (byTrade[i.trade] || 0) + (i.total || 0);
        for (const [trade, amt] of Object.entries(byTrade)) for (const [y, share] of yearsOf(v, ph)) planned.push({ v, ph, trade, y, amt: amt * share });
      }
    }
    // what Odoo already shows as spent eats into the earliest planned amounts of the same trade
    planned.sort((a, b) => a.y - b.y);
    const left = { ...B.spent };
    for (const p of planned) { if (isEquip(p.trade)) continue; const use = Math.min(p.amt, Math.max(0, left[p.trade] || 0)); p.amt -= use; left[p.trade] = (left[p.trade] || 0) - use; }
    // actual spend by year (Odoo), equipment aside
    const actual = {};
    for (const l of (window.D ? D.lines : [])) { if (isEquip(l.section)) continue; const y = +l.date.slice(0, 4); actual[y] = (actual[y] || 0) + l.amount; }
    // inflows
    const inflow = [];   // { label, group, byYear }
    const inv = window.D && D.income[0];
    if (inv) {
      const by = {};
      for (const p of inv.received) by[+p.date.slice(0, 4)] = (by[+p.date.slice(0, 4)] || 0) + p.amount;
      for (const s of inv.schedule) if (s.residual > 0.5) by[+s.due.slice(0, 4)] = (by[+s.due.slice(0, 4)] || 0) + s.residual;
      inflow.push({ label: `U2 — ${inv.partner} (contract ${usd(inv.total)}; received ${usd(sum(inv.received, p => p.amount))})`, group: 'sold', byYear: by });
    }
    if (scenario === 'expected') for (const v of VILLAS) {
      const c = S.villas[v]; if (c.status !== 'expected') continue;
      const by = {}; const n = Math.max(1, c.payYears || 1);
      for (let k = 0; k < n; k++) by[c.saleYear + k] = (by[c.saleYear + k] || 0) + c.price / n;
      inflow.push({ label: `${v} — expected sale ${usd(c.price)} in ${c.saleYear}, paid over ${n} years`, group: 'expected', byYear: by });
    }
    // outflows by row
    const out = [];   // { label, group, byYear, v }
    out.push({ label: 'Spent to date (Odoo, all trades)', group: 'actual', byYear: actual });
    const rowOf = {};
    for (const p of planned) {
      if (p.amt < 0.5) continue;
      const key = p.v + '|' + p.ph;
      rowOf[key] = rowOf[key] || { label: `${p.v} — ${PHASES[p.ph]}${p.v === 'D3' && p.ph !== 'site' ? ' (settles Shift’s fee)' : ''}`, group: p.v === 'D3' && p.ph !== 'site' ? 'd3' : 'planned', v: p.v, ph: p.ph, byYear: {} };
      rowOf[key].byYear[p.y] = (rowOf[key].byYear[p.y] || 0) + p.amt;
    }
    out.push(...Object.values(rowOf).sort((a, b) => VILLAS.indexOf(a.v) - VILLAS.indexOf(b.v) || Object.keys(PHASES).indexOf(a.ph) - Object.keys(PHASES).indexOf(b.ph)));
    // the D3 / fee mechanism: Shift's fee is earned by phase; D3's works settle it; anything above the fee earned so far is Mario's own money in
    const fee = {}; S.fee.phasing.forEach((sh, k) => { fee[S.fee.startYear + k] = S.fee.total * sh; });
    const d3 = {}; for (const r of out.filter(r => r.group === 'd3')) for (const [y, a] of Object.entries(r.byYear)) d3[y] = (d3[y] || 0) + a;
    const contrib = {}; let cumFee = 0, cumD3 = 0, cumContrib = 0;
    for (const y of years) { cumFee += fee[y] || 0; cumD3 += d3[y] || 0; const need = Math.max(0, cumD3 - cumFee) - cumContrib; if (need > 0.5) { contrib[y] = need; cumContrib += need; } }
    if (Object.keys(contrib).length) inflow.push({ label: 'Mario — own money into D3 above the fee earned', group: 'mario', byYear: contrib });
    // totals
    const tot = (rows, y) => sum(rows, r => r.byYear[y] || 0);
    const net = {}, cum = {}; let c = 0;
    for (const y of years) { net[y] = tot(inflow, y) - tot(out, y); c += net[y]; cum[y] = c; }
    const gapYear = years.reduce((g, y) => cum[y] < cum[g] ? y : g, years[0]);
    return { years, inflow, out, net, cum, fee, d3, contrib, gap: { year: gapYear, amount: cum[gapYear] }, tot };
  }

  // ── Budget tab ───────────────────────────────────────────────────────────
  function renderBudget(el) {
    const B = budget(); const S = P.settings;
    const ids = [...new Set([...Object.keys(B.trades), ...Object.keys(B.spent)])].sort((a, b) => (B.trades[b] || 0) - (B.trades[a] || 0));
    const rows = ids.filter(id => !isEquip(id)).map(id => { const b = B.trades[id] || 0, s = B.spent[id] || 0; return { id, b, s, r: b - s }; });
    const totB = sum(rows, r => r.b), totS = sum(rows, r => r.s);
    const equipRows = ids.filter(isEquip).map(id => ({ id, s: B.spent[id] || 0 }));
    const items = B.byType[tab];
    const groups = []; for (const i of items) { const b = i.bill == null || i.bill === '' ? null : +i.bill; let g = groups.find(x => x.bill === b); if (!g) groups.push(g = { bill: b, items: [] }); g.items.push(i); }
    groups.sort((a, b) => (a.bill ?? 99) - (b.bill ?? 99));
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${usd(B.perVilla.U)}</div><div class="l">budget per U villa (up 333) · ${B.byType.U.length} lines</div></div>
        <div class="kpi"><div class="v">${usd(B.perVilla.D)}</div><div class="l">budget per D villa (down) · ${B.byType.D.length} lines</div></div>
        <div class="kpi cash"><div class="v">${usd(B.project)}</div><div class="l">six villas · of which D3 (Mario) ${usd(B.villaBudget('D3'))}</div></div>
        <div class="kpi out"><div class="v">${usd(totS)}</div><div class="l">spent so far (Odoo) · ${(100 * totS / Math.max(1, totB)).toFixed(1)}% of the budget</div></div>
        <div class="kpi"><div class="v">${P.items.filter(i => i.review).length}</div><div class="l">lines still at 2022–2024 prices, to review</div></div>
      </div>
      <h2>Budget vs spent, by trade <span class="r muted">six villas · spent = Odoo lines classified in that trade</span></h2>
      <div class="card"><div class="wrap"><table>
        <thead><tr><th>Trade</th><th class="n">Budget</th><th class="n">Spent</th><th class="n">Remaining</th><th>Used</th><th class="n">%</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(secName(r.id))}</td><td class="n">${usd(r.b)}</td><td class="n">${usd0(r.s)}</td><td class="n ${r.r < 0 ? 'flag' : ''}">${usd(r.r)}</td>
          <td><div class="bar"><i style="width:${Math.min(100, 100 * r.s / Math.max(1, r.b))}%;${r.s > r.b ? 'background:var(--red)' : ''}"></i></div></td><td class="n">${r.b ? (100 * r.s / r.b).toFixed(0) + '%' : '—'}</td></tr>`).join('')}
        <tr class="tot"><td>Project (without equipment)</td><td class="n">${usd(totB)}</td><td class="n">${usd(totS)}</td><td class="n">${usd(totB - totS)}</td><td></td><td class="n">${(100 * totS / Math.max(1, totB)).toFixed(0)}%</td></tr>
        ${equipRows.map(r => `<tr class="eq"><td>${esc(secName(r.id))} <span class="pill eq">equipment</span></td><td class="n">—</td><td class="n">${usd(r.s)}</td><td class="n">—</td><td></td><td></td></tr>`).join('')}
        </tbody></table></div>
        <div class="note">A trade with spend but no budget line (e.g. Topo, Site & general) shows a negative remaining — add a budget line for it, or reclassify the lines on the Accounts tab.</div>
      </div>
      <h2>BOQ lines <span class="r"><span class="lang"><button class="${tab === 'U' ? 'on' : ''}" onclick="Plan.setTab('U')">Villa U — up 333</button><button class="${tab === 'D' ? 'on' : ''}" onclick="Plan.setTab('D')">Villa D — down</button></span> &nbsp; <button class="btn" onclick="Plan.foldAll(true)" title="Open every division">Expand all</button><button class="btn" onclick="Plan.foldAll(false)" title="Close every division">Collapse all</button>${P.admin ? ` &nbsp; <button class="btn ap" onclick="Plan.edit(null)">+ Add a line</button>` : ''}</span></h2>
      <div class="card"><div class="wrap"><table>
        <thead><tr><th>Bill</th><th>Item</th><th>Trade</th><th>Phase</th><th>Unit</th><th class="n">Qty</th><th class="n">Unit price</th>${P.admin ? '<th class="n">Jul 2026 ref</th>' : ''}<th class="n">Total</th><th></th></tr></thead>
        <tbody>${groups.map(g => { const key = tab + ':' + g.bill, open = openDivs.has(key) || g.items.some(i => i.id === editing); return `<tr class="div ${open ? 'open' : ''}" onclick="Plan.toggleDiv('${key}')" style="cursor:pointer"><td class="muted small">${g.bill ?? ''}</td><td colspan="${P.admin ? 7 : 6}"><span class="caret">${open ? '▾' : '▸'}</span>${esc(divName(g.bill))} <span class="small muted" style="font-weight:400">· ${g.items.length} line${g.items.length > 1 ? 's' : ''}</span>${P.admin && g.bill >= 1 && g.bill <= 14 ? ` <a class="small" href="${fanarPdf(g.bill)}" target="_blank" title="Fanar 212 reference BOQ — ${esc(DIVISIONS[g.bill])}" onclick="event.stopPropagation()">📄 Fanar ref</a>` : ''}</td><td class="n">${usd(sum(g.items, i => i.total || 0))}</td><td></td></tr>` + (open ? g.items : []).map(i => editing === i.id ? editRow(i) : `<tr ${P.admin ? `style="cursor:pointer" onclick="Plan.edit('${i.id}')"` : ''}>
          <td class="muted small">${i.bill ?? ''}</td>
          <td>${esc(i.name)}${i.review ? ' <span class="pill" title="Imported from the 2022–2024 BOQ — to review">2022 prices</span>' : ''}${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ''}${(i.history || []).length ? `<div class="small muted" title="${esc(i.history.map(h => h.at.slice(0, 10) + ' ' + h.by + ': ' + h.changes.map(c => c.f + ' ' + c.from + ' → ' + c.to).join(', ')).join('\n'))}">🕘 ${i.history.length} change${i.history.length > 1 ? 's' : ''} · last ${esc(i.history[i.history.length - 1].at.slice(0, 10))} by ${esc(i.history[i.history.length - 1].by)}</div>` : ''}</td>
          <td><span class="pill">${esc(secName(i.trade))}</span></td><td class="small muted">${PHASES[i.phase] || ''}</td>
          <td class="small muted">${esc(i.unit || '')}</td><td class="n">${i.qty ?? ''}</td><td class="n">${i.price != null ? usd(i.price) : ''}</td>${P.admin ? `<td class="n">${refCell(i)}</td>` : ''}<td class="n">${usd(i.total || 0)}</td>
          <td class="small muted" title="${esc(i.source || '')}">${i.source ? '📄' : ''}</td></tr>`).join(''); }).join('')}
        ${editing === '' ? editRow({ type: tab, phase: 'finishing', trade: 'general', review: false }) : ''}
        <tr class="tot"><td></td><td>Total per villa ${tab}</td><td colspan="${P.admin ? 6 : 5}"></td><td class="n">${usd(B.perVilla[tab])}</td><td></td></tr></tbody></table></div>
        <div class="note">Quantities come from the take-off sheets in <i>0. EXCEL boq</i> (Dropbox); this is the summary that becomes the budget. Click a division to open it, a line to edit it in place (Enter saves, Esc cancels) — every change is kept with who and when.</div>
      </div>
      ${P.admin ? `<h2>Reference · Fanar 212 BOQ <span class="r muted">Sayed Saadeh, July 2026 — the rates in the “Jul 2026 ref” column come from here</span></h2>
      <div class="card"><div class="fanar">${DIVISIONS.slice(0, 15).map((d, n) => `<a href="${fanarPdf(n)}" target="_blank">📄 <b>${String(n).padStart(2, '0')}</b> ${esc(d)}</a>`).join('')}<a href="/api/ajaltoun/plan/fanar/specs" target="_blank">📘 Specifications (7-22-2026)</a></div>
        <div class="note">One PDF per division; the same numbering as our bill column. Mario only — the links open in a new tab.</div>
      </div>` : ''}`;
    const first = el.querySelector('tr.editing input'); if (first) { first.focus(); first.select(); }
  }

  // Fanar 212 (Sayed Saadeh, Jul 2026) rate next to ours; "use" adopts it, stamped in the line's history
  function refCell(i) {
    const f = i.ref; if (!f || f.rate == null) return f && f.note ? `<span class="small muted" title="${esc(f.src || '')}">${esc(f.note)}</span>` : '';
    const same = i.price != null && Math.abs(i.price - f.rate) < 0.005;
    const canUse = P.admin && i.qty != null && !same;
    return `<span class="${same ? 'ok' : (i.price != null && f.rate < i.price ? 'ok' : 'flag')}" title="${esc((f.note ? f.note + ' · ' : '') + (f.src || ''))}">${f.rate ? usd(f.rate) : '$0'}${f.unit ? '<span class="small muted">/' + esc(f.unit) + '</span>' : ''}</span>${canUse ? ` <button class="btn ap" onclick="event.stopPropagation();Plan.useRef('${i.id}')" title="Set our unit price to this rate">use</button>` : ''}`;
  }
  async function useRef(id) {
    const i = P.items.find(x => x.id === id); if (!i || !i.ref) return;
    const item = { ...i, price: i.ref.rate, review: false, note: [i.note, 'rate from ' + (i.ref.src || 'Fanar 2026')].filter(Boolean).join(' · ') };
    delete item.history; delete item.total;
    try { const r = await Admin.api('POST', '/api/ajaltoun/plan/item', { item }); const k = P.items.findIndex(x => x.id === r.item.id); P.items[k] = r.item; window.renderTab && renderTab(); } catch (e) { alert('Could not save: ' + e.message); }
  }

  // the line being edited, drawn in place of its grid row (Enter saves, Esc cancels); ids e-* are read back by save()
  function editRow(i) {
    const opt = (list, val) => list.map(x => `<option value="${x[0]}" ${x[0] === val ? 'selected' : ''}>${esc(x[1])}</option>`).join('');
    const id = i.id || '';
    return `<tr class="editing" onkeydown="Plan.editKey(event, '${id}')">
      <td><input id="e-bill" type="number" value="${i.bill ?? ''}" placeholder="bill" style="width:46px"></td>
      <td><input id="e-name" value="${esc(i.name || '')}" placeholder="item" style="width:100%;min-width:170px;box-sizing:border-box">
        <input id="e-note" value="${esc(i.note || '')}" placeholder="note" class="small" style="width:100%;box-sizing:border-box;margin-top:4px">
        <label class="small muted" style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;white-space:nowrap"><input type="checkbox" id="e-review" ${i.review ? 'checked' : ''}> still at 2022–2024 prices</label></td>
      <td><select id="e-trade">${opt(D.sections.map(s => [s.id, s.name]), i.trade)}</select></td>
      <td><select id="e-phase">${opt(Object.entries(PHASES), i.phase || 'finishing')}</select></td>
      <td><input id="e-unit" value="${esc(i.unit || '')}" placeholder="unit" style="width:52px"></td>
      <td class="n"><input id="e-qty" type="number" step="any" value="${i.qty ?? ''}" placeholder="qty" style="width:72px;text-align:right" oninput="Plan.liveTotal()"></td>
      <td class="n"><input id="e-price" type="number" step="any" value="${i.price ?? ''}" placeholder="$/unit" style="width:76px;text-align:right" oninput="Plan.liveTotal()"></td>
      ${P.admin ? `<td class="n">${i.id ? refCell(i) : ''}</td>` : ''}
      <td class="n"><input id="e-amount" type="number" step="any" value="${i.amount ?? ''}" placeholder="fixed $" title="Fixed amount, if no qty × price" style="width:84px;text-align:right"><div id="e-total" class="small muted"></div></td>
      <td style="white-space:nowrap"><button class="btn ok" onclick="Plan.save('${id}')" title="Save (Enter)">✓</button> <button class="btn" onclick="Plan.closeEdit()" title="Cancel (Esc)">✕</button>${id ? ` <button class="btn flag" onclick="Plan.remove('${id}')" title="Delete this line">🗑</button>` : ''}</td>
    </tr>`;
  }
  function liveTotal() {
    const q = +document.getElementById('e-qty').value, p = +document.getElementById('e-price').value, t = document.getElementById('e-total');
    if (t) t.textContent = q && p ? '= ' + usd(q * p) : '';
  }
  function editKey(e, id) {
    if (e.key === 'Escape') { e.preventDefault(); closeEdit(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); save(id); }
  }
  function closeEdit() { editing = null; window.renderTab && renderTab(); }

  async function save(id) {
    const g = k => document.getElementById('e-' + k).value;
    const item = { id: id || undefined, type: tab, name: g('name'), bill: g('bill'), trade: g('trade'), phase: g('phase'), unit: g('unit'), qty: g('qty'), price: g('price'), amount: g('amount'), note: g('note'), review: document.getElementById('e-review').checked };
    try { const r = await Admin.api('POST', '/api/ajaltoun/plan/item', { item }); const k = P.items.findIndex(x => x.id === r.item.id); if (k >= 0) P.items[k] = r.item; else P.items.push(r.item); editing = null; window.renderTab && renderTab(); }
    catch (e) { alert('Could not save: ' + e.message); }
  }
  async function remove(id) {
    if (!confirm('Delete this budget line?')) return;
    try { await Admin.api('POST', '/api/ajaltoun/plan/item', { id, delete: true }); P.items = P.items.filter(x => x.id !== id); editing = null; window.renderTab && renderTab(); } catch (e) { alert(e.message); }
  }

  // ── Plan tab ─────────────────────────────────────────────────────────────
  function renderPlan(el) {
    const S = P.settings, R = plan();
    const Y = R.years;
    const cell = (v, cls) => `<td class="n ${cls || ''}">${usd0(v)}</td>`;
    const row = (r, cls) => `<tr class="${cls || ''}"><td>${esc(r.label)}</td>${Y.map(y => cell(r.byYear[y] || 0)).join('')}<td class="n">${usd(sum(Y, y => r.byYear[y] || 0))}</td></tr>`;
    const totRow = (label, rows, cls) => `<tr class="${cls}"><td>${label}</td>${Y.map(y => cell(R.tot(rows, y))).join('')}<td class="n">${usd(sum(Y, y => R.tot(rows, y)))}</td></tr>`;
    const feeSettled = {}; let cf = 0, cd = 0;
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi ${R.gap.amount < 0 ? 'out' : 'cash'}"><div class="v">${usd(R.gap.amount)}</div><div class="l">${R.gap.amount < 0 ? `deepest point of the project cash — in ${R.gap.year}. That is the funding gap the partners cover.` : `lowest project cash, in ${R.gap.year} — no gap in this scenario`}</div></div>
        <div class="kpi in"><div class="v">${usd(sum(Y, y => R.tot(R.inflow, y)))}</div><div class="l">money in over the horizon</div></div>
        <div class="kpi out"><div class="v">${usd(sum(Y, y => R.tot(R.out, y)))}</div><div class="l">money out — spent so far + remaining budget</div></div>
        <div class="kpi cash"><div class="v">${usd(R.cum[Y[Y.length - 1]])}</div><div class="l">project cash at the end of ${Y[Y.length - 1]}</div></div>
      </div>
      <div class="filters" style="margin-top:18px">
        <span class="lang"><button class="${scenario === 'confirmed' ? 'on' : ''}" onclick="Plan.setScenario('confirmed')">Confirmed only</button><button class="${scenario === 'expected' ? 'on' : ''}" onclick="Plan.setScenario('expected')">With expected sales</button></span>
        <span class="small muted">Confirmed = U2 sold to Jean + D3 (Mario). Expected adds the unsold villas at the prices and years set below.</span>
      </div>
      <div class="card"><div class="wrap"><table class="plan">
        <thead><tr><th></th>${Y.map(y => `<th class="n ${y === THIS_YEAR ? 'now' : ''}">${y}</th>`).join('')}<th class="n">Total</th></tr></thead>
        <tbody>
          <tr class="grp"><td colspan="${Y.length + 2}">Money in</td></tr>
          ${R.inflow.map(r => row(r, r.group === 'mario' ? 'eq' : '')).join('')}
          ${totRow('Total in', R.inflow, 'sub')}
          <tr class="grp"><td colspan="${Y.length + 2}">Money out</td></tr>
          ${R.out.map(r => row(r, r.group === 'd3' ? 'eq' : r.group === 'actual' ? 'act' : '')).join('')}
          ${totRow('Total out', R.out, 'sub')}
          <tr class="tot"><td>Net cash flow</td>${Y.map(y => cell(R.net[y])).join('')}<td class="n">${usd(sum(Y, y => R.net[y]))}</td></tr>
          <tr class="tot"><td>Cumulative project cash</td>${Y.map(y => `<td class="n" style="${R.cum[y] < 0 ? 'color:var(--red)' : ''}">${usd(R.cum[y])}</td>`).join('')}<td></td></tr>
        </tbody></table></div>
        <div class="note">Past years show what Odoo has; the current year and beyond show the remaining budget placed by phase — site works in ${S.siteYear}, a villa's structure in its structure year, finishing over the two years after. Spend already booked in a trade is deducted from that trade's first planned amounts.</div>
      </div>
      <h2>Shift’s services fee and Villa D3 <span class="r muted">the fee is settled by the project funding D3; above it, Mario pays</span></h2>
      <div class="card"><div class="wrap"><table class="plan">
        <thead><tr><th></th>${Y.map(y => `<th class="n">${y}</th>`).join('')}<th class="n">Total</th></tr></thead>
        <tbody>
          <tr><td>Fee earned (${usd(S.fee.total)}, from ${S.fee.startYear}: ${S.fee.phasing.map(p => Math.round(p * 100) + '%').join(' / ')})</td>${Y.map(y => cell(R.fee[y] || 0)).join('')}<td class="n">${usd(sum(Y, y => R.fee[y] || 0))}</td></tr>
          <tr><td>D3 works paid by the project (settling the fee)</td>${Y.map(y => cell(R.d3[y] || 0)).join('')}<td class="n">${usd(sum(Y, y => R.d3[y] || 0))}</td></tr>
          <tr class="sub"><td>Fee earned, not yet settled (cumulative)</td>${Y.map(y => { cf += R.fee[y] || 0; cd += (R.d3[y] || 0) - (R.contrib[y] || 0); return `<td class="n">${usd(cf - cd)}</td>`; }).join('')}<td></td></tr>
          <tr class="eq"><td>Mario’s own money into D3 (above the fee earned)</td>${Y.map(y => cell(R.contrib[y] || 0)).join('')}<td class="n">${usd(sum(Y, y => R.contrib[y] || 0))}</td></tr>
        </tbody></table></div>
        <div class="note">At signing, Mario also receives Antoine’s half of the D3 land in kind — ${usd(S.d3LandHalf)} at the agreed land value of ${usd(S.land)} (D3 agreement, art. 3). Not a cash movement, so it is not in the table.</div>
      </div>
      <h2>Assumptions ${P.admin ? '<span class="r muted">edit and save — the plan recalculates</span>' : ''}</h2>
      <div class="card"><div class="wrap"><table>
        <thead><tr><th>Villa</th><th>Type</th><th>Status</th><th class="n">Price</th><th class="n">Sale year</th><th class="n">Paid over (yrs)</th><th class="n">Structure year</th><th class="n">Finishing from</th></tr></thead>
        <tbody>${VILLAS.map(v => { const c = S.villas[v]; const ro = !P.admin; const inp = (k, type) => ro ? `<td class="n">${c[k] ?? ''}</td>` : `<td class="n"><input data-v="${v}" data-k="${k}" type="${type || 'number'}" value="${c[k] ?? ''}" style="width:90px"></td>`;
          return `<tr><td>${v}</td><td class="muted">${c.type === 'U' ? 'up 333' : 'down'}</td>
            <td>${ro ? esc(c.status) : `<select data-v="${v}" data-k="status"><option value="sold" ${c.status === 'sold' ? 'selected' : ''}>sold</option><option value="expected" ${c.status === 'expected' ? 'selected' : ''}>expected</option><option value="mario" ${c.status === 'mario' ? 'selected' : ''}>Mario (D3)</option><option value="none" ${c.status === 'none' ? 'selected' : ''}>not planned</option></select>`}</td>
            ${inp('price')}${inp('saleYear')}${inp('payYears')}${inp('structureYear')}${inp('finishYear')}</tr>`; }).join('')}
        </tbody></table></div>
        <div class="filters" style="margin-top:10px">
          <label class="small muted">Site works year ${P.admin ? `<input id="s-siteYear" type="number" value="${S.siteYear}" style="width:80px">` : S.siteYear}</label>
          <label class="small muted">Fee total ${P.admin ? `<input id="s-feeTotal" type="number" value="${S.fee.total}" style="width:110px">` : usd(S.fee.total)}</label>
          <label class="small muted">Fee from ${P.admin ? `<input id="s-feeStart" type="number" value="${S.fee.startYear}" style="width:80px">` : S.fee.startYear}</label>
          <label class="small muted">D3 land half ${P.admin ? `<input id="s-d3LandHalf" type="number" value="${S.d3LandHalf}" style="width:100px">` : usd(S.d3LandHalf)}</label>
          ${P.admin ? '<button class="btn ap" onclick="Plan.saveSettings()">Save assumptions</button>' : ''}
        </div>
        <div class="note">U2’s money follows Jean’s instalment schedule in Odoo (received to date, then the due dates). An expected villa is paid in equal yearly parts from its sale year; its structure is built in the sale year unless set otherwise, finishing over the two years after.</div>
      </div>`;
  }

  async function saveSettings() {
    const villas = {};
    document.querySelectorAll('[data-v]').forEach(i => { const v = i.dataset.v, k = i.dataset.k; villas[v] = villas[v] || { ...P.settings.villas[v] }; villas[v][k] = i.type === 'number' ? (i.value === '' ? null : +i.value) : i.value; });
    const settings = { villas, siteYear: +document.getElementById('s-siteYear').value, d3LandHalf: +document.getElementById('s-d3LandHalf').value,
      fee: { ...P.settings.fee, total: +document.getElementById('s-feeTotal').value, startYear: +document.getElementById('s-feeStart').value } };
    try { await Admin.api('POST', '/api/ajaltoun/plan/settings', { settings }); await load(); window.renderTab && renderTab(); } catch (e) { alert('Could not save: ' + e.message); }
  }

  // planned money out per year in the current scenario (the Accounts tab's cash-flow facts use it)
  function yearOut() { if (!P) return null; const R = plan(); const o = {}; for (const y of R.years) o[y] = R.tot(R.out, y); return o; }
  window.Plan = { load, renderBudget, renderPlan, yearOut, get P() { return P; },
    setTab: t => { tab = t; window.renderTab && renderTab(); }, setScenario: s => { scenario = s; window.renderTab && renderTab(); },
    edit: id => { editing = id || ''; window.renderTab && renderTab(); },
    toggleDiv: k => { openDivs.has(k) ? openDivs.delete(k) : openDivs.add(k); window.renderTab && renderTab(); },
    foldAll: on => { for (const i of P.items) { const k = i.type + ':' + (i.bill == null || i.bill === '' ? null : +i.bill); on ? openDivs.add(k) : openDivs.delete(k); } window.renderTab && renderTab(); }, useRef, closeEdit, editKey, liveTotal, save, remove, saveSettings };
})();
