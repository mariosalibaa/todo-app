// Wise section of the accounting app — multi-currency balance statements.
// Mounted by server.js under /api/accounting/wise/*; needs ctx = { db, admin, TEAM_ID }.
// Firestore layout (all under workspaces/<team>):
//   wiseAccounts/<currency>            { currency, name, lastUpload, statements[] }
//   wiseAccounts/<currency>/tx/<id>    one statement line, keyed by Wise's own transaction id
//
// The parser is header-driven: it reads the column names Wise writes and maps them by
// name, so a changed column order, a missing optional column or a localised export
// still imports. Wise writes one statement per balance (per currency), so the currency
// column decides which account a line belongs to.

const HEAD = {
  id: ['transferwise id', 'wise id', 'id', 'transaction id'],
  date: ['date', 'completed date', 'created on'],
  amount: ['amount', 'amount (net)'],
  currency: ['currency'],
  description: ['description'],
  reference: ['payment reference', 'reference'],
  balance: ['running balance', 'balance'],
  exchangeFrom: ['exchange from'],
  exchangeTo: ['exchange to'],
  rate: ['exchange rate'],
  exchangeToAmount: ['exchange to amount'],
  payer: ['payer name'],
  payee: ['payee name'],
  payeeAccount: ['payee account number'],
  merchant: ['merchant'],
  cardLast4: ['card last four digits'],
  cardHolder: ['card holder full name'],
  note: ['note'],
  fees: ['total fees', 'fees'],
};

// RFC4180-ish: quoted fields may hold commas, newlines and doubled quotes
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' && !s.includes(',')) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const num = v => {
  const s = String(v == null ? '' : v).replace(/[^\d.,\-]/g, '').trim();
  if (!s) return null;
  // 1.234,56 (comma decimals) vs 1,234.56
  const clean = /,\d{1,2}$/.test(s) && !/\.\d/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(clean);
  return isFinite(n) ? n : null;
};

// Wise exports dd-mm-yyyy; accept the usual alternatives too
function isoDate(v) {
  const s = String(v || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/))) {
    const a = +m[1], b = +m[2];
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];   // ambiguous: Wise writes day first
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

function parseStatement(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { error: 'That file has no rows' };
  const header = rows[0].map(h => String(h).trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = {};
  for (const [key, names] of Object.entries(HEAD)) {
    const i = header.findIndex(h => names.includes(h));
    if (i >= 0) col[key] = i;
  }
  if (col.date === undefined || col.amount === undefined) {
    return { error: 'This does not look like a Wise statement (no Date / Amount column)', header };
  }
  const get = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] == null ? '' : r[col[k]]).trim());
  const tx = [], warnings = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const date = isoDate(get(r, 'date'));
    const amount = num(get(r, 'amount'));
    if (!date || amount === null) { warnings.push(`skipped a row with no usable date/amount: ${r.slice(0, 3).join(' | ')}`); continue; }
    let id = get(r, 'id');
    if (!id) id = [date, amount, get(r, 'description')].join('|').replace(/[^\w.-]+/g, '_').slice(0, 180);
    if (seen.has(id)) { warnings.push(`duplicate line id ${id} in the file, kept once`); continue; }
    seen.add(id);
    const currency = (get(r, 'currency') || '').toUpperCase();
    tx.push({
      id, date, currency,
      amount,
      debit: amount < 0 ? Math.abs(amount) : 0,
      credit: amount > 0 ? amount : 0,
      balance: num(get(r, 'balance')),
      description: get(r, 'description'),
      reference: get(r, 'reference'),
      merchant: get(r, 'merchant'),
      payer: get(r, 'payer'),
      payee: get(r, 'payee'),
      payeeAccount: get(r, 'payeeAccount'),
      cardLast4: get(r, 'cardLast4'),
      note: get(r, 'note'),
      fees: num(get(r, 'fees')) || 0,
      exchangeFrom: get(r, 'exchangeFrom'),
      exchangeTo: get(r, 'exchangeTo'),
      rate: num(get(r, 'rate')),
      exchangeToAmount: num(get(r, 'exchangeToAmount')),
      // who the money went to or came from, in one field
      counterparty: get(r, 'merchant') || get(r, 'payee') || get(r, 'payer') || get(r, 'description'),
    });
  }
  if (!tx.length) return { error: 'No usable rows in that file', warnings, header };
  const currencies = [...new Set(tx.map(t => t.currency).filter(Boolean))];
  const dates = tx.map(t => t.date).sort();
  return { tx, currencies, from: dates[0], till: dates[dates.length - 1], warnings, header };
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 8e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});
async function batchSet(db, writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    writes.slice(i, i + 400).forEach(w => b.set(w.ref, w.data, { merge: true }));
    await b.commit();
  }
}

async function handle(req, res, url, user, ctx) {
  const { db, admin, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = (user && user.email) || '';
  const P = '/api/accounting/wise/';
  if (!url.startsWith(P)) return false;
  const rest = url.slice(P.length).split('?')[0];
  const now = () => new Date().toISOString();

  if (rest === 'accounts' && req.method === 'GET') {
    const snap = await ws.collection('wiseAccounts').get();
    const out = [];
    for (const d of snap.docs) {
      const n = (await d.ref.collection('tx').select().get()).size;
      out.push({ ...d.data(), currency: d.id, lines: n });
    }
    return json(res, 200, out), true;
  }

  if (rest === 'tx' && req.method === 'GET') {
    // server.js hands us the path without its query string, so read it off req.url
    const cur = (new URL(req.url, 'http://x').searchParams.get('currency') || '').toUpperCase();
    if (!cur) return json(res, 400, { error: 'currency required' }), true;
    const snap = await ws.collection('wiseAccounts').doc(cur).collection('tx').get();
    return json(res, 200, snap.docs.map(d => d.data())), true;
  }

  // Dry run: say what the file holds without writing anything
  if (rest === 'preview' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.csv) return json(res, 400, { error: 'csv required' }), true;
    const p = parseStatement(b.csv);
    if (p.error) return json(res, 400, p), true;
    const byCur = {};
    for (const t of p.tx) {
      const c = t.currency || '?';
      byCur[c] = byCur[c] || { currency: c, lines: 0, in: 0, out: 0, from: t.date, till: t.date, closing: null };
      const s = byCur[c];
      s.lines++; s.in += t.credit; s.out += t.debit;
      if (t.date < s.from) s.from = t.date;
      if (t.date >= s.till) { s.till = t.date; if (t.balance != null) s.closing = t.balance; }
    }
    return json(res, 200, {
      count: p.tx.length, currencies: p.currencies, from: p.from, till: p.till,
      header: p.header, warnings: p.warnings.slice(0, 20),
      summary: Object.values(byCur),
      sample: p.tx.slice(0, 12),
    }), true;
  }

  if (rest === 'upload' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.csv) return json(res, 400, { error: 'csv required' }), true;
    const p = parseStatement(b.csv);
    if (p.error) return json(res, 400, p), true;
    const perCur = {};
    for (const t of p.tx) (perCur[t.currency || 'UNKNOWN'] = perCur[t.currency || 'UNKNOWN'] || []).push(t);
    const result = [];
    for (const [cur, list] of Object.entries(perCur)) {
      const accRef = ws.collection('wiseAccounts').doc(cur);
      const existing = new Set((await accRef.collection('tx').select().get()).docs.map(d => d.id));
      await batchSet(db, list.map(t => ({ ref: accRef.collection('tx').doc(t.id), data: { ...t, importedAt: now() } })));
      const dates = list.map(t => t.date).sort();
      const last = list.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
      await accRef.set({
        currency: cur, name: 'Wise ' + cur, lastUpload: now(),
        closing: last && last.balance != null ? last.balance : null,
        statements: admin.firestore.FieldValue.arrayUnion({
          from: dates[0], till: dates[dates.length - 1], filename: b.filename || '',
          lines: list.length, uploadedAt: now(), by: who
        })
      }, { merge: true });
      const added = list.filter(t => !existing.has(t.id)).length;
      result.push({ currency: cur, lines: list.length, added, updated: list.length - added,
        from: dates[0], till: dates[dates.length - 1], closing: last && last.balance != null ? last.balance : null });
    }
    return json(res, 200, { ok: true, accounts: result, warnings: p.warnings.slice(0, 20) }), true;
  }

  return false;
}

module.exports = { handle, parseStatement, parseCsv, isoDate };
