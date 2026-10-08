// Suppliers — one supplier across every company, the way Mario checks a statement of account (2026-10-08:
// "if I want to see Solaris or Tchaghlassian or Attal on the hub, from where?"). Odoo keeps cash accounts
// apart from partners, and the hub's Accounts page follows that: a supplier is only a column on the lines.
// This page is the partner's side: his bills, returns and payments in every company, the open balance per
// company, the hub lines that name him (whoever paid), and his latest statement of account next to it.
// Mounted by server.js under /api/suppliers/*; ctx = { db, admin, TEAM_ID, odooCall, access }.
//
//   GET  /api/suppliers/list[?fresh=1]          every partner with a posted vendor bill: bills, open per company, last date
//   GET  /api/suppliers/one?id=<partner id>      his moves, payments, hub lines, statements
//   POST /api/suppliers/<id>/statement           { name, mime, dataBase64, asOf, balance, note } → saved on the supplier
//   GET  /api/suppliers/<id>/statement/<fileId>  the PDF / image itself (cookie on GET, like every hub file)
//   DELETE /api/suppliers/<id>/statement/<fileId>

const acc = require('./accounts');
const files = require('./hub-files');

const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const CACHE_MS = 5 * 60000;
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const readBody = (req, max = 35e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});
const now = () => new Date().toISOString();
const r2 = n => +(+n || 0).toFixed(2);
let listCache = { at: 0, data: null };

// every partner with a posted vendor bill or refund: how many, the total, what is still open — per company
async function list(odooCall, fresh) {
  if (!fresh && listCache.data && Date.now() - listCache.at < CACHE_MS) return listCache.data;
  const groups = await odooCall('account.move', 'read_group', [[['move_type', 'in', ['in_invoice', 'in_refund']], ['state', '=', 'posted']],
    ['amount_total_signed:sum', 'amount_residual_signed:sum', 'invoice_date:max'], ['partner_id', 'company_id']], { lazy: false, context: CTX });
  const by = {};
  for (const g of groups) {
    if (!g.partner_id) continue;
    const p = by[g.partner_id[0]] = by[g.partner_id[0]] || { id: g.partner_id[0], name: g.partner_id[1], bills: 0, total: 0, open: 0, last: '', companies: [] };
    const co = g.company_id ? g.company_id[1] : '';
    // vendor bills are negative in "signed" terms (money going out): flip them so the page reads what the supplier reads
    const total = r2(-(g.amount_total_signed || 0)), open = r2(-(g.amount_residual_signed || 0));
    p.bills += g.__count || 0; p.total = r2(p.total + total); p.open = r2(p.open + open);
    const last = g.invoice_date || ''; if (last > p.last) p.last = last;
    p.companies.push({ company: co, companyId: g.company_id ? g.company_id[0] : 0, bills: g.__count || 0, total, open, currency: g.company_id && g.company_id[0] === 8 ? 'LBP' : 'USD' });
  }
  const suppliers = Object.values(by).sort((a, b) => a.last < b.last ? 1 : -1);
  listCache = { at: Date.now(), data: { pulledAt: now(), suppliers } };
  return listCache.data;
}

// the supplier's documents in Odoo, every company: bills and returns, then the payments that touched him
async function odooSide(odooCall, id) {
  const moves = await odooCall('account.move', 'search_read', [[['partner_id', '=', id], ['move_type', 'in', ['in_invoice', 'in_refund']], ['state', '!=', 'cancel']]],
    { fields: ['name', 'ref', 'date', 'invoice_date', 'invoice_date_due', 'state', 'payment_state', 'move_type', 'amount_total', 'amount_residual', 'currency_id', 'company_id', 'message_main_attachment_id', 'invoice_line_ids'],
      order: 'invoice_date desc, id desc', limit: 2000, context: { ...CTX, active_test: false } });
  const payments = await odooCall('account.payment', 'search_read', [[['partner_id', '=', id], ['state', 'in', ['paid', 'in_process', 'posted']]]],
    { fields: ['date', 'amount', 'journal_id', 'memo', 'company_id', 'payment_type', 'reconciled_bill_ids', 'currency_id', 'name', 'x_studio_project'], order: 'date desc', limit: 1000, context: CTX });
  // the project rides on the lines (analytic_distribution), not on the bill: read it off the first product line
  const lineIds = moves.flatMap(m => (m.invoice_line_ids || []).slice(0, 1));
  const projOf = {};
  if (lineIds.length) {
    const ls = await odooCall('account.move.line', 'search_read', [[['id', 'in', lineIds]]], { fields: ['move_id', 'analytic_distribution'], context: CTX });
    const ids = [...new Set(ls.flatMap(l => Object.keys(l.analytic_distribution || {}).flatMap(k => k.split(','))))].map(Number).filter(Boolean);
    const names = {}; if (ids.length) for (const a of await odooCall('account.analytic.account', 'search_read', [[['id', 'in', ids]]], { fields: ['name'], context: { ...CTX, active_test: false } })) names[a.id] = a.name;
    for (const l of ls) { const k = Object.keys(l.analytic_distribution || {})[0]; if (k) projOf[l.move_id[0]] = k.split(',').map(x => names[+x]).filter(Boolean).join(' / '); }
  }
  const partner = (await odooCall('res.partner', 'search_read', [[['id', '=', id]]], { fields: ['name', 'phone', 'email', 'supplier_rank', 'comment'], context: { ...CTX, active_test: false } }))[0] || {};
  return {
    partner: { id, name: partner.name || '', phone: partner.phone || '', email: partner.email || '' },
    moves: moves.map(m => ({ id: m.id, name: m.name, ref: m.ref || '', date: m.invoice_date || m.date, due: m.invoice_date_due || '', state: m.state, payment: m.payment_state,
      kind: m.move_type === 'in_refund' ? 'return' : 'bill', total: r2(m.amount_total), open: r2(m.amount_residual), currency: m.currency_id ? m.currency_id[1] : 'USD',
      company: m.company_id ? m.company_id[1] : '', companyId: m.company_id ? m.company_id[0] : 0, scan: !!m.message_main_attachment_id, project: projOf[m.id] || '' })),
    payments: payments.map(p => ({ id: p.id, name: p.name, date: p.date, amount: r2(p.amount), journal: p.journal_id ? p.journal_id[1] : '', memo: p.memo || '', company: p.company_id ? p.company_id[1] : '',
      type: p.payment_type, bills: (p.reconciled_bill_ids || []).length, currency: p.currency_id ? p.currency_id[1] : 'USD', project: p.x_studio_project ? p.x_studio_project[1] : '' })),
  };
}

// every hub line that names him — whoever's ledger it sits on, whoever paid
async function hubSide(ctx, id) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const accounts = await acc.listAccounts(ws);
  const out = [];
  await Promise.all(accounts.map(async a => {
    let docs = [];
    try { docs = (await acc.txCol(await acc.resolve(ws, a.id)).where('partnerId', '==', id).get()).docs; } catch (e) { return; }
    for (const d of docs) {
      const t = d.data(); if (t.excluded && !t.review) continue;
      out.push({ account: a.name, accountId: a.id, id: t.id, date: t.date, description: String(t.description || '').slice(0, 140), debit: r2(t.debit), credit: r2(t.credit),
        company: t.company || '', project: t.analyticName || '', ref: t.ref || '', src: t.src || '', state: t.bookedMove ? 'booked' : t.waAccepted ? 'accepted' : t.review ? 'waiting' : '',
        move: t.bookedMove ? t.bookedMove.name || '' : '', moveId: t.bookedMove ? t.bookedMove.id || 0 : 0, paidBy: t.paidBy || '' });
    }
  }));
  return out.sort((a, b) => a.date < b.date ? 1 : -1);
}

const stmCol = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('supplierStatements');

async function handle(req, res, url, user, ctx) {
  const { odooCall } = ctx;
  const path = url.split('?')[0], q = new URL(req.url, 'http://x').searchParams;
  const who = (user && user.email) || 'hub';
  let m;
  if (path === '/api/suppliers/list' && req.method === 'GET') return json(res, 200, await list(odooCall, q.get('fresh') === '1'));
  if (path === '/api/suppliers/one' && req.method === 'GET') {
    const id = +q.get('id'); if (!id) return json(res, 400, { error: 'id required' });
    const [o, hub, st] = await Promise.all([odooSide(odooCall, id), hubSide(ctx, id), stmCol(ctx).doc(String(id)).get()]);
    const openBy = {};
    for (const mv of o.moves) if (mv.state === 'posted' && mv.open) { const k = mv.company; openBy[k] = openBy[k] || { company: k, open: 0, currency: mv.currency, n: 0 }; openBy[k].open = r2(openBy[k].open + (mv.kind === 'return' ? -mv.open : mv.open)); openBy[k].n++; }
    return json(res, 200, { pulledAt: now(), ...o, hub, openBy: Object.values(openBy), statements: (st.exists && st.data().files) || [] });
  }
  if ((m = path.match(/^\/api\/suppliers\/(\d+)\/statement$/)) && req.method === 'POST') {
    if (!ctx.access || !ctx.access.admin) return json(res, 403, { error: 'admin' });
    const b = await readBody(req);
    const buf = Buffer.from(String(b.dataBase64 || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return json(res, 400, { error: 'no file' });
    if (buf.length > 25e6) return json(res, 400, { error: 'the file is larger than 25 MB' });
    const mime = String(b.mime || 'application/pdf').split(';')[0].trim();
    if (!/^(application\/pdf|image\/(jpeg|png|webp|heic))$/.test(mime)) return json(res, 400, { error: 'a PDF or a photo, please' });
    const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1];
    const fileId = Date.now().toString(36);
    const file = await files.saveFile(ctx, { buf, mime, name: b.name || `statement.${ext}`, key: `suppliers/${m[1]}/${fileId}.${ext}`, who, meta: { supplier: m[1] } });
    const rec = { ...file, asOf: String(b.asOf || '').slice(0, 10), balance: b.balance === '' || b.balance == null ? null : r2(b.balance), note: String(b.note || '').slice(0, 200) };
    const ref = stmCol(ctx).doc(m[1]); const cur = (await ref.get()).data() || {};
    const list = [rec, ...(cur.files || [])];
    await ref.set({ files: list, updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, { statements: list });
  }
  if ((m = path.match(/^\/api\/suppliers\/(\d+)\/statement\/([\w-]+)$/)) && req.method === 'GET') {
    const d = (await stmCol(ctx).doc(m[1]).get()).data(); const f = d && (d.files || []).find(x => x.id === m[2]);
    if (!f) return json(res, 404, { error: 'no such statement' });
    await files.streamFile(ctx, f, res, req); return true;
  }
  if ((m = path.match(/^\/api\/suppliers\/(\d+)\/statement\/([\w-]+)$/)) && req.method === 'DELETE') {
    if (!ctx.access || !ctx.access.admin) return json(res, 403, { error: 'admin' });
    const ref = stmCol(ctx).doc(m[1]); const d = (await ref.get()).data(); const f = d && (d.files || []).find(x => x.id === m[2]);
    if (!f) return json(res, 404, { error: 'no such statement' });
    try { await files.deleteFile(ctx, f); } catch (e) { console.error('supplier statement delete', e.message); }
    const left = (d.files || []).filter(x => x.id !== m[2]);
    await ref.set({ files: left, updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, { statements: left });
  }
  return false;
}
module.exports = { handle, list };
