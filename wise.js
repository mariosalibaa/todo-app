// Wise section of the accounting app — multi-currency balance statements.
// Mounted by server.js under /api/accounting/wise/*; needs ctx = { db, admin, TEAM_ID }.
// Firestore layout (all under workspaces/<team>):
//   wiseAccounts/<balanceId>           { balanceId, currency, name, lastUpload, statements[] }
//   wiseAccounts/<balanceId>/tx/<id>   one statement line, keyed by Wise's own transaction id
//
// Keyed by BALANCE, not by currency: a Wise profile can hold several balances in the same
// currency (main USD, two USD stocks jars, an interest jar...), and merging them would be
// wrong. Wise names each export statement_<balanceId>_<CUR>_<from>_<to>.csv, so the balance
// id comes off the filename; a file with no id falls back to its currency.
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

// statement_10012290_USD_2025-01-01_2025-12-31.csv -> { balanceId: '10012290', currency: 'USD' }
function fromFilename(name) {
  const m = String(name || '').match(/statement[_-](\d{4,})[_-]([A-Z]{3})/i);
  return m ? { balanceId: m[1], currency: m[2].toUpperCase() } : {};
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
  // A balance with no movement in the period exports a header and nothing else. That is a
  // valid statement, not a broken file, so say so plainly.
  if (!tx.length) return { error: 'That balance had no transactions in this period', empty: true, warnings, header };
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


// ═══════════════════════════════════════════════════════════════════════════
// Continuous import through the Wise API (no browser, no scraping).
//   WISE_API_TOKEN        personal API token, read-only is enough (wise.com → Settings → API tokens)
//   WISE_PRIVATE_KEY      PEM of the RSA key whose PUBLIC half is registered on the Wise account
//                         (or WISE_PRIVATE_KEY_FILE, default ~/.wise/private.pem on Mario's laptop)
//   WISE_PROFILE_ID       optional; otherwise the personal profile is used
// Statement endpoints are behind Strong Customer Authentication: Wise answers 403 with a
// one-time token in x-2fa-approval; we sign it with the private key and retry. That is the
// whole "2FA" — no phone, no code, so it can run from a cron.
//
// !! BUSINESS ACCOUNTS ONLY (checked on wise.com 2026-09-04). Wise's "Manage your public keys"
// page states: "As part of our ongoing improvements in compliance with ... (PSD2), we no longer
// support signing API requests to complete strong customer authentication on personal Wise
// accounts. You can no longer retrieve account statements or fund payments using this method."
// Mario's Wise is a PERSONAL account, so syncFromApi() cannot fetch its statements. The code is
// kept because it works unchanged for a business profile; until then use the CSV import.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const WISE_API = process.env.WISE_API_BASE || 'https://api.transferwise.com';

function wiseConfig() {
  const token = (process.env.WISE_API_TOKEN || '').trim();
  let key = (process.env.WISE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!key) {
    const f = process.env.WISE_PRIVATE_KEY_FILE || pathMod.join(os.homedir(), '.wise', 'private.pem');
    try { key = fs.readFileSync(f, 'utf8'); } catch {}
  }
  return { token, key, profileId: process.env.WISE_PROFILE_ID || '' };
}
function signSca(token, key) {
  return crypto.createSign('RSA-SHA256').update(token).sign(key, 'base64');
}
async function wiseFetch(path, cfg, extraHeaders = {}) {
  const headers = { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json', ...extraHeaders };
  const r = await fetch(WISE_API + path, { headers });
  if (r.status === 403 && r.headers.get('x-2fa-approval-result') === 'REJECTED' && r.headers.get('x-2fa-approval')) {
    if (!cfg.key) throw new Error('Wise asks for strong customer authentication but no private key is configured (WISE_PRIVATE_KEY)');
    const ott = r.headers.get('x-2fa-approval');
    const r2 = await fetch(WISE_API + path, { headers: { ...headers, 'x-2fa-approval': ott, 'X-Signature': signSca(ott, cfg.key) } });
    if (!r2.ok) throw new Error(`Wise ${r2.status} after SCA on ${path}: ${(await r2.text()).slice(0, 300)}`);
    return r2.json();
  }
  if (!r.ok) throw new Error(`Wise ${r.status} on ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// One statement line from the JSON statement → the same shape the CSV importer stores
function mapApiTx(t, currency) {
  const d = t.details || {};
  const value = Number((t.amount || {}).value || 0);
  const amount = t.type === 'DEBIT' ? -Math.abs(value) : Math.abs(value);
  const merchant = d.merchant && d.merchant.name ? d.merchant.name : '';
  const recipient = d.recipient && d.recipient.name ? d.recipient.name : '';
  const sender = d.senderName || '';
  const ex = t.exchangeDetails || {};
  return {
    id: String(t.referenceNumber || '').trim() || [t.date, amount, d.description].join('|').replace(/[^\w.-]+/g, '_').slice(0, 180),
    date: String(t.date || '').slice(0, 10),
    currency: (t.amount && t.amount.currency) || currency,
    amount,
    debit: amount < 0 ? Math.abs(amount) : 0,
    credit: amount > 0 ? amount : 0,
    balance: t.runningBalance && t.runningBalance.value != null ? Number(t.runningBalance.value) : null,
    description: d.description || '',
    reference: d.paymentReference || '',
    merchant, payer: sender, payee: recipient,
    payeeAccount: d.recipient && d.recipient.bankAccount ? String(d.recipient.bankAccount) : '',
    cardLast4: d.cardLastFourDigits || '',
    note: '',
    fees: t.totalFees && t.totalFees.value != null ? Number(t.totalFees.value) : 0,
    exchangeFrom: ex.fromAmount ? ex.fromAmount.currency : '',
    exchangeTo: ex.toAmount ? ex.toAmount.currency : '',
    rate: ex.rate != null ? Number(ex.rate) : null,
    exchangeToAmount: ex.toAmount ? Number(ex.toAmount.value) : null,
    kind: d.type || t.type || '',
    counterparty: merchant || recipient || sender || d.description || '',
    source: 'api',
  };
}

// Pull every balance of the profile from the day after the last stored line (minus a
// 3-day overlap, in case Wise back-dates something) up to now. Idempotent by design.
async function syncFromApi(ctx, opts = {}) {
  const { db, admin, TEAM_ID } = ctx;
  const cfg = wiseConfig();
  if (!cfg.token) throw new Error('WISE_API_TOKEN is not set');
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const now = () => new Date().toISOString();

  let profileId = cfg.profileId;
  if (!profileId) {
    const profiles = await wiseFetch('/v2/profiles', cfg);
    const personal = profiles.find(p => String(p.type).toUpperCase() === 'PERSONAL') || profiles[0];
    if (!personal) throw new Error('no Wise profile on this token');
    profileId = personal.id;
  }
  const balances = await wiseFetch(`/v4/profiles/${profileId}/balances?types=STANDARD,SAVINGS`, cfg);
  const result = [];
  for (const bal of balances) {
    const cur = String(bal.currency || '').toUpperCase();
    if (!cur) continue;
    const label = bal.type === 'SAVINGS' ? `${cur}-${String(bal.name || 'jar').replace(/[^\w-]+/g, '_')}` : cur;
    const accRef = ws.collection('wiseAccounts').doc(label);
    const existingSnap = await accRef.collection('tx').select('date').get();
    const existing = new Set(existingSnap.docs.map(d => d.id));
    const lastDate = existingSnap.docs.map(d => d.get('date')).filter(Boolean).sort().pop();
    const start = new Date(opts.since || (lastDate ? Date.parse(lastDate) - 3 * 86400000 : Date.now() - 365 * 86400000));
    const end = new Date();
    const q = `currency=${cur}&intervalStart=${start.toISOString()}&intervalEnd=${end.toISOString()}&type=COMPACT`;
    const st = await wiseFetch(`/v1/profiles/${profileId}/balance-statements/${bal.id}/statement.json?${q}`, cfg);
    const list = (st.transactions || []).map(t => mapApiTx(t, cur));
    if (list.length) await batchSet(db, list.map(t => ({ ref: accRef.collection('tx').doc(t.id), data: { ...t, importedAt: now() } })));
    const closing = st.endOfStatementBalance && st.endOfStatementBalance.value != null ? Number(st.endOfStatementBalance.value)
      : (bal.amount && bal.amount.value != null ? Number(bal.amount.value) : null);
    await accRef.set({
      currency: cur, name: bal.type === 'SAVINGS' ? `Wise ${cur} · ${bal.name || 'jar'}` : 'Wise ' + cur,
      balanceId: bal.id, balanceType: bal.type || 'STANDARD', profileId,
      lastUpload: now(), lastSync: now(), closing,
      statements: admin.firestore.FieldValue.arrayUnion({
        from: start.toISOString().slice(0, 10), till: end.toISOString().slice(0, 10), filename: 'api',
        lines: list.length, uploadedAt: now(), by: opts.by || 'wise-api'
      })
    }, { merge: true });
    const added = list.filter(t => !existing.has(t.id)).length;
    result.push({ currency: cur, account: label, lines: list.length, added, updated: list.length - added, closing, from: start.toISOString().slice(0, 10) });
  }
  await ws.collection('wiseMeta').doc('sync').set({ at: now(), profileId, result, by: opts.by || 'wise-api' }, { merge: true });
  return { profileId, accounts: result };
}

async function handle(req, res, url, user, ctx) {
  const { db, admin, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = (user && user.email) || '';
  const P = '/api/accounting/wise/';
  if (!url.startsWith(P)) return false;
  const rest = url.slice(P.length).split('?')[0];
  const now = () => new Date().toISOString();

  if (rest === 'status' && req.method === 'GET') {
    const cfg = wiseConfig();
    const meta = await ws.collection('wiseMeta').doc('sync').get();
    return json(res, 200, { configured: !!cfg.token, hasKey: !!cfg.key, lastSync: meta.exists ? meta.data() : null }), true;
  }
  if (rest === 'sync' && req.method === 'POST') {
    try { return json(res, 200, await syncFromApi(ctx, { by: who })), true; }
    catch (e) { return json(res, 502, { error: String(e.message || e) }), true; }
  }

  if (rest === 'accounts' && req.method === 'GET') {
    const snap = await ws.collection('wiseAccounts').get();
    const out = [];
    for (const d of snap.docs) {
      const n = (await d.ref.collection('tx').select().get()).size;
      const x = d.data();
      out.push({ ...x, key: d.id, currency: x.currency || d.id, lines: n });
    }
    return json(res, 200, out), true;
  }

  if (rest === 'tx' && req.method === 'GET') {
    // server.js hands us the path without its query string, so read it off req.url
    const key = new URL(req.url, 'http://x').searchParams.get('currency') || '';
    if (!key) return json(res, 400, { error: 'balance required' }), true;
    const snap = await ws.collection('wiseAccounts').doc(key).collection('tx').get();
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
    const meta = fromFilename(b.filename);
    const keyOf = t => meta.balanceId || t.currency || 'UNKNOWN';
    const perCur = {};
    for (const t of p.tx) (perCur[keyOf(t)] = perCur[keyOf(t)] || []).push(t);
    const result = [];
    for (const [key, list] of Object.entries(perCur)) {
      const cur = list[0].currency || meta.currency || '';
      const accRef = ws.collection('wiseAccounts').doc(key);
      const existing = new Set((await accRef.collection('tx').select().get()).docs.map(d => d.id));
      await batchSet(db, list.map(t => ({ ref: accRef.collection('tx').doc(t.id), data: { ...t, importedAt: now() } })));
      const dates = list.map(t => t.date).sort();
      const last = list.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
      await accRef.set({
        balanceId: meta.balanceId || '', currency: cur,
        name: b.accountName || ('Wise ' + cur + (meta.balanceId ? ' \u00b7 ' + meta.balanceId : '')),
        lastUpload: now(),
        closing: last && last.balance != null ? last.balance : null,
        statements: admin.firestore.FieldValue.arrayUnion({
          from: dates[0], till: dates[dates.length - 1], filename: b.filename || '',
          lines: list.length, uploadedAt: now(), by: who
        })
      }, { merge: true });
      const added = list.filter(t => !existing.has(t.id)).length;
      result.push({ key, currency: cur, lines: list.length, added, updated: list.length - added,
        from: dates[0], till: dates[dates.length - 1], closing: last && last.balance != null ? last.balance : null });
    }
    return json(res, 200, { ok: true, accounts: result, warnings: p.warnings.slice(0, 20) }), true;
  }

  return false;
}

module.exports = { handle, parseStatement, parseCsv, isoDate, syncFromApi, mapApiTx, signSca, wiseConfig };
