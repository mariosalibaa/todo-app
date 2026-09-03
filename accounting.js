// Accounting section of the admin hub — Whish statements.
// Mounted by server.js under /api/accounting/*; needs ctx = { db, admin, TEAM_ID, odooCall }.
// Firestore layout (all under workspaces/<team>):
//   whishAccounts/<accountNo>            { account, name, phone, currency, statements[] }
//   whishAccounts/<accountNo>/tx/<trId>  statement fields + annotations (note, kind, analytic…)
//   whishContacts/<phone>                { phone, name, source }   phone = digits, 961…
const pdfParse = require('pdf-parse');

// ── Statement parsing ──────────────────────────────────────────────────────
// pdf-parse flattens each row to one line with the columns glued together:
//   24/04/2026tr:370904791PAY BY CARDMC DONALDS - SUNORAMA21.746,984.88
// The two trailing amounts (amount, balance) are separated by trying every
// split and keeping the one that agrees with the running balance.
const SERVICES = [
  'WHISH PHYSICAL CARD', 'WHISH TO WHISH', 'LTN CASH OUT', 'PAY BY CARD', 'SCAN TO PAY',
  'CREDIT CARD', 'WHISH MONEY', 'REVERSED W2W', 'QR COLLECT', 'COLLECTION', 'E-SIM', 'CASH OUT', 'TOPUP', 'W2W', 'ATM', 'REFUND', 'FEES', 'FEE'
];
const AMT = '(?:0|[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d*)\\.\\d{2}';
const TAIL = new RegExp('^(' + AMT + ')(' + AMT + ')$');
const TAIL_END = new RegExp('(' + AMT + ')\\s*(' + AMT + ')$');
// browser pdf.js keeps the spaces between columns: "body 65.00 2,786.66" is unambiguous
const SPACED = new RegExp('^(.*?)\\s*(' + AMT + ')\\s+(' + AMT + ')$');
const num = s => parseFloat(String(s).replace(/,/g, ''));
const isoDate = d => { const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : d; };

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('961')) return d;
  if (d.startsWith('0') && (d.length === 8 || d.length === 9)) return '961' + d.slice(1);
  if (d.length === 7 || d.length === 8) return '961' + d;
  return d;
}

function counterparty(desc) {
  const s = desc.trim();
  let m;
  if ((m = s.match(/^\+?(\d{8,15})$/))) return { phone: normalizePhone(m[1]), name: '' };
  if ((m = s.match(/^(.+?)\s*-\s*\+?(\d{8,15})$/))) return { phone: normalizePhone(m[2]), name: m[1].trim() };
  return { phone: '', name: s };
}

// Split "body+amount+balance" so that prev ± amount == balance
function splitAmounts(rest, prev) {
  const sp = rest.match(SPACED);
  if (sp) {
    const c = { body: sp[1], amount: num(sp[2]), balance: num(sp[3]) };
    if (prev == null || Math.abs(prev - c.amount - c.balance) < 0.011 || Math.abs(prev + c.amount - c.balance) < 0.011) return c;
  }
  const candidates = [];
  for (let i = 0; i < rest.length; i++) {
    const m = rest.slice(i).match(TAIL);
    if (m) candidates.push({ body: rest.slice(0, i), amount: num(m[1]), balance: num(m[2]) });
  }
  if (!candidates.length) return null;
  if (prev != null) {
    const ok = candidates.find(c => Math.abs(prev - c.amount - c.balance) < 0.011 || Math.abs(prev + c.amount - c.balance) < 0.011);
    if (ok) return ok;
  }
  return candidates[0];
}

function parseStatement(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !/^DATE ?REFERENCE/.test(l));
  const head = {};
  const dated = /^(\d{2}\/\d{2}\/\d{4})(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^Full Name:\s*(.+)$/))) head.name = m[1].trim();
    else if ((m = l.match(/^Phone Number:\s*\+?(\d+)/))) head.phone = m[1];
    else if ((m = l.match(/^Account No:\s*(\d+)/))) head.account = m[1];
    else if ((m = l.match(/^Currency:\s*(\w+)/))) head.currency = m[1];
    else if ((m = l.match(/^From (\d{2}\/\d{2}\/\d{4}) Till (\d{2}\/\d{2}\/\d{4})/))) { head.from = isoDate(m[1]); head.till = isoDate(m[2]); }
    else if ((m = l.match(new RegExp('^OPENING BALANCE\\s*(' + AMT + ')$')))) head.opening = num(m[1]);
    else if ((m = l.match(new RegExp('^TOTAL AMOUNT \\/ CLOSING BALANCE\\s*(' + AMT + ')\\s*(' + AMT + ')\\s*(' + AMT + ')$')))) {
      head.totalDebit = num(m[1]); head.totalCredit = num(m[2]); head.closing = num(m[3]);
    }
    // 2026 layout: "dd/mm/yyyyOpening Balance" with the figure on the same or the next line
    else if ((m = l.match(/^\d{2}\/\d{2}\/\d{4}\s*(Opening|Closing) Balance\s*(.*)$/))) {
      const v = (m[2] || lines[i + 1] || '').match(new RegExp('^(' + AMT + ')$'));
      if (v) head[m[1] === 'Opening' ? 'opening' : 'closing'] = num(v[1]);
    }
  }
  const tx = [], warnings = [];
  let prev = head.opening ?? null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{2}\/\d{2}\/\d{4})\s*tr:(\d+)\s*(.*)$/);
    if (!m) continue;
    // Old layout: the whole row is one line. New layout: description may wrap
    // over several lines and the amounts sit on their own line — keep pulling
    // lines until the text ends in "amount balance".
    let rest = m[3];
    let j = i;
    while (!TAIL_END.test(rest) && j + 1 < lines.length && !dated.test(lines[j + 1])) {
      j++;
      rest += (rest ? ' ' : '') + lines[j];
    }
    i = j;
    const sp = splitAmounts(rest, prev);
    if (!sp) { warnings.push('unparsed: ' + lines[i]); continue; }
    let body = sp.body.trim(), service = '', desc = body;
    for (const s of SERVICES) if (body.startsWith(s)) { service = s; desc = body.slice(s.length); break; }
    let debit = 0, credit = 0;
    if (prev != null && Math.abs(prev - sp.amount - sp.balance) < 0.011) debit = sp.amount;
    else if (prev != null && Math.abs(prev + sp.amount - sp.balance) < 0.011) credit = sp.amount;
    else { if (/TOPUP|CASHIN|REFUND/.test(body)) credit = sp.amount; else debit = sp.amount; warnings.push('direction guessed: tr:' + m[2]); }
    prev = sp.balance;
    tx.push({
      id: m[2], ref: m[2], date: isoDate(m[1]), service, description: desc.trim().replace(/\s+/g, ' '),
      ...counterparty(desc.replace(/\s+/g, ' ')), debit, credit, balance: sp.balance
    });
  }
  if (head.closing != null && tx.length && Math.abs(tx[tx.length - 1].balance - head.closing) > 0.011)
    warnings.push(`closing balance ${head.closing} != last line ${tx[tx.length - 1].balance}`);
  return { head, tx, warnings };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});

async function batchSet(db, writes) {   // writes: [{ref, data, merge}] — Firestore caps a batch at 500
  for (let i = 0; i < writes.length; i += 450) {
    const b = db.batch();
    for (const w of writes.slice(i, i + 450)) b.set(w.ref, w.data, { merge: w.merge !== false });
    await b.commit();
  }
}

// ── Odoo lookups ───────────────────────────────────────────────────────────
let _analyticCache = { at: 0, list: [] };
async function analyticAccounts(odooCall) {
  if (Date.now() - _analyticCache.at < 10 * 60000 && _analyticCache.list.length) return _analyticCache.list;
  const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id', 'name'] });
  const ctx = { allowed_company_ids: companies.map(c => c.id) };
  const rows = await odooCall('account.analytic.account', 'search_read', [[['active', '=', true]]],
    { fields: ['id', 'name', 'plan_id', 'company_id'], context: ctx, order: 'name' });
  _analyticCache = { at: Date.now(), list: rows.map(r => ({
    id: r.id, name: r.name, plan: r.plan_id ? r.plan_id[1] : '', company: r.company_id ? r.company_id[1] : ''
  })) };
  return _analyticCache.list;
}

let _whishJournals = null;
async function whishJournals(odooCall) {
  if (_whishJournals) return _whishJournals;
  const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id', 'name'] });
  const ctx = { allowed_company_ids: companies.map(c => c.id) };
  const rows = await odooCall('account.journal', 'search_read', [[['name', 'ilike', 'whish']]],
    { fields: ['id', 'name', 'company_id', 'default_account_id'], context: ctx });
  _whishJournals = { rows, ctx };
  return _whishJournals;
}

// Find journal items on the Whish cash accounts with the same amount within
// ±3 days of each statement line.
async function odooCheck(odooCall, txs) {
  const { rows: journals, ctx } = await whishJournals(odooCall);
  if (!journals.length) return {};
  const accIds = journals.map(j => j.default_account_id && j.default_account_id[0]).filter(Boolean);
  const dates = txs.map(t => t.date).sort();
  const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const lines = await odooCall('account.move.line', 'search_read', [[
    ['account_id', 'in', accIds], ['date', '>=', shift(dates[0], -3)], ['date', '<=', shift(dates[dates.length - 1], 3)]
  ]], { fields: ['id', 'move_id', 'date', 'debit', 'credit', 'amount_currency', 'partner_id', 'name', 'ref', 'company_id', 'journal_id', 'parent_state'],
        context: ctx, limit: 5000 });
  const out = {};
  for (const t of txs) {
    // statement debit (money out) = credit on the Odoo cash account, and vice versa
    const want = t.debit || t.credit;
    const lo = shift(t.date, -3), hi = shift(t.date, 3);
    out[t.id] = lines.filter(l => l.date >= lo && l.date <= hi && (
      Math.abs((t.debit ? l.credit : l.debit) - want) < 0.011 || Math.abs(Math.abs(l.amount_currency) - want) < 0.011
    )).map(l => ({
      lineId: l.id, moveId: l.move_id && l.move_id[0], move: l.move_id && l.move_id[1], date: l.date,
      amount: l.debit || l.credit, partner: l.partner_id ? l.partner_id[1] : '', label: l.name || l.ref || '',
      company: l.company_id ? l.company_id[1] : '', journal: l.journal_id ? l.journal_id[1] : '', state: l.parent_state
    }));
  }
  return out;
}

// Editable annotation fields; *Src = who filled it ('manual' | 'suggest' | 'google')
const ANNOT = ['note', 'kind', 'analyticId', 'analyticName', 'company', 'noteSrc', 'kindSrc', 'analyticSrc'];

// ── Router ─────────────────────────────────────────────────────────────────
// Returns true when the request was handled.
async function handle(req, res, url, user, ctx) {
  const { db, admin, TEAM_ID, odooCall } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  const now = () => new Date().toISOString();
  let m;

  if (url === '/api/accounting/whish/accounts' && req.method === 'GET') {
    const snap = await ws.collection('whishAccounts').get();
    return json(res, 200, snap.docs.map(d => d.data()));
  }

  if (url === '/api/accounting/whish/upload' && req.method === 'POST') {
    const body = await readBody(req);
    // The page extracts the text itself with pdf.js (a 25-page statement is 5 MB
    // as PDF but ~60 KB as text, and the host caps request bodies at ~4.5 MB);
    // pdfBase64 stays as a fallback for small files.
    if (!body.text && !body.pdfBase64) return json(res, 400, { error: 'text or pdfBase64 required' });
    const text = body.text || (await pdfParse(Buffer.from(body.pdfBase64, 'base64'))).text;
    const { head, tx, warnings } = parseStatement(text);
    if (!head.account || !tx.length) return json(res, 400, { error: 'Not a Whish statement (no account / no lines)', warnings });
    const accRef = ws.collection('whishAccounts').doc(head.account);
    const existing = new Set((await accRef.collection('tx').select().get()).docs.map(d => d.id));
    const writes = tx.map(t => ({ ref: accRef.collection('tx').doc(t.id), data: { ...t, importedAt: now() } }));
    await batchSet(db, writes);
    await accRef.set({
      account: head.account, name: head.name || '', phone: head.phone || '', currency: head.currency || 'USD',
      lastUpload: now(),
      statements: admin.firestore.FieldValue.arrayUnion({
        from: head.from || '', till: head.till || '', filename: body.filename || '', lines: tx.length,
        opening: head.opening ?? null, closing: head.closing ?? null, uploadedAt: now(), by: who
      })
    }, { merge: true });
    const added = tx.filter(t => !existing.has(t.id)).length;
    return json(res, 200, { account: head.account, head, lines: tx.length, added, updated: tx.length - added, warnings });
  }

  if (url === '/api/accounting/whish/contacts' && req.method === 'GET') {
    const snap = await ws.collection('whishContacts').get();
    return json(res, 200, snap.docs.map(d => d.data()));
  }
  if (url === '/api/accounting/whish/contacts' && req.method === 'POST') {
    const body = await readBody(req);
    const items = (body.items || []).map(i => ({ phone: normalizePhone(i.phone), name: String(i.name || '').trim(), source: i.source || 'manual' }))
      .filter(i => i.phone);
    // Manual names win over imported ones: an import never overwrites a manual entry
    const manual = new Set((await ws.collection('whishContacts').where('source', '==', 'manual').select().get()).docs.map(d => d.id));
    const writes = items.filter(i => i.source === 'manual' || !manual.has(i.phone))
      .map(i => ({ ref: ws.collection('whishContacts').doc(i.phone), data: { ...i, updatedAt: now(), by: who } }));
    await batchSet(db, writes);
    return json(res, 200, { ok: true, saved: writes.length, skipped: items.length - writes.length });
  }

  if (url === '/api/accounting/analytic' && req.method === 'GET') {
    try { return json(res, 200, await analyticAccounts(odooCall)); }
    catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/whish\/(\d+)\/tx$/)) && req.method === 'GET') {
    const snap = await ws.collection('whishAccounts').doc(m[1]).collection('tx').get();
    const tx = snap.docs.map(d => d.data()).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (+a.ref) - (+b.ref));
    return json(res, 200, tx);
  }

  if ((m = url.match(/^\/api\/accounting\/whish\/(\d+)\/tx\/(\d+)$/)) && req.method === 'PATCH') {
    const body = await readBody(req);
    const allowed = ANNOT;
    const data = {};
    for (const k of allowed) if (k in body) data[k] = body[k];
    if (!Object.keys(data).length) return json(res, 400, { error: 'nothing to update' });
    data.updatedAt = now(); data.updatedBy = who;
    await ws.collection('whishAccounts').doc(m[1]).collection('tx').doc(m[2]).set(data, { merge: true });
    return json(res, 200, { ok: true });
  }

  // Bulk annotate: { items: [{ id, ...fields }] } — used by "accept all suggestions"
  if ((m = url.match(/^\/api\/accounting\/whish\/(\d+)\/tx-bulk$/)) && req.method === 'POST') {
    const body = await readBody(req);
    const col = ws.collection('whishAccounts').doc(m[1]).collection('tx');
    const at = now();
    const writes = (body.items || []).filter(i => i && /^\d+$/.test(String(i.id))).map(i => {
      const data = { updatedAt: at, updatedBy: who };
      for (const k of ANNOT) if (k in i) data[k] = i[k];
      return { ref: col.doc(String(i.id)), data };
    });
    await batchSet(db, writes);
    return json(res, 200, { ok: true, saved: writes.length });
  }

  if ((m = url.match(/^\/api\/accounting\/whish\/(\d+)\/odoo-check$/)) && req.method === 'POST') {
    const body = await readBody(req);
    const col = ws.collection('whishAccounts').doc(m[1]).collection('tx');
    let txs = (await col.get()).docs.map(d => d.data());
    if (Array.isArray(body.ids) && body.ids.length) { const s = new Set(body.ids.map(String)); txs = txs.filter(t => s.has(t.id)); }
    if (!txs.length) return json(res, 200, {});
    try {
      const found = await odooCheck(odooCall, txs);
      const at = now();
      await batchSet(db, txs.map(t => ({ ref: col.doc(t.id), data: { odoo: { checkedAt: at, matches: found[t.id] || [] } } })));
      return json(res, 200, found);
    } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  return false;
}

module.exports = { handle, parseStatement, normalizePhone };
