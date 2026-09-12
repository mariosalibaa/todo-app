// Reports for the accountant — SHIFT GROUP SARL (USD, company 2) in Lebanese pounds at HISTORICAL rates.
// Mounted by server.js under /api/reports/*; needs ctx = { odooCall, access }.
//
//   GET /api/reports/sarl-lbp[?fresh=1]   every posted journal line of the SARL with its LBP value, plus the
//                                          account list and the rate table. The page builds the trial balance
//                                          and the general ledger for any period from this one answer.
//
// Conversion (Mario's "option B", 2026-06-17, for his auditor): a line booked natively in LBP keeps its exact
// amount_currency; a USD line converts at the LBP/USD rate in force on the line's own date (res.currency.rate,
// carried forward — Lebanon has sat at 89,500 since Dec 2023). No balancing entry is ever injected: the debit /
// credit translation gap is shown as a footer, never booked. Same rules as d:\vscode\odoo\lbp-trial-balance.mjs
// and lbp-general-ledger.mjs, so the numbers here agree with the CSV / Excel he was given before.
//
// One Odoo pull is ~6,000 lines (3-8 s); it is kept in memory for CACHE_MS so the page opens at once after the
// first visit of the day, and ?fresh=1 forces a new pull.

const COMPANY = 2;      // SHIFT GROUP SARL (USD) — the official audited entity
const LBP = 95;         // res.currency id of the Lebanese pound
const CACHE_MS = 15 * 60000;
const CTX = { allowed_company_ids: [COMPANY] };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };

let cache = { at: 0, data: null, pending: null };

async function pull(odooCall) {
  const t0 = Date.now();
  const co = (await odooCall('res.company', 'read', [[COMPANY], ['name', 'currency_id']]))[0];
  let rates = await odooCall('res.currency.rate', 'search_read', [[['currency_id', '=', LBP], ['company_id', '=', COMPANY]]], { fields: ['name', 'rate'], order: 'name asc', context: CTX });
  if (!rates.length) rates = await odooCall('res.currency.rate', 'search_read', [[['currency_id', '=', LBP]]], { fields: ['name', 'rate'], order: 'name asc', context: CTX });
  rates = rates.map(r => ({ date: r.name, rate: r.rate }));
  const rateOn = date => { let r = rates[0] ? rates[0].rate : 89500; for (const x of rates) { if (x.date <= date) r = x.rate; else break; } return r; };

  const FIELDS = ['date', 'move_id', 'journal_id', 'partner_id', 'name', 'ref', 'account_id', 'debit', 'credit', 'balance', 'amount_currency', 'currency_id'];
  const raw = await odooCall('account.move.line', 'search_read',
    [[['company_id', '=', COMPANY], ['parent_state', '=', 'posted'], ['account_id', '!=', false]]],
    { fields: FIELDS, limit: 500000, order: 'date, move_id, id', context: CTX });

  // compact rows: [id, date, moveId, moveName, journal, partner, label, ref, accountId, debit, credit, lbp, rate|0]
  // rate 0 = the line was booked natively in LBP (amount_currency taken as is)
  const lines = raw.map(l => {
    const nativeLbp = l.currency_id && l.currency_id[0] === LBP;
    const rate = nativeLbp ? 0 : rateOn(l.date);
    const lbp = nativeLbp ? l.amount_currency : l.balance * rate;
    return [l.id, l.date, l.move_id ? l.move_id[0] : 0, l.move_id ? l.move_id[1] : '', l.journal_id ? l.journal_id[1] : '',
      l.partner_id ? l.partner_id[1] : '', l.name || '', l.ref || '', l.account_id[0], +l.debit || 0, +l.credit || 0, Math.round(lbp * 100) / 100, rate];
  });
  const accIds = [...new Set(lines.map(l => l[8]))];
  const accs = accIds.length ? await odooCall('account.account', 'read', [accIds, ['code', 'name', 'account_type']], { context: CTX }) : [];
  const accounts = Object.fromEntries(accs.map(a => [a.id, { code: a.code || '', name: a.name, type: a.account_type || '' }]));
  const data = { company: { id: COMPANY, name: co.name, currency: co.currency_id ? co.currency_id[1] : 'USD' }, rates, accounts, lines,
    pulledAt: new Date().toISOString(), ms: Date.now() - t0 };
  console.log(`reports: SARL pull ${lines.length} lines, ${accIds.length} accounts in ${data.ms} ms`);
  return data;
}

async function handle(req, res, url, user, ctx) {
  const [p, qs] = url.split('?');
  const q = new URLSearchParams(qs || '');
  if (p === '/api/reports/sarl-lbp' && req.method === 'GET') {
    const fresh = q.get('fresh') === '1' && ctx.access && ctx.access.admin;   // only Mario forces a re-pull
    if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return json(res, 200, { ...cache.data, cached: true });
    if (!cache.pending) cache.pending = pull(ctx.odooCall).then(d => { cache = { at: Date.now(), data: d, pending: null }; return d; }, e => { cache.pending = null; throw e; });
    const data = await cache.pending;
    return json(res, 200, { ...data, cached: false });
  }
  return false;
}

module.exports = { handle };
