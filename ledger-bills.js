// Booking a worker's ledger into Odoo.
//
// A worker's Excel row is one of four things, decided when the sheet is read (`nature`):
//   transfer  money moved between him and one of our own cash accounts — never a bill
//   labour    his own day or hours — a bill from him, account 621100 Sub Contractor A
//   expense   something unofficial he paid (benzine, misc, tools) — a bill from him, an expense account
//   vendor    an official supplier with a VAT invoice (Attal, Tchaghlassian…) — the supplier's
//             own bill, paid through Settlement "Paid by" him; left to the rules engine
//
// `bookMonth` turns one month of labour + expense rows into ONE draft vendor bill from the
// worker in S LB (journal Bills, no tax), one invoice line per row, each line carrying the
// row's project as its analytic account. The bill's ref is <ACCOUNT>-<yyyy-mm>, so booking
// a month twice rewrites the same draft instead of making a second one (posted bills are
// left alone). Each row then remembers the bill (`bookedMove`) and shows it as ✓.
//
// The project names in a sheet ("HSJ", "jouret ballout", "EAR") are matched to the Odoo
// analytic accounts once, by name, and kept in settings/analyticMap; a person may fix any
// of them from the page and the fix holds for every later import and booking.
const money = n => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// S LB (company 7): where the worker's own bills go
const SLB = { companyId: 7, company: 'S LB', journalId: 85, journal: 'Bills',
  accounts: { labour: 6026, fuel: 5983, other: 6072 }, accountNames: { 6026: '621100 Sub Contractor A', 5983: '626900 Fuel And Gas', 6072: '626990 Other Expenses' } };
const isFuel = t => /benzin|fuel|mazout|gasoil|diesel|tank/i.test(t || '');
const PEOPLE_CASH = { mario: 'mario-cash', abed: 'abed-cash', georges: 'georges-cash', ziad: 'ziad-cash', mitri: 'mitri-cash', khodr: 'khodr-cash', khoder: 'khodr-cash' };
const VENDOR_WORDS = /attal|tchagh|solaris|khoury|kbm|khc|njk|\bsec\b|simon|narinco|medco|electromec|metaleo|phoenix|astro|mecano|ayoub|karam|mousawi|hamdan|armco|richani|isf tanks|linkifi|pharmac|sakr|fuser|coil/i;

// What a row is. `partnerRaw` is the sheet's own word for the counterparty.
function natureOf({ credit, kind, partnerRaw, owner }) {
  const p = norm(partnerRaw);
  if (credit) return { nature: 'transfer', partnerKind: 'cash', cashAccountId: PEOPLE_CASH[p] || 'mario-cash' };
  if (PEOPLE_CASH[p] && p !== owner) return { nature: 'transfer', partnerKind: 'cash', cashAccountId: PEOPLE_CASH[p] };
  if (kind === 'labour' || p === owner) return { nature: 'labour', partnerKind: 'partner', cashAccountId: '' };
  if (kind === 'opening' || kind === 'note') return { nature: '', partnerKind: '', cashAccountId: '' };
  if (VENDOR_WORDS.test(p)) return { nature: 'vendor', partnerKind: 'partner', cashAccountId: '' };
  return { nature: 'expense', partnerKind: 'partner', cashAccountId: '' };
}

// ── analytic map ───────────────────────────────────────────────────────────
const mapRef = ws => ws.collection('settings').doc('analyticMap');
async function loadMap(ws) { const d = await mapRef(ws).get(); return d.exists ? (d.data().map || {}) : {}; }
async function saveMapEntry(ws, key, entry, who) {
  const k = norm(key); if (!k) throw new Error('empty project name');
  await mapRef(ws).set({ map: { [k]: entry ? { id: +entry.id, name: String(entry.name || ''), src: 'manual', by: who, at: now() } : null }, updatedAt: now() }, { merge: true });
  return k;
}
// Name matching: exact, then one side contains the other, then most shared words — only
// when a single analytic account wins clearly. Anything doubtful is left for a person.
function guess(text, analytics) {
  const t = norm(text); if (!t) return null;
  const words = t.split(' ').filter(w => w.length > 2);
  const scored = analytics.map(a => {
    const n = norm(a.name);
    if (n === t) return { a, s: 10 };
    if (n.includes(t) || t.includes(n)) return { a, s: 6 + Math.min(t.length, n.length) / Math.max(t.length, n.length) };
    const nw = n.split(' ');
    const shared = words.filter(w => nw.some(x => x === w || (w.length > 4 && x.startsWith(w.slice(0, 5))))).length;
    return { a, s: shared ? 2 + shared / words.length + shared / nw.length : 0 };
  }).filter(x => x.s >= 2.6).sort((x, y) => y.s - x.s);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].s >= scored[0].s - 0.5 && scored[0].s < 10) return null;   // two candidates as good: ask
  return scored[0].a;
}
// The map for one account: every project the sheet uses, mapped or not.
async function analyticMapFor(ctx, account) {
  const { ws, txCol, odooCall, acc } = ctx;
  const analytics = await acc.analyticAccounts(odooCall);
  const map = await loadMap(ws);
  const tx = (await txCol(account).select('src', 'project', 'debit', 'nature').get()).docs.map(d => d.data());
  const used = {};
  for (const t of tx) { if (t.src !== 'excel' || !t.project) continue; const k = norm(t.project); if (!k) continue; (used[k] = used[k] || { key: k, text: t.project, rows: 0 }).rows++; }
  const out = []; let changed = false;
  for (const u of Object.values(used)) {
    let e = map[u.key];
    if (e === undefined) { const g = guess(u.text, analytics); e = g ? { id: g.id, name: g.name, src: 'auto', at: now() } : null; map[u.key] = e; changed = true; }
    out.push({ ...u, analyticId: e ? e.id : null, analyticName: e ? e.name : '', src: e ? e.src : '' });
  }
  if (changed) await mapRef(ws).set({ map, updatedAt: now() }, { merge: true });
  return { projects: out.sort((a, b) => b.rows - a.rows), analytics: analytics.map(a => ({ id: a.id, name: a.name })) };
}
// Push the map onto the rows (analyticId/Name with src 'excel'); a manual pick on a row stays.
async function applyMap(ctx, account) {
  const { ws, txCol, acc } = ctx;
  const map = await loadMap(ws);
  const col = txCol(account);
  const docs = (await col.where('src', '==', 'excel').get()).docs;
  const writes = [];
  for (const d of docs) {
    const t = d.data(); if (!t.project || t.analyticSrc === 'manual' || t.analyticSrc === 'odoo') continue;
    const e = map[norm(t.project)];
    const want = e ? { analyticId: e.id, analyticName: e.name, analyticSrc: 'excel' } : { analyticId: null, analyticName: t.project, analyticSrc: 'excel' };
    if (t.analyticId !== want.analyticId || t.analyticName !== want.analyticName) writes.push({ ref: d.ref, data: want });
  }
  await acc.batchSet(ws.firestore, writes);
  return writes.length;
}

// ── months ─────────────────────────────────────────────────────────────────
const bookable = t => t.src === 'excel' && !t.excluded && t.debit > 0 && (t.nature === 'labour' || t.nature === 'expense');
async function months(ctx, account) {
  const { txCol, odooCall } = ctx;
  const tx = (await txCol(account).get()).docs.map(d => d.data());
  const map = await loadMap(ctx.ws);
  const by = {};
  for (const t of tx) {
    if (!bookable(t)) continue;
    const m = t.date.slice(0, 7);
    const g = by[m] = by[m] || { month: m, rows: 0, amount: 0, labour: 0, expense: 0, booked: 0, unmapped: {}, bill: null };
    g.rows++; g.amount = money(g.amount + t.debit); g[t.nature]++;
    if (t.bookedMove) g.booked++;
    if (t.project && !(map[norm(t.project)] || {}).id) g.unmapped[t.project] = (g.unmapped[t.project] || 0) + 1;
  }
  // the bills already in Odoo for these months
  const refs = Object.keys(by).map(m => `${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${m}`);
  if (refs.length) {
    try {
      const found = await odooCall('account.move', 'search_read', [[['ref', 'in', refs], ['move_type', '=', 'in_invoice']]],
        { fields: ['id', 'name', 'ref', 'state', 'amount_total', 'payment_state'], context: { allowed_company_ids: [SLB.companyId] } });
      for (const f of found) { const m = f.ref.slice(-7); if (by[m]) by[m].bill = { id: f.id, name: f.name && f.name !== '/' ? f.name : 'Draft ' + f.ref, state: f.state, amount: f.amount_total, paymentState: f.payment_state }; }
    } catch (e) { /* Odoo down: months still list */ }
  }
  return Object.values(by).map(g => ({ ...g, unmapped: Object.entries(g.unmapped).map(([text, rows]) => ({ text, rows })) })).sort((a, b) => b.month.localeCompare(a.month));
}

// ── one month → one draft bill ─────────────────────────────────────────────
async function bookMonth(ctx, account, month, who) {
  const { ws, txCol, odooCall, acc } = ctx;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('month as yyyy-mm');
  const partner = account.odooPartner;
  if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first (⚙): the bill is from him');
  const map = await loadMap(ws);
  const col = txCol(account);
  const rows = (await col.get()).docs.map(d => d.data()).filter(t => bookable(t) && t.date.startsWith(month)).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id)));
  if (!rows.length) throw new Error('nothing to book in ' + month);
  const ref = `${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${month}`;
  const ctxO = { allowed_company_ids: [SLB.companyId], company_id: SLB.companyId };

  const lines = rows.map(t => {
    const analyticId = t.analyticSrc === 'manual' && t.analyticId ? t.analyticId : ((map[norm(t.project || '')] || {}).id || t.analyticId || null);
    const accountId = t.nature === 'labour' ? SLB.accounts.labour : isFuel(t.partnerName + ' ' + t.description) ? SLB.accounts.fuel : SLB.accounts.other;
    const line = { name: `${t.date} · ${t.description || t.nature}${t.project ? ' · ' + t.project : ''}`, quantity: 1, price_unit: money(t.debit), account_id: accountId, tax_ids: [[6, 0, []]] };
    if (analyticId) line.analytic_distribution = { [String(analyticId)]: 100 };
    return { t, line, analyticId, accountId };
  });
  const unmapped = lines.filter(l => !l.analyticId && l.t.project).map(l => l.t.project);

  // an existing bill with this ref: rewrite it while it is a draft, refuse once posted
  const [existing] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'in_invoice']]], { fields: ['id', 'name', 'state'], context: ctxO, limit: 1 });
  let moveId, moveName, action;
  if (existing && existing.state !== 'draft') throw new Error(`${existing.name} for ${month} is already ${existing.state} — reset it to draft in Odoo first`);
  if (existing) {
    await odooCall('account.move', 'write', [[existing.id], { invoice_line_ids: [[5, 0, 0], ...lines.map(l => [0, 0, l.line])], invoice_date: rows[rows.length - 1].date }], { context: ctxO });
    moveId = existing.id; moveName = existing.name && existing.name !== '/' ? existing.name : 'Draft ' + ref; action = 'rewritten';
  } else {
    moveId = await odooCall('account.move', 'create', [{
      move_type: 'in_invoice', company_id: SLB.companyId, journal_id: SLB.journalId, partner_id: +partner.id,
      invoice_date: rows[rows.length - 1].date, date: rows[rows.length - 1].date, ref,
      narration: `${account.name} — ${month}: ${rows.length} rows from the Excel ledger (${lines.filter(l => l.t.nature === 'labour').length} labour, ${lines.filter(l => l.t.nature === 'expense').length} expenses). Draft made by Shift Hub.`,
      invoice_line_ids: lines.map(l => [0, 0, l.line]),
    }], { context: ctxO });
    const [m] = await odooCall('account.move', 'read', [[moveId], ['name']], { context: ctxO });
    moveName = m.name && m.name !== '/' ? m.name : 'Draft ' + ref; action = 'created';
  }
  const total = money(rows.reduce((s, t) => s + t.debit, 0));
  // every row now points at the bill and shows it as its Odoo entry
  const at = now();
  const writes = lines.map(l => ({ ref: col.doc(l.t.id), data: {
    bookedMove: { id: moveId, name: moveName, ref, month, at },
    ref: moveName, service: SLB.company,
    company: SLB.company, companySrc: 'odoo', kind: l.t.kind || 'work', kindSrc: l.t.kindSrc || 'odoo',
    partnerId: +partner.id,
    ...(l.analyticId ? { analyticId: l.analyticId, analyticName: (map[norm(l.t.project || '')] || {}).name || l.t.analyticName || '', analyticSrc: l.t.analyticSrc === 'manual' ? 'manual' : 'excel' } : {}),
    odoo: { checkedAt: at, matches: [{ chosen: true, moveId, move: moveName, date: rows[rows.length - 1].date, amount: total, partner: partner.name, partnerId: +partner.id,
      label: l.line.name, company: SLB.company, journal: SLB.journal, state: 'draft', docs: [], analytics: l.analyticId ? [{ id: l.analyticId, name: l.line.name, from: 'bill' }] : [],
      score: 10, why: ['one line of the month\'s bill, made from this row'] }] },
  } }));
  await acc.batchSet(ws.firestore, writes);
  return { month, action, moveId, move: moveName, ref, rows: rows.length, total, labour: lines.filter(l => l.t.nature === 'labour').length, expense: lines.filter(l => l.t.nature === 'expense').length,
    unmappedProjects: [...new Set(unmapped)], accounts: [...new Set(lines.map(l => SLB.accountNames[l.accountId]))] };
}

module.exports = { natureOf, analyticMapFor, saveMapEntry, applyMap, months, bookMonth, norm, SLB, loadMapPublic: loadMap };
