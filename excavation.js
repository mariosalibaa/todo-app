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
    return { id: p.id, name: p.name, date: p.date, amount: r2(p.amount), memo, journal: p.journal_id ? p.journal_id[1] : '', journalId: p.journal_id ? p.journal_id[0] : null,
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
  const cost = m3 ? {
    m3, contract: totals.excavation, contractPerM3: r2(totals.excavation / m3),
    dieselDiff: totals.diesel, real: r2(totals.excavation + totals.diesel), realPerM3: r2((totals.excavation + totals.diesel) / m3),
    litres: Math.round(litres), litresPerM3: r2(litres / m3), dieselPaid: r2(dieselPaid), avgPerL: litres ? r2(dieselPaid / litres) : 0, dieselAt080: r2(litres * 0.8),
    retention: totals.retention, retentionPerM3: r2(totals.retention / m3), days: totals.days,
    allIn: r2(totals.excavation + totals.diesel + totals.retention + totals.days), allInPerM3: r2((totals.excavation + totals.diesel + totals.retention + totals.days) / m3),
  } : null;
  // Per cycle (Mario, 2026-09-13): m³, diesel above $0.80 → $/m³ and L/m³, Anthony's cost, Shift's cost. Cycle 1 (till 13-3,
  // 2,500 m³): Anthony paid the diesel himself, at or below $0.80/L — no diesel bill, litres unknown.
  const cyc = {};
  const cycOf = ref => { const m = (ref || '').match(/EXC(?:AVATION)?-(\d+)(R|D)?\b/i); return m ? { n: +m[1], kind: m[2] ? m[2].toUpperCase() : '' } : null; };
  const litresOf = {}; for (const l of dl) { const b = bills.find(x => (x.invoice_line_ids || []).includes(l.id)); if (b) litresOf[b.id] = (litresOf[b.id] || 0) + (+l.quantity || 0); }
  for (const b of B) {
    const c = cycOf(b.ref); if (!c) continue;
    const row = (cyc[c.n] ||= { n: c.n, till: '', m3: 0, totalM3: 0, contract: 0, retention: 0, diesel: 0, litres: 0, fills: '' });
    const mm = b.ref.match(/([\d,\.]+)\s*m3 of ([\d,\.]+)\s*m3/); if (mm) { row.m3 = +mm[1].replace(/,/g, ''); row.totalM3 = +mm[2].replace(/,/g, ''); }
    if (c.kind === 'D') { row.diesel += b.total; row.litres += litresOf[b.id] || 0; row.fills = (b.ref.match(/\(([\d\-]+\.\.[\d\-]+)/) || [])[1] || ''; }
    else if (c.kind === 'R') row.retention += b.total;
    else { row.contract += b.total; row.till = (b.ref.match(/till\s+([\d\-]+)/) || [])[1] || ''; }
  }
  const cycles = Object.values(cyc).sort((a, b) => a.n - b.n).map(c => ({ ...c,
    anthonyPerM3: c.m3 ? r2(c.contract / c.m3) : 0, dieselPerM3: c.m3 ? r2(c.diesel / c.m3) : 0, litresPerM3: c.m3 ? r2(c.litres / c.m3) : 0,
    shiftPerM3: c.m3 ? r2((c.contract + c.diesel) / c.m3) : 0, note: c.n === 1 ? 'diesel paid by Anthony (at or below $0.80/L)' : !c.diesel ? 'no fills in this cycle' : '' }));
  return { at: new Date().toISOString(), partner: 'Georges EL Hajj', company: 'SHIFT DEVELOPMENT', project: 'Ajaltoun 4193', payments, pending, collectors, journals, bills: B, totals, cost, cycles };
}

async function handle(req, res, url, user, ctx) {
  if (url.split('?')[0] === '/api/ajaltoun/excavation' && req.method === 'GET') return json(res, 200, await build(ctx));
  return false;
}
module.exports = { handle };
