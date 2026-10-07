// Project cost — one analytic account (project) read from Odoo's analytic lines, spread the way Mario reads it:
// labour per person (Abed, his son, the Raashin helpers he pays, Ibrahim, Hsein, Khoder, Ziad…), materials by supplier
// group, VAT on supplier invoices (a COST — the clients are billed from S LB without VAT, so the 11% paid to the
// suppliers is never recovered; Mario 2026-10-07), fuel, trips and transport, small purchases by the workers.
// Mounted by server.js under /api/projectcost/*; ctx = { odooCall }.
//
//   GET /api/projectcost/list[?fresh=1]   every project with invoiced / cost / profit / margin and its date span
//   GET /api/projectcost/one?id=<analytic id>   the spread, the invoice lines and every analytic line of that project
//
// One pull of every analytic line (~2,000) is cached CACHE_MS; ?fresh=1 forces a new pull.

const CACHE_MS = 10 * 60000;
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
let cache = { at: 0, data: null, pending: null };

async function pull(odooCall) {
  const t0 = Date.now();
  const accounts = await odooCall('account.analytic.account', 'search_read', [[]], { fields: ['name', 'plan_id', 'company_id', 'active'], context: { ...CTX, active_test: false } });
  const raw = await odooCall('account.analytic.line', 'search_read', [[]], { fields: ['account_id', 'date', 'amount', 'partner_id', 'general_account_id', 'name', 'move_line_id', 'company_id'], limit: 200000, order: 'date, id', context: CTX });
  const mlIds = [...new Set(raw.map(l => l.move_line_id && l.move_line_id[0]).filter(Boolean))];
  const moveOf = {};
  for (let i = 0; i < mlIds.length; i += 1000) {
    const ls = await odooCall('account.move.line', 'search_read', [[['id', 'in', mlIds.slice(i, i + 1000)]]], { fields: ['move_name', 'move_id'], context: CTX });
    for (const l of ls) moveOf[l.id] = { name: l.move_name, id: l.move_id && l.move_id[0] };
  }
  const lines = raw.map(l => {
    const mv = l.move_line_id ? moveOf[l.move_line_id[0]] : null;
    return { acc: l.account_id ? l.account_id[0] : 0, date: l.date, amount: l.amount, partner: l.partner_id ? l.partner_id[1] : '', partnerId: l.partner_id ? l.partner_id[0] : 0,
      account: l.general_account_id ? l.general_account_id[1] : '', name: l.name || '', move: mv ? mv.name : '', moveId: mv ? mv.id : 0, company: l.company_id ? l.company_id[1] : '' };
  });
  return { pulledAt: new Date().toISOString(), ms: Date.now() - t0, accounts: accounts.map(a => ({ id: a.id, name: a.name, plan: a.plan_id ? a.plan_id[1] : '', company: a.company_id ? a.company_id[1] : '', active: a.active })), lines };
}
async function data(odooCall, fresh) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!cache.pending) cache.pending = pull(odooCall).then(d => { cache = { at: Date.now(), data: d, pending: null }; return d; }).catch(e => { cache.pending = null; throw e; });
  return cache.pending;
}

const isRevenue = l => l.amount > 0 && /Sales|Revenue|70\d{4}/.test(l.account);
// the people whose days are booked on "Sub Contractor" through Abed's ledger
function labourKey(l) {
  const n = l.name, p = l.partner;
  if (/Raashin|helper/i.test(n)) { const m = n.match(/^\d{4}-\d{2}-\d{2} · ([^·]+?) ·/); return 'labour · ' + ((m ? m[1].trim() : 'helper') + ' (helper paid by ' + (p.split(' ')[0] || 'Abed') + ')'); }
  if (/with son/i.test(n)) return 'labour · Abed';   // split below
  if (/Abed Steel|^Abed/i.test(p)) return 'labour · Abed';
  if (/^ibrahim$/i.test(p)) return 'labour · Ibrahim (painter)';
  if (/Hsein/i.test(p)) return 'labour · Hsein (painter)';
  if (/Khoder/i.test(p)) return 'labour · Khoder';
  if (/Ziad/i.test(p)) return 'labour · Ziad';
  if (/Mitri/i.test(p)) return 'labour · Mitri';
  if (/Georges Matar/i.test(p)) return 'labour · Georges';
  return 'labour · ' + (p || 'other');
}
function classify(l) {
  const a = l.account, p = l.partner, n = l.name;
  if (/Sub Contractor|6026|621100/i.test(a)) return labourKey(l);
  if (/Fuel|626900/i.test(a)) return 'transport · fuel';
  if (/اجرة طريق|اجرة طرق|transport|camion|truck|نقل|taxi|pickup/i.test(n) || /camion|transport/i.test(p)) return 'transport · trips and trucks';
  if (/Vat Paid|442110/i.test(a)) return 'materials · VAT on supplier invoices';
  if (/Tchaghlassian|steel/i.test(p)) return 'materials · steel';
  if (/BMA|Tinol|paint/i.test(p)) return 'materials · paint';
  if (/ATTAL|KHC|KBM|NJK|Khoury|SOLARIS|Fouhoud|SEC\b/i.test(p)) return 'materials · hardware and electrical';
  if (/ROUNDING|rounding/i.test(n) || /rounding/i.test(l.move)) return 'rounding entries';
  if (/Pharmacie|^ibrahim$|Khoder|Ziad|Abed|Hsein|Mitri|Georges Matar/i.test(p)) return 'materials · small purchases by the workers';
  if (/Cost of Goods|Raw Materials|601101|611100|5965/i.test(a)) return 'materials · ' + (p || 'other suppliers');
  return 'other · ' + (a || 'unclassified');
}

function spread(all, id) {
  const lines = all.lines.filter(l => l.acc === id);
  const cats = {}, revenue = [];
  let invoiced = 0, cost = 0;
  const put = (k, v, l) => { const c = cats[k] = cats[k] || { key: k, total: 0, n: 0, lines: [] }; c.total = +(c.total + v).toFixed(2); c.n++; c.lines.push({ date: l.date, amount: +v.toFixed(2), partner: l.partner, name: l.name, move: l.move, moveId: l.moveId, company: l.company }); };
  for (const l of lines) {
    if (isRevenue(l)) { invoiced += l.amount; revenue.push({ date: l.date, amount: l.amount, partner: l.partner, name: l.name, move: l.move, moveId: l.moveId }); continue; }
    const v = -l.amount; cost += v;
    const k = classify(l);
    if (k === 'labour · Abed' && /with son/i.test(l.name)) { put('labour · Abed', 50, l); put("labour · Abed's son", v - 50, l); }
    else put(k, v, l);
  }
  const group = k => k.split(' · ')[0];
  const groups = {};
  for (const c of Object.values(cats)) { const g = groups[group(c.key)] = groups[group(c.key)] || { key: group(c.key), total: 0, n: 0 }; g.total = +(g.total + c.total).toFixed(2); g.n += c.n; }
  const dates = lines.map(l => l.date).sort();
  return { id, invoiced: +invoiced.toFixed(2), cost: +cost.toFixed(2), profit: +(invoiced - cost).toFixed(2), margin: invoiced ? +((invoiced - cost) / invoiced * 100).toFixed(1) : null,
    first: dates[0] || '', last: dates[dates.length - 1] || '', lines: lines.length,
    categories: Object.values(cats).sort((a, b) => b.total - a.total), groups: Object.values(groups).sort((a, b) => b.total - a.total), revenue };
}

async function handle(req, res, url, user, ctx) {
  const { odooCall } = ctx;
  const path = url.split('?')[0], q = new URL(req.url, 'http://x').searchParams;
  if (path === '/api/projectcost/list' && req.method === 'GET') {
    const all = await data(odooCall, q.get('fresh') === '1');
    const byAcc = {};
    for (const l of all.lines) { const s = byAcc[l.acc] = byAcc[l.acc] || { invoiced: 0, cost: 0, n: 0, first: '', last: '' }; if (isRevenue(l)) s.invoiced += l.amount; else s.cost -= l.amount; s.n++; if (!s.first || l.date < s.first) s.first = l.date; if (l.date > s.last) s.last = l.date; }
    const projects = all.accounts.filter(a => byAcc[a.id]).map(a => { const s = byAcc[a.id]; return { id: a.id, name: a.name, plan: a.plan, active: a.active, invoiced: +s.invoiced.toFixed(2), cost: +s.cost.toFixed(2), profit: +(s.invoiced - s.cost).toFixed(2), margin: s.invoiced ? +((s.invoiced - s.cost) / s.invoiced * 100).toFixed(1) : null, lines: s.n, first: s.first, last: s.last }; })
      .sort((a, b) => a.last < b.last ? 1 : -1);
    return json(res, 200, { pulledAt: all.pulledAt, projects });
  }
  if (path === '/api/projectcost/one' && req.method === 'GET') {
    const id = +q.get('id'); if (!id) return json(res, 400, { error: 'id required' });
    const all = await data(odooCall, q.get('fresh') === '1');
    const a = all.accounts.find(x => x.id === id); if (!a) return json(res, 404, { error: 'no such project' });
    return json(res, 200, { pulledAt: all.pulledAt, name: a.name, plan: a.plan, ...spread(all, id) });
  }
  return false;
}
module.exports = { handle, classify, spread };
