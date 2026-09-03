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


// ── CSV statement (Whish app "Export CSV", 2026) ───────────────────────────
// Two blocks: a header row (statement_id,period_from,…,closing_balance) and the
// lines (statement_id,line_no,date,reference,service,description,debit,credit,balance).
// Dates arrive Excel-quoted as ="dd/mm/yyyy" / ="yyyy-mm-dd".
function csvSplit(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.replace(/^="?|"?$/g, '').trim());
}
const csvDate = s => {
  let m;
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return m[0];
  if ((m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/))) return m[3] + '-' + m[2] + '-' + m[1];
  return s;
};
function isCsvStatement(text) { return /^statement_id,period_from,period_to/m.test(text) && /^statement_id,line_no,date,reference/m.test(text); }
function parseCsvStatement(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const head = {}, tx = [], warnings = [];
  let mode = '';
  for (const l of lines) {
    if (/^statement_id,period_from/.test(l)) { mode = 'head'; continue; }
    if (/^statement_id,line_no/.test(l)) { mode = 'tx'; continue; }
    const c = csvSplit(l);
    if (mode === 'head' && c.length >= 14) {
      head.from = csvDate(c[1]); head.till = csvDate(c[2]); head.name = c[4]; head.phone = c[5].replace(/\D/g, '');
      head.account = c[6]; head.currency = c[9] || 'USD'; head.opening = num(c[10]);
      head.totalDebit = num(c[11]); head.totalCredit = num(c[12]); head.closing = num(c[13]);
      mode = '';
    } else if (mode === 'tx' && c.length >= 9) {
      const ref = (c[3].match(/(\d+)/) || [])[1];
      if (!ref) { warnings.push('no reference: ' + l); continue; }
      const desc = c[5].replace(/\s+/g, ' ').trim();
      tx.push({ id: ref, ref, date: csvDate(c[2]), service: c[4].trim(), description: desc, ...counterparty(desc),
        debit: num(c[6]) || 0, credit: num(c[7]) || 0, balance: num(c[8]) });
    }
  }
  // running-balance check, same tolerance as the PDF parser
  let prev = head.opening ?? null;
  for (const t of tx) {
    if (prev != null && Math.abs(prev - t.debit + t.credit - t.balance) > 0.011) warnings.push('balance break at tr:' + t.ref);
    prev = t.balance;
  }
  if (head.closing != null && tx.length && Math.abs(tx[tx.length - 1].balance - head.closing) > 0.011)
    warnings.push('closing balance ' + head.closing + ' != last line ' + tx[tx.length - 1].balance);
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

// ── Name similarity ────────────────────────────────────────────────────────
// "ELIE ABOU RJEILI" (Whish) vs "Elie Abou Rjayle EAR" (Odoo): shared words
// plus a bigram score, so spelling drift in transliterated names still scores.
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const bigrams = s => { const g = new Set(); const t = s.replace(/ /g, ''); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const wa = a.split(' ').filter(w => w.length > 2), wb = b.split(' ').filter(w => w.length > 2);
  const shared = wa.filter(w => wb.includes(w)).length;
  const words = wa.length && wb.length ? shared / Math.min(wa.length, wb.length) : 0;
  const ga = bigrams(a), gb = bigrams(b);
  let inter = 0; for (const g of ga) if (gb.has(g)) inter++;
  const dice = (ga.size + gb.size) ? (2 * inter) / (ga.size + gb.size) : 0;
  return Math.max(words, dice);
}

// Analytic accounts reachable from a payment: never on the payment itself
// (it hits receivable/payable), always on the invoice/bill it is reconciled
// with — payment line → partial reconcile → counterpart doc → product lines.
async function analyticOfMoves(odooCall, moveIds, ctx) {
  const out = {};
  if (!moveIds.length) return out;
  const L = await odooCall('account.move.line', 'search_read', [[['move_id', 'in', moveIds]]],
    { fields: ['id', 'move_id', 'analytic_distribution', 'matched_debit_ids', 'matched_credit_ids'], context: ctx, limit: 5000 });
  const partialIds = [...new Set(L.flatMap(l => [...(l.matched_debit_ids || []), ...(l.matched_credit_ids || [])]))];
  const P = partialIds.length ? await odooCall('account.partial.reconcile', 'search_read', [[['id', 'in', partialIds]]],
    { fields: ['id', 'debit_move_id', 'credit_move_id'], context: ctx, limit: 5000 }) : [];
  const own = new Set(L.map(l => l.id));
  const cpIds = [...new Set(P.flatMap(p => [p.debit_move_id[0], p.credit_move_id[0]]))].filter(id => !own.has(id));
  const CP = cpIds.length ? await odooCall('account.move.line', 'search_read', [[['id', 'in', cpIds]]],
    { fields: ['id', 'move_id'], context: ctx, limit: 5000 }) : [];
  const docIds = [...new Set(CP.map(l => l.move_id[0]))];
  const DL = docIds.length ? await odooCall('account.move.line', 'search_read', [[['move_id', 'in', docIds], ['display_type', '=', 'product']]],
    { fields: ['move_id', 'analytic_distribution'], context: ctx, limit: 5000 }) : [];
  const anIds = [...new Set([...L, ...DL].flatMap(l => Object.keys(l.analytic_distribution || {})).flatMap(k => k.split(',')))].map(Number).filter(Boolean);
  const AN = anIds.length ? await odooCall('account.analytic.account', 'search_read', [[['id', 'in', anIds]]],
    { fields: ['id', 'name', 'company_id'], context: ctx }) : [];
  const byId = Object.fromEntries(AN.map(a => [a.id, a]));
  const docOfLine = Object.fromEntries(CP.map(l => [l.id, l.move_id]));
  const anOfDoc = {};
  for (const l of DL) for (const k of Object.keys(l.analytic_distribution || {})) for (const p of k.split(','))
    (anOfDoc[l.move_id[0]] = anOfDoc[l.move_id[0]] || new Set()).add(+p);

  for (const l of L) {
    const mv = l.move_id[0];
    const rec = out[mv] = out[mv] || { analytics: [], docs: [] };
    // analytic straight on the payment (rare, but honour it)
    for (const k of Object.keys(l.analytic_distribution || {})) for (const p of k.split(',')) {
      const a = byId[+p]; if (a && !rec.analytics.some(x => x.id === a.id)) rec.analytics.push({ id: a.id, name: a.name, from: 'payment' });
    }
    for (const pid of [...(l.matched_debit_ids || []), ...(l.matched_credit_ids || [])]) {
      const pr = P.find(x => x.id === pid); if (!pr) continue;
      for (const li of [pr.debit_move_id[0], pr.credit_move_id[0]]) {
        const doc = docOfLine[li]; if (!doc) continue;
        if (!rec.docs.includes(doc[1])) rec.docs.push(doc[1]);
        for (const p of (anOfDoc[doc[0]] || [])) {
          const a = byId[p]; if (a && !rec.analytics.some(x => x.id === a.id)) rec.analytics.push({ id: a.id, name: a.name, from: doc[1] });
        }
      }
    }
  }
  return out;
}

// Match statement lines against the Odoo Whish journals.
// Same amount within ±3 days is only a candidate: several real payments often
// share both. Candidates are scored (exact date, partner-name similarity, the
// phone in the label) and assigned ONE-TO-ONE — a payment already claimed by a
// better-fitting statement line cannot be reused — so a row is called
// ambiguous only when two candidates genuinely tie.
async function odooCheck(odooCall, txs) {
  const { rows: journals, ctx } = await whishJournals(odooCall);
  if (!journals.length) return {};
  const accIds = journals.map(j => j.default_account_id && j.default_account_id[0]).filter(Boolean);
  const dates = txs.map(t => t.date).sort();
  const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const days = (a, b) => Math.round(Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
  const lines = await odooCall('account.move.line', 'search_read', [[
    ['account_id', 'in', accIds], ['date', '>=', shift(dates[0], -3)], ['date', '<=', shift(dates[dates.length - 1], 3)]
  ]], { fields: ['id', 'move_id', 'date', 'debit', 'credit', 'amount_currency', 'partner_id', 'name', 'ref', 'company_id', 'journal_id', 'parent_state'],
        context: ctx, limit: 5000 });

  const anByMove = await analyticOfMoves(odooCall, [...new Set(lines.map(l => l.move_id[0]))], ctx);
  const asMatch = (l, score, why) => {
    const rec = anByMove[l.move_id[0]] || { analytics: [], docs: [] };
    return {
      lineId: l.id, moveId: l.move_id[0], move: l.move_id[1], date: l.date,
      amount: l.debit || l.credit, partner: l.partner_id ? l.partner_id[1] : '', label: l.name || l.ref || '',
      company: l.company_id ? l.company_id[1] : '', journal: l.journal_id ? l.journal_id[1] : '', state: l.parent_state,
      docs: rec.docs, analytics: rec.analytics, score: Math.round(score * 10) / 10, why
    };
  };

  // 1. candidates per row
  const cand = new Map();
  for (const t of txs) {
    const want = t.debit || t.credit;
    const lo = shift(t.date, -3), hi = shift(t.date, 3);
    const who = [t.name, t.contactName].filter(Boolean);
    const tail = (t.phone || '').slice(-6);
    const list = [];
    for (const l of lines) {
      if (l.date < lo || l.date > hi) continue;
      // statement debit (money out) = credit on the Odoo cash account, and vice versa
      const sameAmount = Math.abs((t.debit ? l.credit : l.debit) - want) < 0.011
        || (l.amount_currency && Math.abs(Math.abs(l.amount_currency) - want) < 0.011);
      if (!sameAmount) continue;
      const why = [];
      let score = 4 - days(t.date, l.date);                       // exact date 4 → 3 days away 1
      if (!days(t.date, l.date)) why.push('same date');
      const text = [l.partner_id ? l.partner_id[1] : '', l.name || '', l.ref || ''].join(' ');
      const sim = who.length ? Math.max(...who.map(n => similarity(n, l.partner_id ? l.partner_id[1] : ''))) : 0;
      if (sim > 0.45) { score += 5 * sim; why.push('name ' + Math.round(sim * 100) + '%'); }
      if (tail && text.replace(/\D/g, '').includes(tail)) { score += 3; why.push('phone in label'); }
      list.push({ l, score, why });
    }
    cand.set(t.id, list);
  }

  // 2. one-to-one assignment, best score first
  const pairs = [];
  for (const [id, list] of cand) for (const c of list) pairs.push({ id, ...c });
  pairs.sort((a, b) => b.score - a.score);
  const takenLine = new Set(), takenRow = new Set(), chosen = new Map();
  for (const p of pairs) {
    if (takenRow.has(p.id) || takenLine.has(p.l.id)) continue;
    takenRow.add(p.id); takenLine.add(p.l.id); chosen.set(p.id, p);
  }

  // 3. result: the chosen match first, rivals kept for reference
  const out = {};
  for (const t of txs) {
    const list = cand.get(t.id) || [];
    if (!list.length) { out[t.id] = []; continue; }
    const win = chosen.get(t.id);
    const rest = list.filter(c => c.l.id !== (win && win.l.id)).sort((a, b) => b.score - a.score);
    const ordered = win ? [win, ...rest] : rest;
    // ambiguous only when the runner-up is just as good AND is still free
    const ambiguous = ordered.length > 1 && ordered[1].score >= ordered[0].score - 0.01 && !takenLine.has(ordered[1].l.id);
    out[t.id] = ordered.map((c, i) => ({ ...asMatch(c.l, c.score, c.why), chosen: i === 0 && !ambiguous }));
  }
  return out;
}

// Editable annotation fields; *Src = who filled it ('manual' | 'suggest' | 'google')
const ANNOT = ['note', 'kind', 'analyticId', 'analyticName', 'company', 'noteSrc', 'kindSrc', 'analyticSrc', 'analyticFrom'];

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
    if (!body.text && !body.pdfBase64 && !body.csv) return json(res, 400, { error: 'text, csv or pdfBase64 required' });
    let parsed;
    if (body.csv) {
      if (!isCsvStatement(body.csv)) return json(res, 400, { error: 'Not a Whish CSV statement' });
      parsed = parseCsvStatement(body.csv);
    } else {
      const text = body.text || (await pdfParse(Buffer.from(body.pdfBase64, 'base64'))).text;
      parsed = parseStatement(text);
    }
    const { head, tx, warnings } = parsed;
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
    const addedIds = tx.filter(t => !existing.has(t.id)).map(t => t.id);
    return json(res, 200, { account: head.account, head, lines: tx.length, added: addedIds.length, updated: tx.length - addedIds.length, addedIds, warnings });
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
      // the scorer compares the Odoo partner with what we know the number is called
      const cs = await ws.collection('whishContacts').get();
      const names = Object.fromEntries(cs.docs.map(d => [d.id, (d.data().name || '')]));
      const found = await odooCheck(odooCall, txs.map(t => ({ ...t, contactName: names[t.phone] || '' })));
      const at = now();
      const writes = txs.map(t => {
        const matches = found[t.id] || [];
        const data = { odoo: { checkedAt: at, matches } };
        const win = matches.find(m => m.chosen);
        if (win) {
          if (win.partner) data.odooPartner = win.partner;
          // Project from the analytic account of the invoice/bill this payment
          // is reconciled with. Anything you typed yourself (src 'manual') wins.
          const an = (win.analytics || [])[0];
          if (an && t.analyticSrc !== 'manual') {
            data.analyticId = an.id; data.analyticName = an.name;
            data.analyticSrc = 'odoo'; data.analyticFrom = an.from;
          }
        }
        return { ref: col.doc(t.id), data };
      });
      await batchSet(db, writes);
      return json(res, 200, found);
    } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  // Telegram relay for the folder watcher: api.telegram.org is unreachable from
  // Mario's laptop, so the watcher posts here and the hub forwards it.
  // { text, chatId?, parseMode? } — chat defaults to TELEGRAM_CHAT_ID.
  if (url === '/api/accounting/notify' && req.method === 'POST') {
    const body = await readBody(req);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = body.chatId || process.env.TELEGRAM_CHAT_ID || process.env.ACCOUNTING_CHAT_ID;
    if (!token || !chat) return json(res, 503, { error: 'telegram not configured' });
    if (!body.text) return json(res, 400, { error: 'text required' });
    const tg = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(body.text).slice(0, 4000), parse_mode: body.parseMode || undefined, disable_web_page_preview: true })
    });
    const out = await tg.json().catch(() => ({}));
    return json(res, tg.ok ? 200 : 502, { sent: tg.ok, error: out.description });
  }

  return false;
}

module.exports = { handle, parseStatement, parseCsvStatement, isCsvStatement, normalizePhone };
