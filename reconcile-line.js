// Reconcile the Odoo payment behind a hub line with the partner's open documents (Mario, 2026-09-13: "an icon
// that allows us to reconcile the open transaction"). Mounted by server.js in the accounting chain.
//
//   GET  /api/accounting/accounts/<id>/tx/<txId>/reconcile          the payment + the partner's open bills / invoices
//   POST /api/accounting/accounts/<id>/tx/<txId>/reconcile  { moveIds: [] }   reconcile with those, oldest first
//
// A supplier payment (money out) meets vendor bills, a customer payment (money in) meets customer invoices, in
// the payment's own company. Reconciling is pairwise on the payable / receivable lines, so a payment bigger than
// a document spills into the next one (partial), and what is left stays open on the payment. Afterwards the
// line's project is pushed onto the documents the way a project change does.

const bills = require('./ledger-bills');
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const ALL = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const PAY_ACCTS = ['liability_payable', 'asset_receivable'];

async function paymentOf(odooCall, t) {
  const won = t.odoo && (t.odoo.matches || []).find(x => x.chosen);
  const ids = [t.booked && t.booked.payment && t.booked.payment.id, t.bookedMove && t.bookedMove.payment && t.bookedMove.payment.id].filter(Number.isInteger);
  const moveIds = [won && won.moveId, t.bookedMove && t.bookedMove.kind === 'payment' && t.bookedMove.id].filter(Number.isInteger);
  if (!ids.length && !moveIds.length) return null;
  const rows = await odooCall('account.payment', 'search_read', [['|', ['id', 'in', ids], ['move_id', 'in', moveIds]]],
    { fields: ['name', 'date', 'amount', 'payment_type', 'partner_type', 'partner_id', 'company_id', 'journal_id', 'move_id', 'reconciled_bill_ids', 'reconciled_invoice_ids', 'is_reconciled'], context: ALL, limit: 1 });
  return rows[0] || null;
}
async function payLine(odooCall, moveId, ctx) {
  const ls = await odooCall('account.move.line', 'search_read', [[['move_id', '=', moveId], ['account_id.account_type', 'in', PAY_ACCTS]]], { fields: ['id', 'amount_residual', 'account_id'], context: ctx, limit: 1 });
  return ls[0] || null;
}

async function handle(req, res, url, user, ctx) {
  const m = url.split('?')[0].match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)\/reconcile$/);
  if (!m) return false;
  const { db, TEAM_ID, odooCall } = ctx;
  const accounts = require('./accounts');
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const account = await accounts.resolve(ws, m[1]);
  if (!account) return json(res, 404, { error: 'no such account' });
  const col = accounts.txCol(account);
  const snap = await col.doc(m[2]).get();
  if (!snap.exists) return json(res, 404, { error: 'no such line' });
  const t = { id: m[2], ...snap.data() };
  const p = await paymentOf(odooCall, t);
  if (!p) return json(res, 400, { error: 'this line has no Odoo payment behind it — book it first' });
  const co = p.company_id[0], octx = { allowed_company_ids: [co], company_id: co };
  const out = p.payment_type === 'outbound';
  const types = out ? ['in_invoice', 'in_refund'] : ['out_invoice', 'out_refund'];
  const pl = await payLine(odooCall, p.move_id[0], octx);
  const residual = pl ? Math.abs(pl.amount_residual) : 0;
  const payment = { id: p.id, name: p.name, date: p.date, amount: p.amount, residual, partner: p.partner_id ? p.partner_id[1] : '', partnerId: p.partner_id ? p.partner_id[0] : null, company: p.company_id[1], journal: p.journal_id ? p.journal_id[1] : '', direction: out ? 'out' : 'in', reconciled: (p.reconciled_bill_ids || []).length + (p.reconciled_invoice_ids || []).length };

  if (req.method === 'GET') {
    const docs = p.partner_id ? await odooCall('account.move', 'search_read', [[['partner_id', '=', p.partner_id[0]], ['company_id', '=', co], ['move_type', 'in', types], ['state', '=', 'posted'], ['amount_residual', '>', 0]]],
      { fields: ['name', 'ref', 'date', 'invoice_date_due', 'amount_total', 'amount_residual', 'move_type'], order: 'date, id', context: octx }) : [];
    return json(res, 200, { payment, open: docs.map(d => ({ id: d.id, name: d.name, ref: d.ref || '', date: d.date, due: d.invoice_date_due, total: d.amount_total, residual: d.amount_residual, type: d.move_type })) });
  }
  if (req.method !== 'POST') return false;
  const b = await readBody(req);
  const ids = (b.moveIds || []).map(Number).filter(Boolean);
  if (!ids.length) return json(res, 400, { error: 'pick at least one document' });
  if (!pl || residual < 0.005) return json(res, 400, { error: `${p.name} has nothing left to apply` });
  const docs = await odooCall('account.move', 'read', [ids, ['name', 'date', 'amount_residual', 'partner_id', 'company_id', 'move_type', 'state']], { context: octx });
  const done = [];
  for (const d of docs.sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id)) {
    if (d.state !== 'posted' || !types.includes(d.move_type) || d.company_id[0] !== co) { done.push({ name: d.name, skipped: 'not an open ' + (out ? 'bill' : 'invoice') + ' of this company' }); continue; }
    if (d.partner_id && p.partner_id && d.partner_id[0] !== p.partner_id[0]) { done.push({ name: d.name, skipped: 'another partner' }); continue; }
    const left = Math.abs((await odooCall('account.move.line', 'read', [[pl.id], ['amount_residual']], { context: octx }))[0].amount_residual);
    if (left < 0.005) { done.push({ name: d.name, skipped: 'the payment is used up' }); continue; }
    const dl = await payLine(odooCall, d.id, octx);
    if (!dl || Math.abs(dl.amount_residual) < 0.005) { done.push({ name: d.name, skipped: 'nothing open on it' }); continue; }
    const before = Math.abs(dl.amount_residual);
    await odooCall('account.move.line', 'reconcile', [[dl.id, pl.id]], { context: octx });
    const after = Math.abs((await odooCall('account.move.line', 'read', [[dl.id], ['amount_residual']], { context: octx }))[0].amount_residual);
    done.push({ name: d.name, applied: Math.round((before - after) * 100) / 100, stillOpen: Math.round(after * 100) / 100 });
  }
  const leftNow = Math.abs((await odooCall('account.move.line', 'read', [[pl.id], ['amount_residual']], { context: octx }))[0].amount_residual);
  // the hub line follows: the check re-reads the payment's reconciled documents; the project goes onto them
  let odooAnalytic = null;
  try {
    const fresh = await odooCall('account.payment', 'read', [[p.id], ['reconciled_bill_ids', 'reconciled_invoice_ids']], { context: octx });
    const docIds = [...(fresh[0].reconciled_bill_ids || []), ...(fresh[0].reconciled_invoice_ids || [])];
    const names = docIds.length ? await odooCall('account.move', 'read', [docIds, ['name', 'ref']], { context: octx }) : [];
    const won = t.odoo && (t.odoo.matches || []).find(x => x.chosen);
    if (won) {
      won.docs = [...new Set([...(won.docs || []).filter(x => !names.some(nm => x.startsWith(nm.name))), ...names.map(nm => nm.ref ? `${nm.name} (${nm.ref})` : nm.name)])];
      won.docIds = { ...(won.docIds || {}), ...Object.fromEntries(names.map(nm => [nm.ref ? `${nm.name} (${nm.ref})` : nm.name, nm.id])) };
      await col.doc(t.id).set({ odoo: t.odoo, updatedAt: new Date().toISOString(), updatedBy: user.email || user.uid }, { merge: true });
    }
    if (t.analyticId) odooAnalytic = await bills.pushAnalytic({ odooCall }, account, { ...t, odoo: t.odoo });
  } catch (e) { odooAnalytic = { error: String(e.message || e).slice(0, 200) }; }
  return json(res, 200, { payment: { ...payment, residual: Math.round(leftNow * 100) / 100 }, done, odooAnalytic });
}
module.exports = { handle };
