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

async function build(ctx) {
  const { odooCall, db, TEAM_ID } = ctx;
  const [pays, bills] = await Promise.all([
    odooCall('account.payment', 'search_read', [[['partner_id', '=', PARTNER], ['company_id', '=', COMPANY], ['state', 'in', ['paid', 'in_process', 'posted']]]],
      { fields: ['name', 'date', 'amount', 'memo', 'journal_id', 'move_id', 'is_reconciled', 'reconciled_bill_ids', 'payment_type', 'x_studio_project'], order: 'date, id', context: CTX }),
    odooCall('account.move', 'search_read', [[['partner_id', '=', PARTNER], ['company_id', '=', COMPANY], ['move_type', '=', 'in_invoice'], ['state', '=', 'posted']]],
      { fields: ['name', 'ref', 'date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'], order: 'date, id', context: CTX }),
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
    const collector = hub ? hub.collector : /diesel/i.test(memo) ? 'Dib Mokhtar (Whish)' : /anthony|whish ms/i.test(memo) ? 'Anthony Khalil (Whish)' : CASH_COLLECTOR;
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
    kind: /retention/i.test(b.ref || '') ? 'retention' : /diesel/i.test(b.ref || '') ? 'diesel' : 'excavation' }));
  const totals = {
    paidOdoo: sum(payments), pendingHub: sum(pending), collected: r2(sum(payments) + sum(pending)),
    bills: sum(B.map(b => ({ amount: b.total }))), excavation: sum(B.filter(b => b.kind === 'excavation').map(b => ({ amount: b.total }))),
    diesel: sum(B.filter(b => b.kind === 'diesel').map(b => ({ amount: b.total }))), retention: sum(B.filter(b => b.kind === 'retention').map(b => ({ amount: b.total }))),
    open: sum(B.filter(b => b.kind !== 'retention').map(b => ({ amount: b.residual }))), retentionOpen: sum(B.filter(b => b.kind === 'retention').map(b => ({ amount: b.residual }))),
    unmatched: r2(sum(payments) - sum(B.filter(b => b.kind !== 'retention').map(b => ({ amount: b.total - b.residual })))),
  };
  return { at: new Date().toISOString(), partner: 'Georges EL Hajj', company: 'SHIFT DEVELOPMENT', project: 'Ajaltoun 4193', payments, pending, collectors, journals, bills: B, totals };
}

async function handle(req, res, url, user, ctx) {
  if (url.split('?')[0] === '/api/ajaltoun/excavation' && req.method === 'GET') return json(res, 200, await build(ctx));
  return false;
}
module.exports = { handle };
