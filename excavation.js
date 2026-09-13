// Excavation collections — Georges EL Hajj on Ajaltoun 4193 (Mario, 2026-09-13: "a dashboard showing the amount
// collected, by Dib Mokhtar, by Anthony, and from which cash or bank account").
// Mounted by server.js in the Ajaltoun chain (app 'ajaltoun'); needs ctx = { db, TEAM_ID, odooCall }.
//
//   GET /api/ajaltoun/excavation   { bills, payments, collectors, journals, pending, totals }
//
// Money reaches Georges three ways: Anthony Khalil (+96171800980) and Dib Mokhtar (+96171324324) collect through
// Whish, and cash goes out of the Neo / Mario cash boxes. The Odoo payment says WHICH ACCOUNT paid (its journal);
// the hub's Whish line says WHO COLLECTED (the phone). A Whish line matched to its Odoo payment ties the two.
// Whish lines not yet booked in Odoo are listed as pending, so the dashboard never hides money already sent.

const PARTNER = 313, COMPANY = 10;
// Mario, 2026-09-13: Whish lines are named by the phone that received them; cash out of the Neo / Mario boxes goes to Anthony in hand
const COLLECTORS = { '96171800980': 'Anthony Khalil (Whish)', '96171324324': 'Dib Mokhtar (Whish)' };
const CASH_COLLECTOR = 'Anthony Khalil (cash)';
const CTX = { allowed_company_ids: [COMPANY] };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const r2 = n => Math.round((+n || 0) * 100) / 100;
// bill refs (Mario, 2026-09-13, short form): AJ4193-EXC-n (till d-m · Xm3 of Ym3) · -nD = diesel (fills · N L · …) · -nR = retention · -DAYS
const isDiesel = ref => /diesel/i.test(ref || '') || /EXC(?:AVATION)?-\d+D\b/i.test(ref || '');

async function build(ctx) {
  const { odooCall, db, TEAM_ID } = ctx;
  const [pays, bills] = await Promise.all([
    odooCall('account.payment', 'search_read', [[['partner_id', '=', PARTNER], ['company_id', '=', COMPANY], ['state', 'in', ['paid', 'in_process', 'posted']]]],
      { fields: ['name', 'date', 'amount', 'memo', 'journal_id', 'move_id', 'is_reconciled', 'reconciled_bill_ids', 'payment_type', 'x_studio_project'], order: 'date, id', context: CTX }),
    odooCall('account.move', 'search_read', [[['partner_id', '=', PARTNER], ['company_id', '=', COMPANY], ['move_type', '=', 'in_invoice'], ['state', '=', 'posted']]],
      { fields: ['name', 'ref', 'date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'invoice_line_ids'], order: 'date, id', context: CTX }),
  ]);
  // the hub's Whish lines from the two collectors, with the Odoo payment each is matched to
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const wa = await ws.collection('whishAccounts').get();
  const lines = [];
  for (const d of wa.docs) {
    const q = await d.ref.collection('tx').where('phone', 'in', Object.keys(COLLECTORS)).get();
    for (const x of q.docs) { const t = x.data(); if (t.excluded || !(t.debit > 0)) continue;
      const won = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
      lines.push({ id: x.id, date: t.date, amount: r2(t.debit), phone: t.phone, collector: COLLECTORS[t.phone], desc: t.description || '', note: t.note || '',
        moveId: (won && won.moveId) || (t.booked && t.booked.moveId) || (t.bookedMove && t.bookedMove.id) || null, payName: (won && won.move) || (t.booked && t.booked.move) || '' }); }
  }
  const byMove = Object.fromEntries(lines.filter(l => l.moveId).map(l => [l.moveId, l]));
  const byName = Object.fromEntries(lines.filter(l => l.payName).map(l => [l.payName, l]));
  const payments = pays.map(p => {
    const hub = byMove[p.move_id ? p.move_id[0] : 0] || byName[p.name] || null;
    const memo = String(p.memo || '');
    // who collected: the hub line's phone when tied; else the memo's word (diesel = Dib Mokhtar, anthony = Anthony); else cash to Georges
    const collector = hub ? hub.collector : /dib mokhtar/i.test(memo) ? 'Dib Mokhtar (Whish)' : /anthony khalil \(cash\)/i.test(memo) ? CASH_COLLECTOR : /anthony khalil/i.test(memo) ? 'Anthony Khalil (Whish)' : /diesel/i.test(memo) ? 'Dib Mokhtar (Whish)' : /anthony|whish ms/i.test(memo) ? 'Anthony Khalil (Whish)' : CASH_COLLECTOR;
    // money back from the collector (an inbound payment) counts against what was collected (Mario, 2026-09-13: 33,472 vs 35,608)
    return { id: p.id, name: p.name, date: p.date, amount: r2(p.payment_type === 'inbound' ? -p.amount : p.amount), memo, journal: p.journal_id ? p.journal_id[1] : '', journalId: p.journal_id ? p.journal_id[0] : null,
      reconciled: !!(p.reconciled_bill_ids || []).length, bills: (p.reconciled_bill_ids || []).length, collector, hubLine: hub ? hub.id : null, project: p.x_studio_project ? p.x_studio_project[1] : '' };
  });
  const pending = lines.filter(l => !l.moveId && !byName[l.payName]).filter(l => !pays.some(p => p.name === l.payName));
  const sum = arr => r2(arr.reduce((s, x) => s + x.amount, 0));
  const group = (arr, key) => { const g = {}; for (const x of arr) (g[x[key]] ||= { key: x[key], amount: 0, n: 0, reconciled: 0 }).amount = r2((g[x[key]].amount) + x.amount), g[x[key]].n++, g[x[key]].reconciled += x.reconciled ? x.amount : 0; return Object.values(g).sort((a, b) => b.amount - a.amount); };
  const collectors = group(payments, 'collector');
  for (const c of collectors) { const pend = pending.filter(l => l.collector === c.key); c.pending = sum(pend); c.pendingN = pend.length; }
  for (const c of pending.filter(l => !collectors.some(c => c.key === l.collector))) collectors.push({ key: c.collector, amount: 0, n: 0, reconciled: 0, pending: sum(pending.filter(l => l.collector === c.collector)), pendingN: pending.filter(l => l.collector === c.collector).length });
  const journals = group(payments, 'journal');
  const B = bills.map(b => ({ id: b.id, name: b.name, ref: b.ref || '', date: b.date, due: b.invoice_date_due, total: r2(b.amount_total), residual: r2(b.amount_residual), state: b.payment_state,
    kind: /retention/i.test(b.ref || '') ? 'retention' : isDiesel(b.ref) ? 'diesel' : /DAYS|day rate/i.test(b.ref || '') ? 'days' : 'excavation' }));
  // the diesel bills carry one line per fill "d-m diesel <L>L*<$/L>" priced at ($/L − 0.80): litres and the real price come from there
  const dieselIds = bills.filter(b => isDiesel(b.ref)).flatMap(b => b.invoice_line_ids || []);
  const dl = dieselIds.length ? await odooCall('account.move.line', 'read', [dieselIds, ['name', 'quantity', 'price_unit', 'price_subtotal']], { context: CTX }) : [];
  let litres = 0, dieselPaid = 0;
  for (const l of dl) { const L = +l.quantity || 0; const m = (l.name || '').match(/L\s*\*\s*-?([\d.]+)/i); const perL = m ? +m[1] : (+l.price_unit + 0.8); litres += L; dieselPaid += L * perL; }
  // the excavated volume: the largest "N m3 total" written on a certificate
  const m3 = Math.max(0, ...B.map(b => +(((b.ref.match(/of\s*([\d,\.]+)\s*m3/) || b.ref.match(/([\d,\.]+)\s*m3 total/) || [])[1] || '0').replace(/,/g, ''))));
  const totals = {
    paidOdoo: sum(payments), pendingHub: sum(pending), collected: r2(sum(payments) + sum(pending)),
    bills: sum(B.map(b => ({ amount: b.total }))), excavation: sum(B.filter(b => b.kind === 'excavation').map(b => ({ amount: b.total }))), days: sum(B.filter(b => b.kind === 'days').map(b => ({ amount: b.total }))),
    diesel: sum(B.filter(b => b.kind === 'diesel').map(b => ({ amount: b.total }))), retention: sum(B.filter(b => b.kind === 'retention').map(b => ({ amount: b.total }))),
    open: sum(B.filter(b => b.kind !== 'retention').map(b => ({ amount: b.residual }))), retentionOpen: sum(B.filter(b => b.kind === 'retention').map(b => ({ amount: b.residual }))),
    unmatched: r2(sum(payments) - sum(B.filter(b => b.kind !== 'retention').map(b => ({ amount: b.total - b.residual })))),
  };
  // Cost per m³ (Mario, 2026-09-13): Anthony charges $4/$5 per m³ with diesel at $0.80/L inside his price; Shift pays the
  // diesel above $0.80/L on top. Retention is Georges' commission (he holds the contract, Anthony digs) and the day rate is
  // days not volume — both shown apart, outside the per-m³ figures.
  // the commission (retention) is part of the main contract price (Mario, 2026-09-13): $4 + $0.50 on the first 3,500 m³, $5 after
  const contractAll = r2(totals.excavation + totals.retention);
  // Per cycle (Mario, 2026-09-13): m³, diesel above $0.80 → $/m³ and L/m³, Anthony's cost, Shift's cost. Cycle 1 (till 13-3,
  // 2,500 m³): Anthony paid the diesel himself, at or below $0.80/L — no diesel bill, litres unknown.
  const todayBeirut = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const tillDate = till => { const m = (till || '').match(/^(\d+)-(\d+)$/); return m ? `${new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
  const cyc = {};
  const cycOf = ref => { const m = (ref || '').match(/EXC(?:AVATION)?-(\d+)(R|D)?\b/i); return m ? { n: +m[1], kind: m[2] ? m[2].toUpperCase() : '' } : null; };
  const litresOf = {}; for (const l of dl) { const b = bills.find(x => (x.invoice_line_ids || []).includes(l.id)); if (b) litresOf[b.id] = (litresOf[b.id] || 0) + (+l.quantity || 0); }
  for (const b of B) {
    const c = cycOf(b.ref); if (!c) continue;
    const row = (cyc[c.n] ||= { n: c.n, till: '', m3: 0, totalM3: 0, contract: 0, retention: 0, diesel: 0, litres: 0, fills: '' });
    const mm = b.ref.match(/([\d,\.]+)\s*m3 of ([\d,\.]+)\s*m3/); if (mm) { row.m3 = +mm[1].replace(/,/g, ''); row.totalM3 = +mm[2].replace(/,/g, ''); }
    if (c.kind === 'D') { row.diesel += b.total; row.litres += litresOf[b.id] || 0; row.fills = (b.ref.match(/\(([\d\-]+\.\.[\d\-]+)/) || [])[1] || ''; }
    else if (c.kind === 'R') row.retention += b.total;
    else { row.contract += b.total; row.till = (b.ref.match(/till\s+([\d\-]+)/) || [])[1] || ''; row.certDate = b.date; }
  }
  // Mario's hand summary per cycle (2026-09-13): litres → L/m³ × $0.80 = what diesel eats out of Anthony's $5 (his net is the rest);
  // and the cash Mario paid inside the cycle (diesel + Anthony) against the cycle's bills → position after each cycle
  const sorted = Object.values(cyc).sort((a, b) => a.n - b.n);
  let prevDate = '', pos = 0;
  const cycles = sorted.map((c, i) => {
    const upTo = i === sorted.length - 1 ? '9999-12-31' : c.certDate || '9999-12-31';
    const paid = r2(payments.filter(p => p.date > prevDate && p.date <= upTo).reduce((t, p) => t + p.amount, 0));
    prevDate = c.certDate || prevDate;
    const billed = r2(c.contract + c.retention + c.diesel);
    pos = r2(pos + billed - paid);
    return { ...c, contractPerM3: c.m3 ? r2((c.contract + c.retention) / c.m3) : 0, anthonyPerM3: c.m3 ? r2(c.contract / c.m3) : 0, dieselPerM3: c.m3 ? r2(c.diesel / c.m3) : 0, litresPerM3: c.m3 ? r2(c.litres / c.m3) : 0,
      dieselAt080PerM3: c.m3 ? r2(c.litres * 0.8 / c.m3) : 0, anthonyNetPerM3: c.m3 ? r2((c.contract - c.litres * 0.8) / c.m3) : 0,
      shiftPerM3: c.m3 ? r2((c.contract + c.retention + c.diesel) / c.m3) : 0, paid, billed, position: pos,
      open: tillDate(c.till) > todayBeirut(),   // the cycle is still being dug: its m³ are billed but not yet executed (Mario, 2026-09-13)
      note: c.n === 1 ? 'diesel paid by Anthony (at or below $0.80/L)' : !c.diesel ? 'no fills in this cycle' : '' }; });
  // Match with Odoo (Mario, 2026-09-13): the partner ledger as Odoo sums it — every posted payable / receivable line of
  // Georges in every company — so the hub shows the same debit, credit and balance as Reporting → Partner Ledger.
  const ll = await odooCall('account.move.line', 'search_read', [[['partner_id', '=', PARTNER], ['account_id.account_type', 'in', ['liability_payable', 'asset_receivable']], ['parent_state', '=', 'posted']]],
    { fields: ['date', 'debit', 'credit', 'move_id', 'company_id', 'account_id', 'name'], order: 'date, id', context: { allowed_company_ids: [2, 4, 7, 8, 9, 10] } });
  const known = new Set([...bills.map(b => b.id), ...pays.map(p => p.move_id ? p.move_id[0] : 0)]);
  const sumL = arr => ({ debit: r2(arr.reduce((t, l) => t + l.debit, 0)), credit: r2(arr.reduce((t, l) => t + l.credit, 0)) });
  const allL = sumL(ll);
  const odooMatch = {
    billsTotal: r2(B.reduce((t, b) => t + b.total, 0)), billsCount: B.length, // Odoo's Vendor Payments list nets a vendor refund (money back) against the money out — 35,608 − 636 = 34,972 (Mario, 2026-09-13)
    paymentsTotal: r2(pays.reduce((t, p) => t + (p.payment_type === 'outbound' ? p.amount : -p.amount), 0)), paymentsCount: pays.length,
    ledgerAll: { ...allL, balance: r2(allL.debit - allL.credit) },
    // lines Odoo counts that are not the excavation's bills or payments (another company, another account…)
    others: ll.filter(l => !known.has(l.move_id[0])).map(l => ({ date: l.date, name: l.move_id[1], company: l.company_id[1], account: l.account_id[1], debit: l.debit, credit: l.credit, label: l.name || '' })),
  };
  const firstFuel = Math.min(...cycles.filter(c => c.litres > 0).map(c => c.n));   // a later cycle may carry no bill of its own (fills billed with its neighbour) but Shift still fuelled it
  const m3Shift = cycles.filter(c => c.n >= firstFuel).reduce((t, c) => t + c.m3, 0);
  // L/m³ only means something on cycles Shift fuelled AND finished; the open cycle's m³ are not dug yet, so its litres are
  // a part-way figure. From the finished ones, project what diesel the open cycle(s) still need (Mario, 2026-09-13)
  const closed = cycles.filter(c => c.n >= firstFuel && !c.open), openC = cycles.filter(c => c.open);
  const m3Closed = closed.reduce((t, c) => t + c.m3, 0), litresClosed = closed.reduce((t, c) => t + c.litres, 0), rate = m3Closed ? litresClosed / m3Closed : 0;
  const avgPerL = litres ? dieselPaid / litres : 0;
  const m3Open = openC.reduce((t, c) => t + c.m3, 0), litresOpen = openC.reduce((t, c) => t + c.litres, 0), litresStill = Math.max(0, m3Open * rate - litresOpen);
  const forecast = { m3Open, litresOpen, litresExpected: Math.round(m3Open * rate), litresStill: Math.round(litresStill), costStill: r2(litresStill * avgPerL), diffStill: r2(litresStill * Math.max(0, avgPerL - 0.8)), cycles: openC.map(c => c.n), closedCycles: closed.map(c => c.n) };
  const cost = m3 ? {
    m3, contract: contractAll, contractPerM3: r2(contractAll / m3), anthony: totals.excavation, anthonyPerM3: r2(totals.excavation / m3),
    dieselDiff: totals.diesel, real: r2(contractAll + totals.diesel), realPerM3: r2((contractAll + totals.diesel) / m3),
    // litres are known only where Shift bought the diesel (from cycle 2 on): L/m³ and the diesel $/m³ are over THOSE m³, not the 7,000 (Mario, 2026-09-13)
    litres: Math.round(litres), m3Shift, litresPerM3: m3Shift ? r2(litres / m3Shift) : 0, dieselPaid: r2(dieselPaid), avgPerL: litres ? r2(dieselPaid / litres) : 0, dieselAt080: r2(litres * 0.8),
    dieselAt080PerM3: m3Shift ? r2(litres * 0.8 / m3Shift) : 0, dieselDiffPerM3: m3Shift ? r2(totals.diesel / m3Shift) : 0, m3Anthony: r2(m3 - m3Shift),
    m3Closed, litresClosed: Math.round(litresClosed), rateClosed: r2(rate), forecast,
    retention: totals.retention, retentionPerM3: r2(totals.retention / m3), days: totals.days,
    allIn: r2(contractAll + totals.diesel + totals.days), allInPerM3: r2((contractAll + totals.diesel + totals.days) / m3),
  } : null;
  // Mario's own wording on the cards (title + note per card; the numbers stay live) — Firestore settings/excavationText
  const textDoc = await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('settings').doc('excavationText').get().catch(() => null);
  const text = textDoc && textDoc.exists ? textDoc.data() : {};
  return { at: new Date().toISOString(), partner: 'Georges EL Hajj', company: 'SHIFT DEVELOPMENT', project: 'Ajaltoun 4193', payments, pending, collectors, journals, bills: B, totals, cost, cycles, odooMatch, text };
}

const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', d => s += d).on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }).on('error', no); });
async function handle(req, res, url, user, ctx) {
  if (url.split('?')[0] === '/api/ajaltoun/excavation' && req.method === 'GET') return json(res, 200, await build(ctx));
  if (url.split('?')[0] === '/api/ajaltoun/excavation/text' && req.method === 'PATCH') {   // Mario adjusts a card's wording (2026-09-13)
    if (!ctx.access || !ctx.access.admin) return json(res, 403, { error: 'admin only' });
    const b = await readBody(req); const key = String(b.key || '').replace(/[^\w-]/g, '');
    if (!key) return json(res, 400, { error: 'key' });
    await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('settings').doc('excavationText').set({ [key]: { title: String(b.title || '').slice(0, 120), note: String(b.note || '').slice(0, 400) } }, { merge: true });
    return json(res, 200, { ok: true });
  }
  return false;
}
module.exports = { handle };
