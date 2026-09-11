// Ajaltoun 4193 app — the project's accounts, read straight out of Odoo.
// Mounted by server.js under /api/ajaltoun/*; needs ctx = { db, TEAM_ID, odooCall, access }.
//
//   GET  /api/ajaltoun/data[?fresh=1]   everything the page shows (cached 10 min; fresh = admin re-pull)
//   GET  /api/ajaltoun/file/<attId>      an Odoo attachment (the bill scan), streamed for the viewer
//   POST /api/ajaltoun/section           { lineId, section, forPartner? }  admin: classify a line (or its whole supplier)
//   POST /api/ajaltoun/qty                { section, qty, unit }   admin: quantity done so far in a section (for $/unit)
//   POST /api/ajaltoun/approve           { lineIds: [], on: true|false }        admin (Mario): step 2
//   POST /api/ajaltoun/verify            { lineId, state: 'verified'|'flagged'|null, note? }   partner: step 3
//
// Review chain (Mario, 2026-09-12), built so an accountant fits in later without a redesign:
//   1. booked   — whoever enters the expense in Odoo (Mario today, the accountant later)
//   2. approved — Mario, as project manager, confirms it (bulk, from the filtered list)
//   3. verified — the partner (Antoine) sees only approved lines and verifies, or flags with a note; the flag
//                 goes back to Mario, whose answer clears it for a re-check.
// One doc per line in Firestore ajaltounVerify/<lineId>: { approved: {by,email,at}|null, verified: {...}|null, flag: {...,note}|null }.
// Admins approve and answer flags; they can never verify. Non-admins verify and flag; they can never approve.
//
// Odoo holds the villa dimension (analytic 69 = common works, 59-61 = U1-U3, 62-64 = D1-D3) across
// S DEV (co 10), SARL (co 2) and S LB (co 7). The WORK SECTION (excavation, stone walls, prefab,
// scaffolding…) is not in Odoo yet — Mario, 2026-09-12: keep it on the hub until the scheme is final —
// so it lives in Firestore ajaltounMeta/sections as supplier rules + per-line overrides.
// Prefab and scaffolding are EQUIPMENT: bought once, reusable on the next project, so they are shown
// apart and left out of the cost the partners share (Mario, 2026-09-12).

const plan = require('./ajaltoun-plan');   // budget (BOQ) + cashflow plan
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const SDEV = 10;
const VILLAS = { 69: 'Common', 59: 'U1', 60: 'U2', 61: 'U3', 62: 'D1', 63: 'D2', 64: 'D3' };
// sections = the BOQ trades (so budget / spent / remaining line up) + the project-level ones
const SECTIONS = [
  { id: 'excavation', name: 'Excavation' },
  { id: 'stone', name: 'Stone walls' },
  { id: 'concrete', name: 'Concrete & steel' },
  { id: 'blockwork', name: 'Block work' },
  { id: 'waterproofing', name: 'Waterproofing' },
  { id: 'joinery', name: 'Doors, kitchen & vanities' },
  { id: 'aluminium', name: 'Metal & aluminium' },
  { id: 'plaster', name: 'Plaster' },
  { id: 'tiling', name: 'Tiling, cladding & roof' },
  { id: 'painting', name: 'Painting' },
  { id: 'ceilings', name: 'Suspended ceilings' },
  { id: 'plumbing', name: 'Plumbing & sanitary' },
  { id: 'electrical', name: 'Electricity' },
  { id: 'hvac', name: 'Heating & ventilation' },
  { id: 'landscape', name: 'Terraces, green & fencing' },
  { id: 'lift', name: 'Lift' },
  { id: 'pool', name: 'Pool' },
  { id: 'prefab', name: 'Prefab', equipment: true },
  { id: 'scaffolding', name: 'Scaffolding', equipment: true },
  { id: 'topo', name: 'Topo & survey' },
  { id: 'design', name: 'Design & permits' },
  { id: 'general', name: 'Site & general' },
];
// first rules, by supplier; Mario refines them on the page
const DEFAULT_RULES = [
  { partner: 'georges el hajj', section: 'excavation' }, { partner: 'patrick hokayem', section: 'excavation' },
  { partner: 'monzer', section: 'stone' }, { partner: 'tchaghlassian', section: 'prefab' },
  { partner: 'singular', section: 'topo' }, { partner: 'hamoush', section: 'topo' }, { partner: 'peter moubarak', section: 'topo' },   // Mario 2026-09-12: these are topography, not design
];

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

let cache = { at: 0, data: null };

async function pull(odooCall) {
  // 1. every analytic line on the seven Ajaltoun accounts
  const raw = await odooCall('account.analytic.line', 'search_read', [[['account_id', 'in', Object.keys(VILLAS).map(Number)]]],
    { fields: ['date', 'name', 'amount', 'partner_id', 'general_account_id', 'company_id', 'account_id', 'move_line_id'], context: CTX, limit: 5000, order: 'date, id' });
  // 2. the journal item behind each → its move (bill) → its attachments
  const mlIds = [...new Set(raw.map(l => l.move_line_id && l.move_line_id[0]).filter(Boolean))];
  const mls = mlIds.length ? await odooCall('account.move.line', 'read', [mlIds, ['move_id', 'account_id']], { context: CTX }) : [];
  const moveOf = new Map(mls.map(m => [m.id, m.move_id]));
  const moveIds = [...new Set(mls.map(m => m.move_id && m.move_id[0]).filter(Boolean))];
  const moves = moveIds.length ? await odooCall('account.move', 'read', [moveIds, ['name', 'ref', 'invoice_date', 'date', 'payment_state', 'amount_total', 'journal_id']], { context: CTX }) : [];
  const moveById = new Map(moves.map(m => [m.id, m]));
  const atts = moveIds.length ? await odooCall('ir.attachment', 'search_read', [[['res_model', '=', 'account.move'], ['res_id', 'in', moveIds]]],
    { fields: ['res_id', 'name', 'mimetype'], context: CTX, limit: 5000 }) : [];
  const attsOf = {}; for (const a of atts) (attsOf[a.res_id] = attsOf[a.res_id] || []).push({ id: a.id, name: a.name, mime: a.mimetype });

  const lines = [];
  for (const l of raw) {
    const gacc = l.general_account_id ? l.general_account_id[1] : '';
    if (l.amount > 0 && /sales|revenue|income/i.test(gacc)) continue;   // the sale is handled below
    const mv = l.move_line_id ? moveOf.get(l.move_line_id[0]) : null;
    const move = mv ? moveById.get(mv[0]) : null;
    lines.push({ id: l.id, date: l.date, name: l.name, amount: -l.amount, partner: l.partner_id ? l.partner_id[1] : '', partnerId: l.partner_id ? l.partner_id[0] : null,
      account: gacc, company: l.company_id ? l.company_id[1] : '', companyId: l.company_id ? l.company_id[0] : null,
      villa: VILLAS[l.account_id[0]] || l.account_id[1], moveId: move ? move.id : null, moveName: move ? move.name : '', moveRef: move ? move.ref : '',
      paid: move ? move.payment_state : '', files: move ? (attsOf[move.id] || []) : [] });
  }

  // 3. the sale: U2 to Jean — invoice, instalments, what arrived
  const inv = await odooCall('account.move', 'search_read', [[['company_id', '=', SDEV], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted']]],
    { fields: ['name', 'partner_id', 'invoice_date', 'amount_total', 'amount_residual', 'payment_state'], context: CTX });
  const invIds = inv.map(i => i.id);
  const due = invIds.length ? await odooCall('account.move.line', 'search_read', [[['move_id', 'in', invIds], ['account_type', '=', 'asset_receivable']]],
    { fields: ['move_id', 'date_maturity', 'debit', 'amount_residual'], context: CTX, order: 'date_maturity' }) : [];
  const pays = await odooCall('account.payment', 'search_read', [[['company_id', '=', SDEV], ['payment_type', '=', 'inbound'], ['state', 'in', ['paid', 'posted', 'in_process']]]],
    { fields: ['date', 'amount', 'partner_id', 'journal_id', 'memo'], context: CTX, order: 'date' });
  const income = inv.map(i => ({ id: i.id, name: i.name, partner: i.partner_id[1], date: i.invoice_date, total: i.amount_total, residual: i.amount_residual, state: i.payment_state,
    schedule: due.filter(d => d.move_id[0] === i.id).map(d => ({ due: d.date_maturity, amount: d.debit, residual: d.amount_residual })),
    received: pays.filter(p => p.partner_id && p.partner_id[0] === i.partner_id[0]).map(p => ({ date: p.date, amount: p.amount, journal: p.journal_id[1], memo: p.memo })) }));

  // 4. where the project's cash sits (S DEV liquidity accounts)
  const cashLines = await odooCall('account.move.line', 'search_read', [[['company_id', '=', SDEV], ['account_id.account_type', '=', 'asset_cash'], ['parent_state', '=', 'posted']]],
    { fields: ['account_id', 'balance'], context: CTX, limit: 20000 });
  const wallets = {}; for (const c of cashLines) wallets[c.account_id[1]] = (wallets[c.account_id[1]] || 0) + c.balance;

  // 5. what is really still owed to suppliers (S DEV exists only for Ajaltoun): the payables ledger, net of payments not yet matched to their bill
  // (many cash payments were never reconciled with the bill they settle, so a bill's own "paid" flag misleads)
  const ap = await odooCall('account.move.line', 'search_read', [[['company_id', '=', SDEV], ['account_type', '=', 'liability_payable'], ['parent_state', '=', 'posted'], ['reconciled', '=', false]]],
    { fields: ['partner_id', 'amount_residual', 'company_id'], context: CTX, limit: 5000 });
  const ajPartners = new Set(lines.map(l => l.partnerId).filter(Boolean));
  const owedBy = {};
  for (const l of ap) { if (!l.partner_id || !ajPartners.has(l.partner_id[0])) continue; owedBy[l.partner_id[1]] = (owedBy[l.partner_id[1]] || 0) + l.amount_residual; }
  const owed = Object.entries(owedBy).filter(([, v]) => v < -0.5).map(([partner, v]) => ({ partner, amount: +(-v).toFixed(2) })).sort((a, b) => b.amount - a.amount);
  const prepaid = Object.entries(owedBy).filter(([, v]) => v > 0.5).map(([partner, v]) => ({ partner, amount: +v.toFixed(2) }));

  return { pulledAt: now(), lines, income, owed, prepaid, wallets: Object.entries(wallets).filter(([, v]) => Math.abs(v) > 0.005).map(([name, balance]) => ({ name, balance: +balance.toFixed(2) })) };
}

const metaRef = (db, TEAM_ID) => db.collection('workspaces').doc(TEAM_ID).collection('ajaltounMeta').doc('sections');
async function meta(db, TEAM_ID) {
  const d = (await metaRef(db, TEAM_ID).get()).data();
  return { rules: (d && d.rules) || DEFAULT_RULES, overrides: (d && d.overrides) || {}, qty: (d && d.qty) || {} };
}
// section of a line: an explicit override, else the first supplier rule that matches, else general
function sectionOf(l, m) {
  if (m.overrides[l.id]) return m.overrides[l.id];
  const p = (l.partner || '').toLowerCase(), n = (l.name || '').toLowerCase();
  const r = m.rules.find(r => (r.partner && p.includes(r.partner)) || (r.text && n.includes(r.text)));
  return r ? r.section : 'general';
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, odooCall, access } = ctx;
  let m;

  if (url.startsWith('/api/ajaltoun/plan')) return plan.handle(req, res, url, user, ctx);

  if (url === '/api/ajaltoun/data' && req.method === 'GET') {
    const fresh = /[?&]fresh=1/.test(req.url || '') && access.admin;
    if (fresh || !cache.data || Date.now() - cache.at > 10 * 60e3) { cache = { at: Date.now(), data: await pull(odooCall) }; }
    const mt = await meta(db, TEAM_ID);
    const vsnap = await db.collection('workspaces').doc(TEAM_ID).collection('ajaltounVerify').get();
    const ver = {}; for (const d of vsnap.docs) { const x = d.data(); ver[d.id] = x.state ? { approved: null, verified: x.state === 'verified' ? x : null, flag: x.state === 'flagged' ? x : null } : x; }   // (old one-field shape)
    const lines = cache.data.lines.map(l => ({ ...l, section: sectionOf(l, mt), review: ver[l.id] || null }));
    return json(res, 200, { ...cache.data, lines, sections: SECTIONS, rules: mt.rules, cachedAt: new Date(cache.at).toISOString(), admin: !!access.admin, canVerify: !access.admin, qtyDone: mt.qty });
  }

  if ((m = url.match(/^\/api\/ajaltoun\/file\/(\d+)$/)) && req.method === 'GET') {
    const [f] = await odooCall('ir.attachment', 'read', [[+m[1]], ['name', 'mimetype', 'datas']], { context: CTX });
    if (!f || !f.datas) return json(res, 404, { error: 'no such attachment' });
    res.writeHead(200, { 'Content-Type': f.mimetype || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`, 'Cache-Control': 'private, max-age=86400' });
    res.end(Buffer.from(f.datas, 'base64'));
    return true;
  }

  if (url === '/api/ajaltoun/section' && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    if (!SECTIONS.some(s => s.id === b.section)) return json(res, 400, { error: 'unknown section' });
    const mt = await meta(db, TEAM_ID);
    if (b.forPartner) {
      // the whole supplier: a rule at the front (first match wins), and the supplier's overrides cleared
      const p = String(b.forPartner).toLowerCase();
      mt.rules = [{ partner: p, section: b.section }, ...mt.rules.filter(r => r.partner !== p)];
      const ids = (cache.data ? cache.data.lines : []).filter(l => (l.partner || '').toLowerCase() === p).map(l => l.id);
      for (const id of ids) delete mt.overrides[id];
    } else if (b.lineId) {
      mt.overrides[b.lineId] = b.section;
    } else return json(res, 400, { error: 'lineId or forPartner required' });
    await metaRef(db, TEAM_ID).set({ rules: mt.rules, overrides: mt.overrides, qty: mt.qty, updatedAt: now(), updatedBy: user.email || '' });
    return json(res, 200, { ok: true });
  }

  // quantity executed so far in a section (m³ excavated, m² of wall…) — typed by Mario, gives the $/unit next to the BOQ rate
  if (url === '/api/ajaltoun/qty' && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    if (!SECTIONS.some(s => s.id === b.section)) return json(res, 400, { error: 'unknown section' });
    const mt = await meta(db, TEAM_ID);
    if (b.qty == null || b.qty === '') delete mt.qty[b.section];
    else mt.qty[b.section] = { qty: +b.qty, unit: String(b.unit || '').slice(0, 12), at: now(), by: user.email || '' };
    await metaRef(db, TEAM_ID).set({ rules: mt.rules, overrides: mt.overrides, qty: mt.qty, updatedAt: now(), updatedBy: user.email || '' });
    return json(res, 200, { qtyDone: mt.qty });
  }

  const stamp = () => ({ by: user.name || user.displayName || user.email || '', email: user.email || '', at: now() });
  const vcol = db.collection('workspaces').doc(TEAM_ID).collection('ajaltounVerify');

  // step 2 — Mario approves (or withdraws approval, which also drops any verification on the line)
  if (url === '/api/ajaltoun/approve' && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'only the project manager approves' });
    const b = await readBody(req);
    const ids = (Array.isArray(b.lineIds) ? b.lineIds : []).map(String).slice(0, 500);
    if (!ids.length) return json(res, 400, { error: 'lineIds required' });
    const batch = db.batch(); const out = {};
    for (const id of ids) {
      const cur = (await vcol.doc(id).get()).data() || { approved: null, verified: null, flag: null };
      const next = b.on ? { ...cur, approved: cur.approved || stamp() } : { approved: null, verified: null, flag: cur.flag || null };
      if (!next.approved && !next.verified && !next.flag) batch.delete(vcol.doc(id)); else batch.set(vcol.doc(id), next);
      out[id] = (!next.approved && !next.verified && !next.flag) ? null : next;
    }
    await batch.commit();
    return json(res, 200, { reviews: out });
  }

  // step 3 — the partner verifies or flags; the writer may only clear a flag he has answered
  if (url === '/api/ajaltoun/verify' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.lineId) return json(res, 400, { error: 'lineId required' });
    const ref = vcol.doc(String(b.lineId));
    const cur = (await ref.get()).data() || { approved: null, verified: null, flag: null };
    let next;
    if (access.admin) {
      if (!(b.state === null && cur.flag)) return json(res, 403, { error: 'the project manager cannot verify his own expenses — a partner must' });
      next = { ...cur, flag: null };
    } else if (b.state === 'verified') {
      if (!cur.approved) return json(res, 400, { error: 'not approved by the project manager yet' });
      next = { ...cur, verified: stamp(), flag: null };
    } else if (b.state === 'flagged') {
      next = { ...cur, verified: null, flag: { ...stamp(), note: String(b.note || '').slice(0, 500) } };
    } else if (b.state === null) {
      next = { ...cur, verified: null, flag: null };
    } else return json(res, 400, { error: 'state must be verified, flagged or null' });
    if (!next.approved && !next.verified && !next.flag) { await ref.delete(); return json(res, 200, { review: null }); }
    await ref.set(next);
    return json(res, 200, { review: next });
  }

  return false;
}

module.exports = { handle };
