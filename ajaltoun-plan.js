// Ajaltoun 4193 — Budget (BOQ) and Plan (cashflow) behind the Accounts page.
// Mounted by ajaltoun.js under /api/ajaltoun/plan/*; needs ctx = { db, TEAM_ID, access }.
//
//   GET  /api/ajaltoun/plan                       { items, settings }
//   POST /api/ajaltoun/plan/item                  admin: { item } upsert (history stamped) · { id, delete: true }
//   POST /api/ajaltoun/plan/settings              admin: { settings } (merged)
//
// One model, three views (Mario, 2026-09-12): the BOQ summary lines are the BUDGET (per villa TYPE — U = "up 333",
// D = "down" — quantity × unit price, or a fixed amount); each item carries a trade (= the section the Odoo lines are
// classified into, so budget / spent / remaining line up) and a phase (site · structure · finishing) that the Plan
// places in a year per villa. The take-off sheets stay in Excel as the source of the quantities.
// Firestore: ajaltounBoq/<itemId> and ajaltounMeta/plan.

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// Defaults until Mario edits them on the page. Jean's U2 schedule comes from Odoo, not from here.
const DEFAULT_SETTINGS = {
  years: [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032],
  siteYear: 2026,                 // excavation, stone walls, site works: done once for the whole plot
  land: 650000,                   // agreed value between the partners (D3 agreement)
  d3LandHalf: 54167,              // Antoine's half of the D3 land, received by Mario in kind at signing
  fee: { total: 364350, startYear: 2026, phasing: [0.318, 0.153, 0.153, 0.153, 0.153, 0.07] },   // Shift's services fee, earned by year
  villas: {
    U1: { type: 'U', status: 'expected', price: 700000, saleYear: 2027, payYears: 6 },
    U2: { type: 'U', status: 'sold', structureYear: 2026, finishYear: 2027 },
    U3: { type: 'U', status: 'expected', price: 700000, saleYear: 2028, payYears: 6 },
    D1: { type: 'D', status: 'expected', price: 760000, saleYear: 2027, payYears: 6 },
    D2: { type: 'D', status: 'expected', price: 790000, saleYear: 2028, payYears: 6 },
    D3: { type: 'D', status: 'mario', structureYear: 2027, finishYear: 2028 },
  },
};

const FIELDS = ['type', 'bill', 'trade', 'name', 'unit', 'qty', 'price', 'amount', 'phase', 'note', 'source', 'review', 'ref'];   // ref = the 2026 reference rate (Fanar), kept across edits

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const col = db.collection('workspaces').doc(TEAM_ID).collection('ajaltounBoq');
  const setRef = db.collection('workspaces').doc(TEAM_ID).collection('ajaltounMeta').doc('plan');
  const who = user.name || user.displayName || user.email || '';

  if (url === '/api/ajaltoun/plan' && req.method === 'GET') {
    const [snap, s] = await Promise.all([col.get(), setRef.get()]);
    const items = snap.docs.map(d => d.data()).sort((a, b) => (a.type + String(a.bill || 0).padStart(3, '0') + (a.order || 0)).localeCompare(b.type + String(b.bill || 0).padStart(3, '0') + (b.order || 0)));
    const saved = s.data() || {};
    const settings = { ...DEFAULT_SETTINGS, ...saved, villas: { ...DEFAULT_SETTINGS.villas, ...(saved.villas || {}) }, fee: { ...DEFAULT_SETTINGS.fee, ...(saved.fee || {}) } };
    return json(res, 200, { items, settings, admin: !!access.admin });
  }

  if (!access.admin) return json(res, 403, { error: 'admin only' });

  if (url === '/api/ajaltoun/plan/item' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.delete && b.id) { await col.doc(String(b.id)).delete(); return json(res, 200, { ok: true }); }
    const it = b.item || {};
    const id = String(it.id || newId());
    const cur = (await col.doc(id).get()).data() || null;
    const next = { id, order: cur ? cur.order : Date.now(), history: cur ? (cur.history || []) : [], createdAt: cur ? cur.createdAt : now(), createdBy: cur ? cur.createdBy : who };
    const changes = [];
    for (const f of FIELDS) {
      let v = it[f];
      if (['qty', 'price', 'amount', 'bill'].includes(f)) v = v === '' || v == null ? null : +v;
      if (v === undefined) v = cur ? cur[f] : null;
      next[f] = v == null ? null : v;
      if (cur && JSON.stringify(cur[f] ?? null) !== JSON.stringify(next[f] ?? null)) changes.push({ f, from: cur[f] ?? null, to: next[f] });
    }
    if (!next.name) return json(res, 400, { error: 'name required' });
    // a line is qty × price when both are there, otherwise the fixed amount
    next.total = next.qty != null && next.price != null ? +(next.qty * next.price).toFixed(2) : (next.amount != null ? +next.amount : 0);
    if (changes.length) next.history = [...next.history, { at: now(), by: who, changes }].slice(-50);
    next.updatedAt = now(); next.updatedBy = who;
    await col.doc(id).set(next);
    return json(res, 200, { item: next });
  }

  if (url === '/api/ajaltoun/plan/settings' && req.method === 'POST') {
    const b = await readBody(req);
    const cur = (await setRef.get()).data() || {};
    const next = { ...cur, ...(b.settings || {}), villas: { ...(cur.villas || {}), ...((b.settings || {}).villas || {}) }, updatedAt: now(), updatedBy: who };
    await setRef.set(next);
    return json(res, 200, { ok: true });
  }

  return false;
}

module.exports = { handle, DEFAULT_SETTINGS };
