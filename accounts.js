// Cash & bank accounts as first-class objects of the Accounting app.
//
// The Whish page grew a grid, a rules engine and an Odoo matcher around one statement
// account. Every other account — Mario's wallet, Neo, Wise, the workers' cash — wants the
// same grid and the same logic, so an *account* is now a record created from the page
// ("+"), not a module written per bank. Firestore, under workspaces/<team>:
//   accounts/<id>            { id, name, type: 'cash'|'bank', currency, provider,
//                              odooJournals: [{ id, name, companyId, company }],
//                              opening: { date, amount, note }, createdAt, createdBy }
//   accounts/<id>/tx/<txId>  one line: date, description, debit (money out), credit
//                            (money in), partner/company/analytic/note as on Whish,
//                            src: 'odoo' | 'budget' | 'manual' | 'transfer' | 'telegram',
//                            paidBy (who physically paid), excluded/dupOf (a line that
//                            is a second record of another one, kept but not counted)
//   transfers/<id>           { date, fromId, toId, amount, currency, note, fromTxId, toTxId }
//                            one transfer = an OUT line on the source and an IN line on the
//                            destination; never an expense, never an income
//
// The Whish account keeps living in whishAccounts/<no>/tx: resolve() presents it as an
// account like any other, so the old URLs and the folder watcher keep working.
//
// Statement lines carry their own running balance (Whish prints it). Every other account
// is balanced from its opening row: the balance is pinned to `opening.amount` on
// `opening.date`, and lines before that date get the implied history.
//
//   GET    /api/accounting/accounts                      all accounts (Whish included)
//   POST   /api/accounting/accounts                      create { name, type, currency, odooJournals, opening }
//   GET    /api/accounting/accounts/<id>                 one account
//   PATCH  /api/accounting/accounts/<id>                 name / opening / journals
//   GET    /api/accounting/accounts/<id>/tx              lines (date, then id)
//   POST   /api/accounting/accounts/<id>/tx              add a manual line
//   PATCH  /api/accounting/accounts/<id>/tx/<txId>       annotate (same fields as Whish + paidBy, excluded)
//   DELETE /api/accounting/accounts/<id>/tx/<txId>       manual / budget lines only
//   POST   /api/accounting/accounts/<id>/tx-bulk         { items: [{ id, ...fields }] }
//   POST   /api/accounting/accounts/<id>/odoo-check      match lines against the account's Odoo journals
//   POST   /api/accounting/accounts/<id>/import-odoo     pull every line of the account's Odoo journals
//   POST   /api/accounting/accounts/<id>/import-budget   { budgetAccountId } pull the HomeBudget history
//   POST   /api/accounting/accounts/<id>/import-excel    read the account's Excel ledger (local machine only)
//   POST   /api/accounting/accounts/<id>/import-whatsapp read the account's WhatsApp group (local machine only)
//   POST   /api/accounting/accounts/<id>/link-transfers  { loose? } join "from mario" lines with Mario's cash as transfers
//   GET    /api/accounting/whatsapp-groups?q=            the archive's groups, for the ⚙ form
//   GET    /api/accounting/odoo/journals                 the Odoo bank/cash journals, for the "+" form
//   GET    /api/accounting/transfers                     list
//   POST   /api/accounting/transfers                     { date, fromId, toId, amount, note, fromTxId?, toTxId? }
//   PATCH  /api/accounting/transfers/<id>                { date?, amount?, note? }
//   DELETE /api/accounting/transfers/<id>
const acc = require('./accounting');
const ledgers = require('./ledgers');   // the workers' Excel ledgers, WhatsApp groups, transfer linking

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };   // true = handled
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const money = n => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Annotation fields a person may set on any line. The Whish list, plus:
//   paidBy   who physically paid (mario | abed | georges | ziad | mitri | khodr | therese | other)
//   excluded the line is not counted in the balance (a duplicate, a note, a cancelled entry)
//   dupOf    the id of the line this one repeats
const ANNOT = ['note', 'kind', 'analyticId', 'analyticName', 'company', 'companySrc', 'partnerId', 'partnerName', 'partnerSrc',
  'noteSrc', 'kindSrc', 'analyticSrc', 'analyticFrom', 'suggestSkip', 'paidBy', 'paidBySrc', 'excluded', 'dupOf', 'transferId', 'review'];
// Fields of a line a person typed (or Telegram sent). Odoo/statement lines keep theirs.
const LINE = ['date', 'description', 'debit', 'credit', 'ref', 'service'];

const PEOPLE = {
  mario: /\bmario\b/i, abed: /\babed\b|\babdo\b/i, georges: /\bgeorges?\b/i, ziad: /\bziad\b/i,
  mitri: /\bmitri\b|\bmetre\b/i, khodr: /\bkh[ou]d[eo]?r\b|\bkhudr\b/i, therese: /\bth[eé]r[eè]se\b/i,
};
// "paid by abed", "paid_mario", "received by ziad", "- paid by .pdf" (nobody named)
function paidByIn(texts) {
  for (const t of texts) {
    const m = String(t || '').match(/(?:paid|received|payé|pay)[ _-]*(?:by)?[ _-]+([a-zé]+)/i);
    if (!m) continue;
    for (const [who, rx] of Object.entries(PEOPLE)) if (rx.test(m[1])) return who;
  }
  return '';
}
const ownerOf = account => account.owner || Object.keys(PEOPLE).find(k => PEOPLE[k].test(account.name || '')) || '';

// ── Accounts ────────────────────────────────────────────────────────────────
function whishAsAccount(d) {
  const x = d.data();
  return { id: d.id, name: 'Whish · ' + (x.name || d.id), type: 'bank', provider: 'whish', currency: x.currency || 'USD', owner: 'mario',
    statement: true, odooJournalWord: 'whish', odooJournals: [], opening: null, whish: { account: x.account, phone: x.phone, lastUpload: x.lastUpload || '' } };
}
async function listAccounts(ws) {
  const [a, w] = await Promise.all([ws.collection('accounts').get(), ws.collection('whishAccounts').get()]);
  return [...w.docs.map(whishAsAccount), ...a.docs.map(d => ({ id: d.id, ...d.data() }))]
    .sort((x, y) => (x.type === y.type ? 0 : x.type === 'cash' ? -1 : 1) || String(x.name).localeCompare(String(y.name)));
}
// An account by id — from `accounts`, or the Whish account wearing the same coat.
async function resolve(ws, id) {
  const d = await ws.collection('accounts').doc(id).get();
  if (d.exists) return { id, ...d.data(), ref: ws.collection('accounts').doc(id) };
  const w = await ws.collection('whishAccounts').doc(id).get();
  if (w.exists) return { ...whishAsAccount(w), ref: ws.collection('whishAccounts').doc(id) };
  return null;
}
const txCol = a => a.ref.collection('tx');

// ── Odoo helpers ─────────────────────────────────────────────────────────────
let _journalCache = { at: 0, list: [] };
async function odooJournals(odooCall) {
  if (Date.now() - _journalCache.at < 10 * 60000 && _journalCache.list.length) return _journalCache.list;
  const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id', 'name'] });
  const rows = await odooCall('account.journal', 'search_read', [[['type', 'in', ['bank', 'cash']]]],
    { fields: ['id', 'name', 'company_id', 'type', 'currency_id', 'default_account_id'], context: { allowed_company_ids: companies.map(c => c.id) }, order: 'company_id, name' });
  _journalCache = { at: Date.now(), list: rows.map(r => ({
    id: r.id, name: r.name, type: r.type, companyId: r.company_id ? r.company_id[0] : null, company: r.company_id ? r.company_id[1] : '',
    currency: r.currency_id ? r.currency_id[1] : '', accountId: r.default_account_id ? r.default_account_id[0] : null, account: r.default_account_id ? r.default_account_id[1] : ''
  })) };
  return _journalCache.list;
}
// The matcher wants { rows, ctx } like journalsNamed() gives: build it from the account's own journals.
async function journalsOf(odooCall, account) {
  if (!(account.odooJournals || []).length) return null;
  const all = await odooJournals(odooCall);
  const ids = new Set(account.odooJournals.map(j => +j.id));
  const rows = all.filter(j => ids.has(j.id)).map(j => ({ id: j.id, name: j.name, company_id: [j.companyId, j.company], default_account_id: [j.accountId, j.account] }));
  const ctx = { allowed_company_ids: [...new Set(rows.map(r => r.company_id[0]))] };
  return { rows, ctx };
}
const shortCompany = s => String(s || '').replace(/SHIFT GROUP SARL \(USD\)/, 'SARL').replace(/SHIFT GROUP SARL \(LBP\)/, 'SARL LBP').replace(/SHIFT DEVELOPMENT/, 'S DEV').replace(/SHIFT GROUP OFFSHORE SAL/, 'OFFSHORE');

// Every line of the account's Odoo journals becomes a line here. The Odoo side is the
// truth for what it holds — partner, company, the bill it settles, the project on that
// bill — so those land as 'odoo' facts, never as suggestions. Who physically paid is read
// from the attachment names ("… paid by abed.pdf") and the memo, and flagged when it is
// not the account's owner: Cash Mario in Odoo was used as a general cash book.
async function importOdoo(odooCall, account, who) {
  const all = await odooJournals(odooCall);
  const out = { journals: [], lines: 0, added: 0, updated: 0, paidByOthers: 0 };
  const col = txCol(account);
  const existing = {};
  (await col.where('src', '==', 'odoo').get()).docs.forEach(d => { existing[d.id] = d.data(); });
  const owner = ownerOf(account);
  const writes = [];
  for (const j0 of account.odooJournals || []) {
    const j = all.find(x => x.id === +j0.id);
    if (!j || !j.accountId) { out.journals.push({ id: j0.id, error: 'journal not found' }); continue; }
    const ctx = { allowed_company_ids: [j.companyId], company_id: j.companyId };
    const L = await odooCall('account.move.line', 'search_read', [[['account_id', '=', j.accountId], ['parent_state', '!=', 'cancel']]],
      { fields: ['id', 'date', 'name', 'ref', 'debit', 'credit', 'amount_currency', 'partner_id', 'move_id', 'payment_id', 'journal_id', 'parent_state'], context: ctx, limit: 20000, order: 'date, id' });
    const moveIds = [...new Set(L.map(l => l.move_id[0]))];
    const M = moveIds.length ? await odooCall('account.move', 'read', [moveIds, ['name', 'ref', 'narration', 'move_type', 'attachment_ids']], { context: ctx }) : [];
    const byMove = Object.fromEntries(M.map(m => [m.id, m]));
    const payIds = [...new Set(L.map(l => l.payment_id && l.payment_id[0]).filter(Boolean))];
    const P = payIds.length ? await odooCall('account.payment', 'read', [payIds, ['memo', 'reconciled_bill_ids', 'reconciled_invoice_ids', 'payment_type']], { context: ctx }) : [];
    const byPay = Object.fromEntries(P.map(p => [p.id, p]));
    const billIds = [...new Set(P.flatMap(p => [...(p.reconciled_bill_ids || []), ...(p.reconciled_invoice_ids || [])]))];
    const B = billIds.length ? await odooCall('account.move', 'read', [billIds, ['name', 'ref', 'invoice_date', 'amount_total', 'attachment_ids', 'move_type']], { context: ctx }) : [];
    const byBill = Object.fromEntries(B.map(b => [b.id, b]));
    const attIds = [...new Set([...M, ...B].flatMap(m => m.attachment_ids || []))];
    const AT = attIds.length ? await odooCall('ir.attachment', 'read', [attIds, ['name']], { context: ctx }) : [];
    const attName = Object.fromEntries(AT.map(a => [a.id, a.name]));
    const anByMove = await acc.analyticOfMoves(odooCall, moveIds, ctx);
    // the other side of a plain entry (no payment): tells what the cash went to
    const others = moveIds.length ? await odooCall('account.move.line', 'search_read', [[['move_id', 'in', moveIds], ['account_id', '!=', j.accountId], ['display_type', 'not in', ['line_section', 'line_note']]]],
      { fields: ['move_id', 'account_id', 'name', 'partner_id'], context: ctx, limit: 20000 }) : [];
    const otherOf = {}; for (const o of others) (otherOf[o.move_id[0]] = otherOf[o.move_id[0]] || []).push(o);

    for (const l of L) {
      const m = byMove[l.move_id[0]] || {};
      const p = l.payment_id ? byPay[l.payment_id[0]] : null;
      const bills = p ? [...(p.reconciled_bill_ids || []), ...(p.reconciled_invoice_ids || [])].map(id => byBill[id]).filter(Boolean) : [];
      const files = [...(m.attachment_ids || []), ...bills.flatMap(b => b.attachment_ids || [])].map(id => attName[id]).filter(Boolean);
      const lineName = String(l.name || '').replace(/^Manual:\s*/, '');
      const desc = (p && p.memo) || m.ref || (lineName && lineName !== 'Manual' ? lineName : '') || (bills[0] && (bills[0].ref || bills[0].name)) || '';
      const other = (otherOf[m.id] || [])[0];
      const description = [desc, !desc && other ? other.account_id[1] : ''].filter(Boolean).join(' ');
      const rec = anByMove[m.id] || { analytics: [], docs: [] };
      const docs = [...new Set([...bills.map(b => b.name), ...rec.docs])].filter(d => d && d !== m.name);
      const an = rec.analytics[0];
      const paidBy = paidByIn([...files, p && p.memo, m.ref, m.narration]);
      const id = 'odoo-' + l.id;
      const prev = existing[id] || {};
      const t = {
        id, src: 'odoo', date: l.date, ref: m.name || '', service: shortCompany(j.company),
        description, name: l.partner_id ? l.partner_id[1] : '', phone: '',
        // Odoo debit on the cash account = money came in = statement credit
        debit: money(l.credit), credit: money(l.debit), amountCurrency: l.amount_currency || 0,
        state: l.parent_state, files, importedAt: now(),
        odoo: { checkedAt: now(), matches: [{
          chosen: true, lineId: l.id, moveId: m.id, move: m.name, date: l.date, amount: l.debit || l.credit,
          partner: l.partner_id ? l.partner_id[1] : '', partnerId: l.partner_id ? l.partner_id[0] : null, label: lineName,
          company: j.company, journal: j.name, state: l.parent_state, docs, analytics: rec.analytics, score: 10, why: ['imported from Odoo'],
        }] },
      };
      if (l.partner_id && prev.partnerSrc !== 'manual') Object.assign(t, { partnerId: l.partner_id[0], partnerName: l.partner_id[1], partnerSrc: 'odoo' });
      if (prev.companySrc !== 'manual') Object.assign(t, { company: j.company, companySrc: 'odoo', kind: 'work', kindSrc: 'odoo' });
      if (an && prev.analyticSrc !== 'manual') Object.assign(t, { analyticId: an.id, analyticName: an.name, analyticSrc: 'odoo', analyticFrom: an.from });
      if (paidBy && prev.paidBySrc !== 'manual') Object.assign(t, { paidBy, paidBySrc: 'odoo' });
      if (paidBy && owner && paidBy !== owner) out.paidByOthers++;
      if (existing[id]) out.updated++; else out.added++;
      writes.push({ ref: col.doc(id), data: t });
    }
    out.journals.push({ id: j.id, name: j.name, company: j.company, lines: L.length });
    out.lines += L.length;
  }
  await acc.batchSet(account.ref.firestore, writes);
  await account.ref.set({ lastOdooImport: now(), lastOdooImportBy: who }, { merge: true });
  return out;
}

// HomeBudget kept the wallet for years; its rows come in as history. A Budget row that
// repeats an Odoo line (same amount, same way, within 3 days) is linked to it and
// excluded from the balance — matched, not summed.
async function importBudget(ws, account, budgetAccountId, who) {
  const bid = String(budgetAccountId);
  const [A, E, I, T, C, S, PY] = await Promise.all(['budgetAccounts', 'budgetExpenses', 'budgetIncome', 'budgetTransfers', 'budgetCategories', 'budgetSubCategories', 'budgetPayees']
    .map(c => ws.collection(c).get()));
  const nameOf = snap => Object.fromEntries(snap.docs.map(d => [d.id, d.data().name || '']));
  const accName = nameOf(A), cat = nameOf(C), sub = nameOf(S), payee = nameOf(PY);
  const amt = r => money(r.accAmount != null && r.accAmount !== '' ? r.accAmount : r.amount);
  const rows = [];
  E.docs.forEach(d => { const r = d.data(); if (String(r.accountId) !== bid) return;
    rows.push({ id: 'hb-e-' + d.id, date: r.date, debit: amt(r), credit: 0, description: [payee[r.payeeId], cat[r.catId], sub[r.subId], r.notes].filter(Boolean).join(' · ') || 'expense',
      hb: { kind: 'expense', catId: r.catId || '', subId: r.subId || '', payeeId: r.payeeId || '', notes: r.notes || '' } }); });
  I.docs.forEach(d => { const r = d.data(); if (String(r.accountId) !== bid) return;
    rows.push({ id: 'hb-i-' + d.id, date: r.date, debit: 0, credit: amt(r), description: [r.name, r.notes].filter(Boolean).join(' · ') || 'income',
      hb: { kind: 'income', notes: r.notes || '' } }); });
  T.docs.forEach(d => { const r = d.data();
    if (String(r.fromId) === bid) rows.push({ id: 'hb-t-' + d.id, date: r.date, debit: money(r.fromAmount != null ? r.fromAmount : r.amount), credit: 0,
      description: 'Transfer → ' + (accName[r.toId] || r.toId) + (r.notes ? ' · ' + r.notes : ''), kind: 'transfer', hb: { kind: 'transfer', toId: r.toId, notes: r.notes || '' } });
    if (String(r.toId) === bid) rows.push({ id: 'hb-t-' + d.id, date: r.date, debit: 0, credit: money(r.toAmount != null ? r.toAmount : r.amount),
      description: 'Transfer ← ' + (accName[r.fromId] || r.fromId) + (r.notes ? ' · ' + r.notes : ''), kind: 'transfer', hb: { kind: 'transfer', fromId: r.fromId, notes: r.notes || '' } }); });

  const col = txCol(account);
  const cur = await col.get();
  const existing = {}; cur.docs.forEach(d => { existing[d.id] = d.data(); });
  const odoo = cur.docs.map(d => d.data()).filter(t => t.src === 'odoo' && !t.excluded);
  const days = (a, b) => Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000;
  // one-to-one: closest date first; links a person made by hand are kept
  const taken = new Set(Object.values(existing).filter(t => t.dupSrc === 'manual').map(t => t.dupOf).filter(Boolean));
  const pairs = [];
  for (const r of rows) for (const o of odoo) {
    if (taken.has(o.id)) continue;
    const same = (r.debit && Math.abs(o.debit - r.debit) < 0.011) || (r.credit && Math.abs(o.credit - r.credit) < 0.011);
    if (same && days(r.date, o.date) <= 3) pairs.push({ r, o, d: days(r.date, o.date) });
  }
  pairs.sort((a, b) => a.d - b.d);
  const dup = new Map(), used = new Set();
  for (const p of pairs) { if (dup.has(p.r.id) || used.has(p.o.id)) continue; dup.set(p.r.id, p.o.id); used.add(p.o.id); }

  let added = 0, updated = 0, linked = 0;
  const writes = rows.map(r => {
    const prev = existing[r.id] || {};
    const t = { ...r, src: 'budget', ref: '', service: 'Budget', importedAt: now(), budgetAccountId: bid };
    if (prev.dupSrc !== 'manual') {
      const d = dup.get(r.id);
      if (d) { t.dupOf = d; t.excluded = true; t.dupSrc = 'auto'; linked++; }
      else if (prev.dupSrc === 'auto') { t.dupOf = null; t.excluded = false; t.dupSrc = ''; }
    }
    if (existing[r.id]) updated++; else added++;
    return { ref: col.doc(r.id), data: t };
  });
  await acc.batchSet(ws.firestore, writes);
  await account.ref.set({ budgetAccountId: bid, budgetAccountName: accName[bid] || '', lastBudgetImport: now(), lastBudgetImportBy: who }, { merge: true });
  return { rows: rows.length, added, updated, linkedToOdoo: linked };
}

// ── Transfers ────────────────────────────────────────────────────────────────
const trLine = (tr, side, otherName) => ({
  id: 'tr-' + tr.id, src: 'transfer', transferId: tr.id, date: tr.date, ref: '', service: 'Transfer', phone: '',
  description: (side === 'out' ? 'Transfer → ' : 'Transfer ← ') + otherName + (tr.note ? ' · ' + tr.note : ''),
  debit: side === 'out' ? money(tr.amount) : 0, credit: side === 'in' ? money(tr.amount) : 0,
  company: '', kind: 'transfer', kindSrc: 'transfer', updatedAt: now(),
});
async function writeTransferLines(ws, tr) {
  const [from, to] = await Promise.all([resolve(ws, tr.fromId), resolve(ws, tr.toId)]);
  if (!from || !to) throw new Error('unknown account');
  const b = ws.firestore.batch();
  // an existing line (a Whish top-up, an Odoo entry) is linked, not doubled
  if (tr.fromTxId) b.set(txCol(from).doc(String(tr.fromTxId)), { transferId: tr.id, kind: 'transfer', kindSrc: 'transfer', updatedAt: now() }, { merge: true });
  else b.set(txCol(from).doc('tr-' + tr.id), trLine(tr, 'out', to.name), { merge: true });
  if (tr.toTxId) b.set(txCol(to).doc(String(tr.toTxId)), { transferId: tr.id, kind: 'transfer', kindSrc: 'transfer', updatedAt: now() }, { merge: true });
  else b.set(txCol(to).doc('tr-' + tr.id), trLine(tr, 'in', from.name), { merge: true });
  await b.commit();
  return { from, to };
}
async function removeTransferLines(ws, tr, FieldValue) {
  const [from, to] = await Promise.all([resolve(ws, tr.fromId), resolve(ws, tr.toId)]);
  const b = ws.firestore.batch();
  const unlink = { transferId: FieldValue.delete(), kind: '', kindSrc: '', updatedAt: now() };
  if (from) { if (tr.fromTxId) b.set(txCol(from).doc(String(tr.fromTxId)), unlink, { merge: true }); else b.delete(txCol(from).doc('tr-' + tr.id)); }
  if (to) { if (tr.toTxId) b.set(txCol(to).doc(String(tr.toTxId)), unlink, { merge: true }); else b.delete(txCol(to).doc('tr-' + tr.id)); }
  await b.commit();
}

const journalsIn = list => (Array.isArray(list) ? list : []).map(j => ({ id: +j.id, name: j.name || '', companyId: j.companyId != null ? +j.companyId : null, company: j.company || '' })).filter(j => j.id);
const openingIn = o => o && o.date ? { date: String(o.date), amount: money(o.amount), note: String(o.note || '') } : null;
const excelIn = x => x && x.file ? { file: String(x.file).trim(), sheet: String(x.sheet || '').trim(), layout: String(x.layout || '').toLowerCase().trim() } : null;
const whatsappIn = x => x && x.chatId ? { chatId: +x.chatId, since: /^\d{4}-\d{2}-\d{2}$/.test(String(x.since || '')) ? String(x.since) : '', lbpRate: +x.lbpRate || 0 } : null;

// ── Router ───────────────────────────────────────────────────────────────────
async function handle(req, res, url, user, ctx) {
  const { db, admin, TEAM_ID, odooCall } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  let m;

  if (url === '/api/accounting/odoo/journals' && req.method === 'GET') {
    try { return json(res, 200, await odooJournals(odooCall)); }
    catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  if (url === '/api/accounting/accounts' && req.method === 'GET') return json(res, 200, await listAccounts(ws));

  // the HomeBudget accounts, so the "+" form can offer one as history (light: no rows)
  if (url === '/api/accounting/budget-accounts' && req.method === 'GET') {
    const snap = await ws.collection('budgetAccounts').get();
    return json(res, 200, snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id, currency: d.data().currency || '', archived: !!d.data().archived })));
  }

  // Remove an account and its lines. Only for accounts made here — the Whish account is its statements.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'DELETE') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'the Whish account cannot be deleted here' });
    const used = await ws.collection('transfers').where('fromId', '==', a.id).limit(1).get();
    const used2 = await ws.collection('transfers').where('toId', '==', a.id).limit(1).get();
    if (!used.empty || !used2.empty) return json(res, 400, { error: 'transfers point at this account — delete them first' });
    const snap = await txCol(a).select().get();
    for (let i = 0; i < snap.docs.length; i += 450) { const b = db.batch(); snap.docs.slice(i, i + 450).forEach(d => b.delete(d.ref)); await b.commit(); }
    await a.ref.delete();
    return json(res, 200, { ok: true, lines: snap.size });
  }

  if (url === '/api/accounting/accounts' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!name) return json(res, 400, { error: 'a name is required' });
    const type = b.type === 'bank' ? 'bank' : 'cash';
    let id = slug(b.id || name) || newId();
    if (await resolve(ws, id)) id = id + '-' + newId().slice(-4);
    const journals = journalsIn(b.odooJournals);
    const data = { id, name, type, currency: String(b.currency || 'USD').toUpperCase(), provider: b.provider || (journals.length ? 'odoo' : 'manual'),
      owner: String(b.owner || '').toLowerCase(), odooJournals: journals, opening: openingIn(b.opening), statement: false, createdAt: now(), createdBy: who };
    if (excelIn(b.excel)) data.excel = excelIn(b.excel);
    if (whatsappIn(b.whatsapp)) data.whatsapp = whatsappIn(b.whatsapp);
    await ws.collection('accounts').doc(id).set(data);
    return json(res, 200, data);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const { ref: _ref, ...rest } = a; return json(res, 200, rest);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'PATCH') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'the Whish account is defined by its statements' });
    const b = await readBody(req), data = { updatedAt: now(), updatedBy: who };
    if ('name' in b) data.name = String(b.name).trim();
    if ('type' in b) data.type = b.type === 'bank' ? 'bank' : 'cash';
    if ('currency' in b) data.currency = String(b.currency).toUpperCase();
    if ('owner' in b) data.owner = String(b.owner || '').toLowerCase();
    if ('archived' in b) data.archived = !!b.archived;
    if ('odooJournals' in b) data.odooJournals = journalsIn(b.odooJournals);
    if ('opening' in b) data.opening = openingIn(b.opening);
    if ('excel' in b) data.excel = excelIn(b.excel) ? { ...(a.excel || {}), ...excelIn(b.excel) } : null;
    if ('whatsapp' in b) data.whatsapp = whatsappIn(b.whatsapp) ? { ...(a.whatsapp || {}), ...whatsappIn(b.whatsapp) } : null;
    await a.ref.set(data, { merge: true });
    return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const snap = await txCol(a).get();
    const tx = snap.docs.map(d => d.data()).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : String(x.ref || x.id).localeCompare(String(y.ref || y.id), undefined, { numeric: true }));
    return json(res, 200, tx);
  }

  // A line typed by hand (or sent from Telegram). Money out is `debit`, money in `credit`,
  // as on a bank statement.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'Whish lines come from the statement' });
    const b = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return json(res, 400, { error: 'date (yyyy-mm-dd) required' });
    const debit = money(b.debit), credit = money(b.credit);
    if (!debit && !credit) return json(res, 400, { error: 'an amount is required' });
    const id = b.id ? String(b.id) : 'm-' + newId();
    const t = { id, src: b.src === 'telegram' ? 'telegram' : 'manual', date: b.date, ref: String(b.ref || ''), service: '', phone: '',
      description: String(b.description || '').trim(), debit, credit, createdAt: now(), createdBy: who, updatedAt: now(), updatedBy: who };
    for (const k of ANNOT) if (k in b) t[k] = b[k];
    if (t.company) { t.companySrc = t.companySrc || 'manual'; t.kind = t.company === 'Personal' ? 'personal' : 'work'; t.kindSrc = 'manual'; }
    if (t.partnerName) t.partnerSrc = t.partnerSrc || 'manual';
    if (t.analyticName) t.analyticSrc = t.analyticSrc || 'manual';
    if (t.paidBy) t.paidBySrc = t.paidBySrc || 'manual';
    if (t.note) t.noteSrc = 'manual';
    await txCol(a).doc(id).set(t);
    return json(res, 200, t);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)$/)) && req.method === 'PATCH') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such line' });
    const data = {};
    for (const k of ANNOT) if (k in body) data[k] = body[k];
    // the line itself may be edited only when a person wrote it
    if (cur.src === 'manual' || cur.src === 'telegram') for (const k of LINE) if (k in body) data[k] = k === 'debit' || k === 'credit' ? money(body[k]) : body[k];
    if ('excluded' in body || 'dupOf' in body) data.dupSrc = 'manual';
    if (body.excluded === false) data.review = false;
    if ('paidBy' in body) data.paidBySrc = body.paidBy ? 'manual' : '';
    if (!Object.keys(data).length) return json(res, 400, { error: 'nothing to update' });
    data.updatedAt = now(); data.updatedBy = who;
    await ref.set(data, { merge: true });
    return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)$/)) && req.method === 'DELETE') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such line' });
    if (!['manual', 'telegram', 'budget', 'excel', 'whatsapp'].includes(cur.src)) return json(res, 400, { error: 'only typed or imported ledger lines can be deleted; Odoo and statement lines are facts' });
    if (cur.transferId) return json(res, 400, { error: 'this line belongs to a transfer — delete the transfer' });
    await ref.delete();
    return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx-bulk$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const col = txCol(a), at = now();
    const writes = (body.items || []).filter(i => i && /^[\w-]+$/.test(String(i.id))).map(i => {
      const data = { updatedAt: at, updatedBy: who };
      for (const k of ANNOT) if (k in i) data[k] = i[k];
      return { ref: col.doc(String(i.id)), data };
    });
    await acc.batchSet(db, writes);
    return json(res, 200, { ok: true, saved: writes.length });
  }

  // Look for the lines in the account's Odoo journals (imported Odoo lines are already facts and are skipped).
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/odoo-check$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const col = txCol(a);
    let txs = (await col.get()).docs.map(d => d.data()).filter(t => t.src !== 'odoo');
    if (Array.isArray(body.ids) && body.ids.length) { const s = new Set(body.ids.map(String)); txs = txs.filter(t => s.has(String(t.id))); }
    if (!txs.length) return json(res, 200, {});
    try {
      const journals = await journalsOf(odooCall, a);
      if (!journals && a.provider !== 'whish') return json(res, 400, { error: 'this account has no Odoo journal to check against' });
      const cs = await ws.collection('whishContacts').get();
      const names = Object.fromEntries(cs.docs.map(d => [d.id, (d.data().name || '')]));
      const found = await acc.odooCheck(odooCall, txs.map(t => ({ ...t, contactName: names[t.phone] || '' })), { journals, journalWord: 'whish' });
      const at = now();
      const writes = txs.map(t => {
        const matches = found[t.id] || [];
        const data = { odoo: { checkedAt: at, matches } };
        const win = matches.find(x => x.chosen);
        if (win) {
          if (win.partner) data.odooPartner = win.partner;
          if (win.partner && t.partnerSrc !== 'manual') { data.partnerName = win.partner; data.partnerId = win.partnerId || null; data.partnerSrc = 'odoo'; }
          if (win.company && t.companySrc !== 'manual') { data.company = win.company; data.companySrc = 'odoo'; data.kind = 'work'; data.kindSrc = 'odoo'; }
          const an = (win.analytics || [])[0];
          if (an && t.analyticSrc !== 'manual') { data.analyticId = an.id; data.analyticName = an.name; data.analyticSrc = 'odoo'; data.analyticFrom = an.from; }
        }
        return { ref: col.doc(String(t.id)), data };
      });
      await acc.batchSet(db, writes);
      return json(res, 200, found);
    } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-odoo$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (!(a.odooJournals || []).length) return json(res, 400, { error: 'this account has no Odoo journals' });
    try { return json(res, 200, await importOdoo(odooCall, a, who)); }
    catch (e) { console.error('import-odoo', e); return json(res, 502, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-budget$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    const bid = b.budgetAccountId || a.budgetAccountId;
    if (!bid) return json(res, 400, { error: 'budgetAccountId required' });
    try { return json(res, 200, await importBudget(ws, a, bid, who)); }
    catch (e) { console.error('import-budget', e); return json(res, 502, { error: String(e.message || e) }); }
  }

  // the workers' ledgers — read on Mario's machine, matched here
  const ledgerCtx = { acc, txCol, ws, resolve, listAccounts };
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-excel$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (excelIn(b.excel)) { a.excel = { ...(a.excel || {}), ...excelIn(b.excel) }; await a.ref.set({ excel: a.excel }, { merge: true }); }
    try { return json(res, 200, await ledgers.importExcel(ledgerCtx, a, who)); }
    catch (e) { console.error('import-excel', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-whatsapp$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (whatsappIn(b.whatsapp)) { a.whatsapp = { ...(a.whatsapp || {}), ...whatsappIn(b.whatsapp) }; await a.ref.set({ whatsapp: a.whatsapp }, { merge: true }); }
    try { return json(res, 200, await ledgers.importWhatsapp(ledgerCtx, a, who)); }
    catch (e) { console.error('import-whatsapp', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/link-transfers$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await ledgers.linkTransfers(ledgerCtx, a, who, { loose: !!b.loose, marioId: b.marioId })); }
    catch (e) { console.error('link-transfers', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if (url.startsWith('/api/accounting/whatsapp-groups') && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    try { return json(res, 200, ledgers.listGroups(q)); }
    catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ── dashboard: every account's balance, summed here so the page does not download 8,000 lines ──
  if (url === '/api/accounting/balances' && req.method === 'GET') {
    const accounts = await listAccounts(ws);
    const out = [];
    for (const a of accounts) {
      const full = await resolve(ws, a.id);
      const snap = await txCol(full).select('date', 'debit', 'credit', 'excluded', 'balance', 'ref', 'review', 'src').get();
      const tx = snap.docs.map(d => d.data());
      let balance = 0;
      if (a.statement) {
        const o = tx.filter(t => t.balance != null).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (+x.ref || 0) - (+y.ref || 0));
        balance = o.length ? money(o[o.length - 1].balance) : 0;
      } else {
        const mv = t => t.excluded ? 0 : (t.credit || 0) - (t.debit || 0);
        const op = a.opening;
        balance = money(op ? op.amount + tx.filter(t => t.date >= op.date).reduce((s, t) => s + mv(t), 0) : tx.reduce((s, t) => s + mv(t), 0));
      }
      const dates = tx.map(t => t.date).filter(Boolean).sort();
      out.push({ id: a.id, name: a.name, type: a.type, owner: a.owner || '', currency: a.currency || 'USD', provider: a.provider || '', archived: !!a.archived,
        balance, lines: tx.length, counted: tx.filter(t => !t.excluded).length, review: tx.filter(t => t.review).length, first: dates[0] || '', last: dates[dates.length - 1] || '',
        opening: a.opening || null, pinned: !!a.opening || !!a.statement });
    }
    return json(res, 200, out);
  }

  // ── gold & silver: holdings read from the workbook (laptop), prices editable anywhere ──
  const goldRef = ws.collection('settings').doc('gold');
  if (url === '/api/accounting/gold' && req.method === 'GET') {
    const d = await goldRef.get();
    return json(res, 200, d.exists ? d.data() : { holdings: [], prices: {} });
  }
  if (url === '/api/accounting/gold' && req.method === 'PATCH') {
    const b = await readBody(req), data = { updatedAt: now(), updatedBy: who };
    if (b.prices && typeof b.prices === 'object') {
      const cur = (await goldRef.get()).data() || {};
      data.prices = { ...(cur.prices || {}) };
      for (const k of ['gold', 'silver']) if (k in b.prices) data.prices[k] = money(b.prices[k]);
      data.prices.asOf = String(b.prices.asOf || now().slice(0, 10));
    }
    await goldRef.set(data, { merge: true });
    return json(res, 200, { ok: true });
  }
  if (url === '/api/accounting/gold/import' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const g = await ledgers.readGold(b.file);
      const cur = (await goldRef.get()).data() || {};
      const prices = { ...g.prices, ...(cur.prices || {}) };            // a price typed here beats the sheet's
      if (!prices.asOf) prices.asOf = g.readAt.slice(0, 10);
      await goldRef.set({ holdings: g.holdings, prices, file: g.file, importedAt: g.readAt, importedBy: who }, { merge: true });
      return json(res, 200, { holdings: g.holdings.length, prices, file: g.file });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ── transfers ──
  if (url === '/api/accounting/transfers' && req.method === 'GET') {
    const [snap, accounts] = await Promise.all([ws.collection('transfers').get(), listAccounts(ws)]);
    const nm = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).map(t => ({ ...t, fromName: nm[t.fromId] || t.fromId, toName: nm[t.toId] || t.toId }))
      .sort((x, y) => x.date < y.date ? 1 : x.date > y.date ? -1 : 0);
    return json(res, 200, list);
  }

  if (url === '/api/accounting/transfers' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return json(res, 400, { error: 'date (yyyy-mm-dd) required' });
    if (!b.fromId || !b.toId || b.fromId === b.toId) return json(res, 400, { error: 'two different accounts are required' });
    const amount = money(b.amount);
    if (!(amount > 0)) return json(res, 400, { error: 'an amount is required' });
    const id = newId();
    const tr = { id, date: b.date, fromId: String(b.fromId), toId: String(b.toId), amount, currency: String(b.currency || 'USD').toUpperCase(),
      note: String(b.note || '').trim(), fromTxId: b.fromTxId ? String(b.fromTxId) : '', toTxId: b.toTxId ? String(b.toTxId) : '', createdAt: now(), createdBy: who };
    try {
      const { from, to } = await writeTransferLines(ws, tr);
      await ws.collection('transfers').doc(id).set(tr);
      return json(res, 200, { ...tr, fromName: from.name, toName: to.name });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/transfers\/([\w-]+)$/)) && req.method === 'PATCH') {
    const ref = ws.collection('transfers').doc(m[1]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such transfer' });
    const b = await readBody(req);
    const tr = { ...cur, id: m[1] };
    if ('date' in b && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) tr.date = b.date;
    if ('amount' in b && money(b.amount) > 0) tr.amount = money(b.amount);
    if ('note' in b) tr.note = String(b.note || '').trim();
    tr.updatedAt = now(); tr.updatedBy = who;
    await writeTransferLines(ws, tr);
    await ref.set(tr);
    return json(res, 200, tr);
  }

  if ((m = url.match(/^\/api\/accounting\/transfers\/([\w-]+)$/)) && req.method === 'DELETE') {
    const ref = ws.collection('transfers').doc(m[1]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such transfer' });
    await removeTransferLines(ws, { id: m[1], ...cur }, admin.firestore.FieldValue);
    await ref.delete();
    return json(res, 200, { ok: true });
  }

  return false;
}

module.exports = { handle, resolve, listAccounts, txCol, journalsOf, ANNOT, paidByIn };
