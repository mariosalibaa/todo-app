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
const fmt2 = n => money(n).toFixed(2);
const now = () => new Date().toISOString();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// S LB (company 7): where the worker's own bills go
const SLB = { companyId: 7, company: 'S LB', journalId: 85, journal: 'Bills',
  accounts: { labour: 6026, fuel: 5983, other: 6072 }, accountNames: { 6026: '621100 Sub Contractor A', 5983: '626900 Fuel And Gas', 6072: '626990 Other Expenses' } };
const isFuel = t => /benzin|fuel|mazout|gasoil|diesel|tank/i.test(t || '');
const PEOPLE_CASH = { mario: 'mario-cash', abed: 'abed-cash', georges: 'georges-cash', ziad: 'ziad-cash', mitri: 'mitri-cash', khodr: 'khodr-cash', khoder: 'khodr-cash' };
const VENDOR_WORDS = /attal|tchagh|solaris|khoury|kbm|khc|njk|\bsec\b|simon|narinco|medco|electromec|metaleo|phoenix|astro|mecano|ayoub|karam|mousawi|hamdan|armco|linkifi|pharmac|sakr|fuser/i;

// What a row is. `partnerRaw` is the sheet's own word for the counterparty.
function natureOf({ credit, kind, partnerRaw, owner }) {
  const p = norm(partnerRaw);
  // money back from a supplier keeps the supplier and the project; money from one of our cash accounts feeds the ledger, no project
  if (credit && VENDOR_WORDS.test(p)) return { nature: 'refund', partnerKind: 'partner', cashAccountId: '' };
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
function guess(text, analytics, owner) {
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
  const top = scored.filter(x => x.s >= scored[0].s - 0.5);
  const mine = owner ? top.filter(x => new RegExp(owner, 'i').test(x.a.name)) : [];   // "BMW 318 (Shift — Abed)" over "BMW 320 (Dad)" on Abed's sheet
  return (mine.length ? mine : top).sort((x, y) => x.a.name.length - y.a.name.length)[0].a;   // several as good: the shortest name is the parent project
}
// The map for one account: every project the sheet uses, mapped or not.
async function analyticMapFor(ctx, account) {
  const { ws, txCol, odooCall, acc } = ctx;
  const analytics = await acc.analyticAccounts(odooCall);
  const map = await loadMap(ws);
  const tx = (await txCol(account).select('src', 'project', 'debit', 'nature').get()).docs.map(d => d.data());
  const used = {};
  for (const t of tx) { if (t.src !== 'excel' || !t.project) continue; const k = norm(t.project); if (!k) continue; const u = used[k] = used[k] || { key: k, text: t.project, rows: 0, amount: 0 }; u.rows++; u.amount = money(u.amount + (t.debit || 0)); }
  const out = []; let changed = false;
  for (const u of Object.values(used)) {
    let e = map[u.key];
    if (e === undefined || (e && !e.id) || (e === null)) { const g = guess(u.text, analytics, account.owner); const ne = g ? { id: g.id, name: g.name, src: 'auto', at: now() } : null; if (JSON.stringify(ne && ne.id) !== JSON.stringify(e && e.id)) { map[u.key] = ne; changed = true; } e = ne; }
    out.push({ ...u, analyticId: e ? e.id : null, analyticName: e ? e.name : '', src: e ? e.src : '' });
  }
  if (changed) await mapRef(ws).set({ map, updatedAt: now() }, { merge: true });
  return { projects: out.sort((a, b) => b.amount - a.amount || b.rows - a.rows), analytics: analytics.map(a => ({ id: a.id, name: a.name })) };
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
    const g = by[m] = by[m] || { month: m, rows: 0, amount: 0, labour: 0, expense: 0, labourAmount: 0, expenseAmount: 0, booked: 0, unmapped: {}, bills: {} };
    g[t.nature + 'Amount'] = money(g[t.nature + 'Amount'] + t.debit);
    g.rows++; g.amount = money(g.amount + t.debit); g[t.nature]++;
    if (t.bookedMove) g.booked++;
    if (t.project && !(map[norm(t.project)] || {}).id) g.unmapped[t.project] = (g.unmapped[t.project] || 0) + 1;
  }
  // the bills already in Odoo for these months
  const refs = Object.keys(by).flatMap(m => [refOf(account, m, 'labour'), refOf(account, m, 'expenses'), legacyRef(account, m)]);
  if (refs.length) {
    try {
      const found = await odooCall('account.move', 'search_read', [[['ref', 'in', refs], ['move_type', '=', 'in_invoice']]],
        { fields: ['id', 'name', 'ref', 'state', 'amount_total', 'payment_state'], context: { allowed_company_ids: [SLB.companyId] } });
      for (const f of found) {
        const mm = f.ref.match(/(\d{4}-\d{2})(?:-(LABOUR|EXPENSES))?$/); if (!mm || !by[mm[1]]) continue;
        const part = mm[2] === 'EXPENSES' ? 'expenses' : 'labour';
        by[mm[1]].bills[part] = { id: f.id, name: f.name && f.name !== '/' ? f.name : 'Draft ' + f.ref, ref: f.ref, state: f.state, amount: f.amount_total, paymentState: f.payment_state };
      }
    } catch (e) { /* Odoo down: months still list */ }
  }
  return Object.values(by).map(g => ({ ...g, unmapped: Object.entries(g.unmapped).map(([text, rows]) => ({ text, rows })) })).sort((a, b) => b.month.localeCompare(a.month));
}

// ── one month → two draft bills: his work, and what he fronted ─────────────
// Every line carries an analytic account: the row's project through the map; a row with
// no project (benzine on the way to a site) takes the project of his work that day, else
// the previous one; GENERAL is the last resort. Cost is never left untracked.
const GENERAL = 27;
const PARTS = { labour: { suffix: 'LABOUR', natures: ['labour'], label: 'his days' }, expenses: { suffix: 'EXPENSES', natures: ['expense'], label: 'what he fronted' } };
const refOf = (account, month, part) => `${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${month}-${PARTS[part].suffix}`;
const legacyRef = (account, month) => `${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${month}`;
// the analytic of every bookable row of the month, projects inherited where the sheet left them blank
function analyticsFor(rows, map) {
  const ordered = rows.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.nature === 'labour' ? -1 : 1));
  const byDay = {};
  for (const t of ordered) if (t.project && t.nature === 'labour') byDay[t.date] = byDay[t.date] || t.project;
  const nextAfter = date => { const d = Object.keys(byDay).sort().find(x => x > date); return d ? byDay[d] : ''; };
  let last = '';
  const out = {};
  for (const t of ordered) {
    let project = t.project || byDay[t.date] || last || nextAfter(t.date), from = t.project ? 'row' : byDay[t.date] ? 'same day' : last ? 'day before' : nextAfter(t.date) ? 'day after' : '';
    if (project) last = project;
    let id = t.analyticSrc === 'manual' && t.analyticId ? t.analyticId : ((map[norm(project)] || {}).id || null);
    let name = t.analyticSrc === 'manual' && t.analyticId ? t.analyticName : ((map[norm(project)] || {}).name || '');
    if (!id) { id = GENERAL; name = 'GENERAL'; from = project ? from + ', unmapped → GENERAL' : 'GENERAL'; }
    out[t.id] = { id, name, project, from };
  }
  return out;
}
async function bookMonth(ctx, account, month, part, who, opts) {
  const { ws, txCol, odooCall, acc } = ctx;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('month as yyyy-mm');
  if (!PARTS[part]) throw new Error('part must be labour or expenses');
  const partner = account.odooPartner;
  if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first (⚙): the bill is from him');
  const map = await loadMap(ws);
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data()).filter(t => bookable(t) && t.date.startsWith(month));
  const an = analyticsFor(all, map);
  const rows = all.filter(t => PARTS[part].natures.includes(t.nature)).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id)));
  if (!rows.length) throw new Error(`nothing to book for ${PARTS[part].label} in ${month}`);
  const ref = refOf(account, month, part);
  const ctxO = { allowed_company_ids: [SLB.companyId], company_id: SLB.companyId };

  const lines = rows.map(t => {
    const a = an[t.id];
    const accountId = t.nature === 'labour' ? SLB.accounts.labour : isFuel(t.partnerName + ' ' + t.description) ? SLB.accounts.fuel : SLB.accounts.other;
    const line = { name: `${t.date} · ${t.description || t.nature} · ${a.project || a.name}`, quantity: 1, price_unit: money(t.debit), account_id: accountId, tax_ids: [[6, 0, []]], analytic_distribution: { [String(a.id)]: 100 } };
    return { t, line, a, accountId };
  });

  // an existing draft with this ref (or, for labour, the old one-bill ref) is rewritten; a posted one is refused
  const refs = part === 'labour' ? [ref, legacyRef(account, month)] : [ref];
  const found = await odooCall('account.move', 'search_read', [[['ref', 'in', refs], ['move_type', '=', 'in_invoice']]], { fields: ['id', 'name', 'state', 'ref'], context: ctxO, limit: 2 });
  const existing = found.find(f => f.ref === ref) || found[0];
  let moveId, moveName, action;
  if (existing && existing.state !== 'draft') {
    if (!(opts && opts.redo)) throw new Error(`${existing.name} (${existing.ref}) is already ${existing.state} — reset it to draft in Odoo first`);
    await odooCall('account.move', 'button_draft', [[existing.id]], { context: ctxO });   // asked to redo: back to draft, rewritten below, posted again
  }
  const dateOf = rows[rows.length - 1].date;
  if (existing) {
    await odooCall('account.move', 'write', [[existing.id], { ref, invoice_line_ids: [[5, 0, 0], ...lines.map(l => [0, 0, l.line])], invoice_date: dateOf }], { context: ctxO });
    moveId = existing.id; moveName = existing.name && existing.name !== '/' ? existing.name : 'Draft ' + ref; action = 'rewritten';
  } else {
    moveId = await odooCall('account.move', 'create', [{
      move_type: 'in_invoice', company_id: SLB.companyId, journal_id: SLB.journalId, partner_id: +partner.id,
      invoice_date: dateOf, date: dateOf, ref,
      narration: `${account.name} — ${month}, ${PARTS[part].label}: ${rows.length} rows from the Excel ledger. Draft made by Shift Hub.`,
      invoice_line_ids: lines.map(l => [0, 0, l.line]),
    }], { context: ctxO });
    const [m] = await odooCall('account.move', 'read', [[moveId], ['name']], { context: ctxO });
    moveName = m.name && m.name !== '/' ? m.name : 'Draft ' + ref; action = 'created';
  }
  let state = 'draft';
  if (opts && opts.post) {
    await odooCall('account.move', 'action_post', [[moveId]], { context: ctxO });
    const [m2] = await odooCall('account.move', 'read', [[moveId], ['name', 'state']], { context: ctxO });
    moveName = m2.name; state = m2.state; action += ' and posted';
  }
  const total = money(rows.reduce((s, t) => s + t.debit, 0));
  const at = now();
  const writes = lines.map(l => ({ ref: col.doc(l.t.id), data: {
    bookedMove: { id: moveId, name: moveName, ref, month, part, at, state }, retype: false,
    ref: moveName, service: SLB.company,
    company: SLB.company, companySrc: 'odoo', kind: l.t.kind || 'work', kindSrc: l.t.kindSrc || 'odoo',
    partnerId: +partner.id,
    analyticId: l.a.id, analyticName: l.a.name, analyticSrc: l.t.analyticSrc === 'manual' ? 'manual' : 'excel', analyticFrom: l.a.from,
    odoo: { checkedAt: at, matches: [{ chosen: true, moveId, move: moveName, date: dateOf, amount: total, partner: partner.name, partnerId: +partner.id,
      label: l.line.name, company: SLB.company, journal: SLB.journal, state, docs: [], analytics: [{ id: l.a.id, name: l.a.name, from: 'bill' }],
      score: 10, why: ['one line of the month\'s ' + PARTS[part].label + ' bill, made from this row'] }] },
  } }));
  await acc.batchSet(ws.firestore, writes);
  const general = lines.filter(l => l.a.id === GENERAL).length, inherited = lines.filter(l => /same day|previous/.test(l.a.from)).length;
  return { month, part, action, moveId, move: moveName, ref, rows: rows.length, total, inherited, general, accounts: [...new Set(lines.map(l => SLB.accountNames[l.accountId]))] };
}

// ── everything else that must reach Odoo ────────────────────────────────────
const inOdoo = t => !!(t.odoo && (t.odoo.matches || []).some(x => x.chosen));
const CASH_JOURNAL = { 'S LB': { id: 87, companyId: 7 }, 'SHIFT GROUP SARL (USD)': { id: 21, companyId: 2 } };
const SARL_NAME = 'SHIFT GROUP SARL (USD)';
// what the SARL owes the partner on a date (credit − debit on his payable there)
async function sarlOwes(odooCall, partnerId, date) {
  const L = await odooCall('account.move.line', 'search_read', [[['partner_id', '=', partnerId], ['company_id', '=', 2], ['account_id.account_type', '=', 'liability_payable'], ['parent_state', '=', 'posted'], ['date', '<=', date]]], { fields: ['debit', 'credit'], context: { allowed_company_ids: [2] }, limit: 5000 });
  return money(L.reduce((s, l) => s + l.credit - l.debit, 0));
}
async function makePayment(odooCall, j, partner, amount, date, memo) {
  const ctxO = { allowed_company_ids: [j.companyId], company_id: j.companyId };
  let [p] = await odooCall('account.payment', 'search_read', [[['memo', '=', memo], ['company_id', '=', j.companyId], ['state', 'not in', ['canceled']]]], { fields: ['id', 'state', 'move_id', 'name'], context: ctxO, limit: 1 });
  if (p) return { p, found: true };
  const id = await odooCall('account.payment', 'create', [{ payment_type: 'outbound', partner_type: 'supplier', partner_id: +partner.id, amount: money(amount), date, journal_id: j.id, memo, company_id: j.companyId }], { context: ctxO });
  await odooCall('account.payment', 'action_post', [[id]], { context: ctxO });
  [p] = await odooCall('account.payment', 'read', [[id], ['id', 'state', 'move_id', 'name']], { context: ctxO });
  return { p, found: false };
}
const VENDOR_IDS = [[/attal/i, 13, 'Ste. ATTAL'], [/tchagh/i, 24, 'Tchaghlassian Steel'], [/solaris/i, 214, 'SOLARIS s.a.l'], [/khc|khoury hardware/i, 233, 'KHC Khoury Hardware Center s.a.r.l'], [/kbm|khoury building/i, 234, 'KBM Khoury Building Materials'], [/njk|nicolas khoury/i, 244, 'NJK Nicolas Khoury'], [/^khoury$/i, 233, 'KHC Khoury Hardware Center s.a.r.l']];
const RAW_MATERIALS = 5978;   // 611100 Purchasing Raw Materials, S LB

// Money handed to him = a payment to him from that cash, against his supplier account.
async function postPayments(ctx, account, who, opts) {
  const { ws, txCol, odooCall, acc } = ctx;
  const partner = account.odooPartner; if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const col = txCol(account);
  const rows = (await col.get()).docs.map(d => d.data())
    .filter(t => t.src === 'excel' && !t.excluded && t.credit > 0 && t.nature === 'transfer' && t.cashAccountId === 'mario-cash' && !inOdoo(t) && !t.bookedMove)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const out = { rows: rows.length, posted: 0, found: 0, skipped: [], total: 0 };
  if (opts && opts.dry) return { ...out, byYear: rows.reduce((o, t) => (o[t.date.slice(0, 4)] = (o[t.date.slice(0, 4)] || 0) + 1, o), {}) };
  const prefix = account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  for (const t of rows) {
    const memo = `${prefix}-${t.id}`;
    try {
      // the SARL's debt to him is paid first, from the SARL's own cash; the rest from S LB
      const owed = await sarlOwes(odooCall, +partner.id, t.date);
      const sarlPart = money(Math.min(Math.max(owed, 0), t.credit)), slbPart = money(t.credit - sarlPart);
      const parts = [];
      if (sarlPart > 0) parts.push({ j: CASH_JOURNAL[SARL_NAME], amount: sarlPart, memo: slbPart > 0 ? memo + '-sarl' : memo, company: SARL_NAME });
      if (slbPart > 0) parts.push({ j: CASH_JOURNAL['S LB'], amount: slbPart, memo: sarlPart > 0 ? memo + '-slb' : memo, company: 'S LB' });
      const made = [];
      for (const part of parts) { const r = await makePayment(odooCall, part.j, partner, part.amount, t.date, part.memo); made.push({ ...part, p: r.p }); if (r.found) out.found++; else out.posted++; }
      const first = made[0], p = first.p;
      const moveId = p.move_id ? p.move_id[0] : null, name = made.map(m => m.p.name || m.p.move_id[1]).join(' + ');
      const company = made.length === 1 ? first.company : 'SARL ' + fmt2(made[0].amount) + ' + S LB ' + fmt2(made[1].amount);
      out.total = money(out.total + t.credit);
      await col.doc(t.id).set({ bookedMove: { id: moveId, name, ref: memo, kind: 'payment', at: now(), state: p.state, parts: made.map(m => ({ name: m.p.name, amount: m.amount, company: m.company })) }, ref: name, service: made.length === 1 ? first.company : 'split',
        company: made.length === 1 ? first.company : made[0].company, companySrc: 'odoo',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId, move: name, date: t.date, amount: money(t.credit), partner: partner.name, partnerId: +partner.id, label: 'paid to ' + partner.name + ' from Cash Mario',
          company: t.company || 'S LB', journal: 'Cash Mario USD', state: p.state, docs: [], analytics: [], score: 10, why: ['payment made from this row'] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount: t.credit, error: String(e.message || e).slice(0, 160) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

// An unofficial supplier ticket he paid: the supplier's bill in S LB (no VAT), paid through Settlement by him.
async function postVendors(ctx, account, who, opts) {
  const { ws, txCol, odooCall, acc } = ctx;
  const partner = account.odooPartner; if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const map = await loadMap(ws);
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data());
  const rows = all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0 && t.nature === 'vendor' && !inOdoo(t) && !t.bookedMove).sort((a, b) => a.date < b.date ? -1 : 1);
  const an = analyticsFor(all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0), map);
  const out = { rows: rows.length, posted: 0, found: 0, noPartner: [], skipped: [], total: 0 };
  const prefix = account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const ctxO = { allowed_company_ids: [SLB.companyId], company_id: SLB.companyId };
  for (const t of rows) {
    const v = VENDOR_IDS.find(([rx]) => rx.test(t.partnerName || '')) || VENDOR_IDS.find(([rx]) => rx.test(t.description || ''));   // "abed · attal": the vendor is in the label
    if (!v) { out.noPartner.push({ id: t.id, date: t.date, amount: t.debit, partner: t.partnerName }); continue; }
    if (opts && opts.dry) { out.posted++; out.total = money(out.total + t.debit); continue; }
    const ref = `${prefix}-${t.id}`;
    try {
      let [bill] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'in_invoice']]], { fields: ['id', 'name', 'state', 'payment_state'], context: ctxO, limit: 1 });
      const a = an[t.id] || { id: GENERAL, name: 'GENERAL' };
      if (bill) out.found++;
      else {
        const id = await odooCall('account.move', 'create', [{ move_type: 'in_invoice', company_id: SLB.companyId, journal_id: SLB.journalId, partner_id: v[1], invoice_date: t.date, date: t.date, ref,
          narration: `${account.name}: paid by ${partner.name} on ${t.date} (Excel row, no VAT invoice). Made by Shift Hub.`,
          invoice_line_ids: [[0, 0, { name: `${t.date} · ${t.description || v[2]}`, quantity: 1, price_unit: money(t.debit), account_id: RAW_MATERIALS, tax_ids: [[6, 0, []]], analytic_distribution: { [String(a.id)]: 100 } }]] }], { context: ctxO });
        await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
        [bill] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
        out.posted++;
      }
      if (bill.payment_state === 'not_paid') {
        // Settlement journal + Paid by = him: the automation moves the debt onto his account
        const wctx = { ...ctxO, active_model: 'account.move', active_ids: [bill.id] };
        const wiz = await odooCall('account.payment.register', 'create', [{ journal_id: 194, payment_date: t.date, x_paid_by: +partner.id }], { context: wctx });
        await odooCall('account.payment.register', 'action_create_payments', [[wiz]], { context: wctx });
        [bill] = await odooCall('account.move', 'read', [[bill.id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
      }
      out.total = money(out.total + t.debit);
      await col.doc(t.id).set({ bookedMove: { id: bill.id, name: bill.name, ref, kind: 'vendor-bill', at: now(), state: bill.state, paymentState: bill.payment_state }, ref: bill.name, service: 'S LB',
        company: 'S LB', companySrc: 'odoo', partnerId: v[1], analyticId: a.id, analyticName: a.name, analyticSrc: t.analyticSrc === 'manual' ? 'manual' : 'excel',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: bill.id, move: bill.name, date: t.date, amount: money(t.debit), partner: v[2], partnerId: v[1], label: t.description,
          company: 'S LB', journal: 'Bills', state: bill.state, docs: [], analytics: [{ id: a.id, name: a.name, from: 'bill' }], score: 10, why: ['bill made from this row, settled by ' + partner.name] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount: t.debit, error: String(e.message || e).slice(0, 200) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

module.exports = { postPayments, postVendors, natureOf, analyticMapFor, saveMapEntry, applyMap, months, bookMonth, norm, SLB, loadMapPublic: loadMap, PARTS, GENERAL };
