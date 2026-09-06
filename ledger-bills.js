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
// A row carrying `noBook: true` is never booked by any of the runs below. It is the flag for a
// row whose automatic booking was wrong and was deleted from Odoo by hand: without it the next
// run would resolve the same vendor from the same words and recreate the same wrong bill. The
// row keeps counting in the balance (unlike `excluded`); `noBookNote` says why.
//
// The project names in a sheet ("HSJ", "jouret ballout", "EAR") are matched to the Odoo
// analytic accounts once, by name, and kept in settings/analyticMap; a person may fix any
// of them from the page and the fix holds for every later import and booking.
const money = n => Math.round(Number(n || 0) * 100) / 100;
const fmt2 = n => money(n).toFixed(2);
const now = () => new Date().toISOString();
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Where a worker's own bills go. S LB by default (Abed, Khodr); an account may name another
// company in `billCompany` — Georges works Ajaltoun, so his payable and his bills live in
// SHIFT DEVELOPMENT, where his supplier bills and his cash journal already were (Mario, 2026-09-06).
const SLB = { companyId: 7, company: 'S LB', journalId: 85, journal: 'Bills', sett: 194, misc: 65, payable: 5778, rawMaterials: 5978,
  accounts: { labour: 6026, fuel: 5983, other: 6072 }, accountNames: { 6026: '621100 Sub Contractor A', 5983: '626900 Fuel And Gas', 6072: '626990 Other Expenses' } };
const SDEV = { companyId: 10, company: 'SHIFT DEVELOPMENT', journalId: 140, journal: 'BILL', sett: 195, misc: 136, payable: 8631, rawMaterials: 8844,
  accounts: { labour: 8889, fuel: 8929, other: 8936 }, accountNames: { 8889: '621100 Sub Contractor A', 8929: '626900 Fuel and Gas', 8936: '626990 Other Expenses' } };
const BOOK_CO = { 'S LB': SLB, 'SHIFT DEVELOPMENT': SDEV, 'S DEV': SDEV };
const bookCo = account => BOOK_CO[(account && account.billCompany) || 'S LB'] || SLB;
const isFuel = t => /benzin|fuel|mazout|gasoil|diesel|tank/i.test(t || '') && !/water tank/i.test(t || '');
const PEOPLE_CASH = { mario: 'mario-cash', abed: 'abed-cash', georges: 'georges-cash', ziad: 'ziad-cash', mitri: 'mitri-cash', khodr: 'khodr-cash', khoder: 'khodr-cash' };
const VENDOR_WORDS = /attal|tchag|solaris|khoury|kbm|khc|njk|\bsec\b|simon|narinco|medco|electromec|metaleo|phoenix|astro|mecano|ayoub|karam|mousawi|hamdan|armco|linkifi|pharmac|sakr|fuser|monzer|mrad|fahed/i;
// Georges writes the goods where the others write the shop: a bag of cement, a pipe or a
// panel is a supplier's ticket (mrad, Fahed Wood), not petty spending out of his pocket.
const GOODS_WORDS = /cement|trabe|\bpipe\b|inches tube|nylon wire|wood \d|\d panels/i;

// What a row is. `partnerRaw` is the sheet's own word for the counterparty.
function natureOf({ credit, kind, partnerRaw, owner }) {
  // "To Ziad" / "from Mario" name one of our cash accounts as much as "Ziad" does
  const p = norm(String(partnerRaw || '').replace(/^\s*(to|from)\s+/i, ''));
  // money back from a supplier keeps the supplier and the project; money from one of our cash accounts feeds the ledger, no project
  if (credit && VENDOR_WORDS.test(p)) return { nature: 'refund', partnerKind: 'partner', cashAccountId: '' };
  if (credit) return { nature: 'transfer', partnerKind: 'cash', cashAccountId: PEOPLE_CASH[p] || 'mario-cash' };
  // himself, whatever the sheet spells him (khodr / khoder both point at khodr-cash): his own work, never a transfer
  const self = p === norm(owner) || (PEOPLE_CASH[p] && PEOPLE_CASH[p] === PEOPLE_CASH[norm(owner)]);
  if (PEOPLE_CASH[p] && !self) return { nature: 'transfer', partnerKind: 'cash', cashAccountId: PEOPLE_CASH[p] };
  if (kind === 'labour' || self) return { nature: 'labour', partnerKind: 'partner', cashAccountId: '' };
  // what he was already owed the day the sheet starts: a line of the first labour bill, so Odoo starts where the sheet starts
  if (kind === 'opening') return { nature: 'opening', partnerKind: 'partner', cashAccountId: '' };
  if (kind === 'note') return { nature: '', partnerKind: '', cashAccountId: '' };
  if (VENDOR_WORDS.test(p) || GOODS_WORDS.test(p)) return { nature: 'vendor', partnerKind: 'partner', cashAccountId: '' };
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
  const tx = (await txCol(account).select('src', 'project', 'debit', 'credit', 'nature', 'partnerName', 'description', 'excluded').get()).docs.map(d => d.data());
  const used = {};
  // what each project cost, split the way the bills split it: his days, benzine, misc, official vendors
  for (const t of tx) {
    if (t.src !== 'excel' || !t.project || t.excluded) continue; const k = norm(t.project); if (!k) continue;
    const u = used[k] = used[k] || { key: k, text: t.project, rows: 0, amount: 0, labour: 0, benzine: 0, misc: 0, vendor: 0 };
    u.rows++; const d = t.debit || 0; u.amount = money(u.amount + d);
    const part = t.nature === 'labour' ? 'labour' : t.nature === 'vendor' || t.nature === 'refund' ? 'vendor' : isFuel(t.partnerName + ' ' + t.description) ? 'benzine' : 'misc';
    u[part] = money(u[part] + (t.nature === 'refund' ? -(t.credit || 0) : d));
  }
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
const bookable = t => t.src === 'excel' && !t.excluded && t.debit > 0 && (t.nature === 'labour' || t.nature === 'expense' || t.nature === 'opening');
async function months(ctx, account) {
  const { txCol, odooCall } = ctx;
  const tx = (await txCol(account).get()).docs.map(d => d.data());
  const map = await loadMap(ctx.ws);
  const by = {};
  for (const t of tx) {
    if (!bookable(t)) continue;
    const m = t.date.slice(0, 7);
    const g = by[m] = by[m] || { month: m, rows: 0, amount: 0, labour: 0, expense: 0, opening: 0, labourAmount: 0, expenseAmount: 0, openingAmount: 0, benzine: 0, benzineAmount: 0, misc: 0, miscAmount: 0, booked: 0, unmapped: {}, bills: {} };
    g[t.nature + 'Amount'] = money(g[t.nature + 'Amount'] + t.debit);
    g.rows++; g.amount = money(g.amount + t.debit); g[t.nature]++;
    if (t.nature === 'opening') { g.labour++; g.labourAmount = money(g.labourAmount + t.debit); }
    // the expenses bill, as Mario reads it: benzine on its own, everything else misc
    if (t.nature === 'expense') { const k = isFuel(t.partnerName + ' ' + t.description) ? 'benzine' : 'misc'; g[k]++; g[k + 'Amount'] = money(g[k + 'Amount'] + t.debit); }
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
const PARTS = { labour: { suffix: 'LABOUR', natures: ['labour', 'opening'], label: 'his days' }, expenses: { suffix: 'EXPENSES', natures: ['expense'], label: 'what he fronted' } };
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
  const CO = bookCo(account);
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
  const ctxO = { allowed_company_ids: [CO.companyId], company_id: CO.companyId };

  // an analytic account tied to another company cannot go on an S LB bill: Odoo refuses the
  // whole bill. Such a line falls back to GENERAL and is reported, so one bad mapping never
  // blocks a month (free the analytic in Odoo, or map the project elsewhere, then Rewrite).
  const wrongCompany = [];
  try {
    const known = await acc.analyticAccounts(odooCall);
    const byId = Object.fromEntries(known.map(x => [x.id, x]));
    for (const t of rows) {
      const a = an[t.id], k = a && byId[a.id];
      if (k && k.company && k.company !== CO.company) { wrongCompany.push({ id: t.id, date: t.date, project: a.project || a.name, analytic: k.name, company: k.company }); an[t.id] = { ...a, id: GENERAL, name: 'GENERAL' }; }
    }
  } catch (e) { /* Odoo list unavailable: book as mapped */ }

  const lines = rows.map(t => {
    const a = an[t.id];
    const accountId = t.nature === 'labour' || t.nature === 'opening' ? CO.accounts.labour : isFuel(t.partnerName + ' ' + t.description) ? CO.accounts.fuel : CO.accounts.other;
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
      move_type: 'in_invoice', company_id: CO.companyId, journal_id: CO.journalId, partner_id: +partner.id,
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
    ref: moveName, service: CO.company,
    company: CO.company, companySrc: 'odoo', kind: l.t.kind || 'work', kindSrc: l.t.kindSrc || 'odoo',
    partnerId: +partner.id,
    analyticId: l.a.id, analyticName: l.a.name, analyticSrc: l.t.analyticSrc === 'manual' ? 'manual' : 'excel', analyticFrom: l.a.from,
    odoo: { checkedAt: at, matches: [{ chosen: true, moveId, move: moveName, date: dateOf, amount: total, partner: partner.name, partnerId: +partner.id,
      label: l.line.name, company: CO.company, journal: CO.journal, state, docs: [], analytics: [{ id: l.a.id, name: l.a.name, from: 'bill' }],
      score: 10, why: ['one line of the month\'s ' + PARTS[part].label + ' bill, made from this row'] }] },
  } }));
  await acc.batchSet(ws.firestore, writes);
  const general = lines.filter(l => l.a.id === GENERAL).length, inherited = lines.filter(l => /same day|previous/.test(l.a.from)).length;
  return { month, part, action, moveId, move: moveName, ref, rows: rows.length, total, inherited, general, wrongCompany, accounts: [...new Set(lines.map(l => CO.accountNames[l.accountId]))] };
}

// ── everything else that must reach Odoo ────────────────────────────────────
const inOdoo = t => !!(t.odoo && (t.odoo.matches || []).some(x => x.chosen));
const CASH_JOURNAL = { 'S LB': { id: 87, companyId: 7 }, 'SHIFT GROUP SARL (USD)': { id: 21, companyId: 2 }, 'SHIFT DEVELOPMENT': { id: 146, companyId: 10 } };
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
const VENDOR_IDS = [[/attal/i, 13, 'Ste. ATTAL'], [/tchag/i, 24, 'Tchaghlassian Steel'], [/solaris/i, 214, 'SOLARIS s.a.l'], [/khc|khoury hardware/i, 233, 'KHC Khoury Hardware Center s.a.r.l'], [/kbm|khoury building/i, 234, 'KBM Khoury Building Materials'], [/njk|nicolas khoury/i, 244, 'NJK Nicolas Khoury'], [/^khoury$/i, 233, 'KHC Khoury Hardware Center s.a.r.l'],
  [/\bsec\b|simon/i, 10, 'Simon Electric Center SEC'], [/sakr/i, 325, 'Sakr Building Materials'], [/pharmac/i, 420, 'Pharmacie AL-AHLIEH'],
  [/narinco/i, 23, 'NARINCO MICRO s.a.r.l'], [/medco/i, 258, 'MEDCO s.a.l'], [/electromec/i, 16, 'Ste. ELECTROMEC s.a.l'], [/kcce|k\.c\.c\.e/i, 277, 'KCCE SAL'],
  [/monzer/i, 334, 'monzer / stone walls'], [/fahed wood/i, 339, 'Fahed Wood']];
// Georges' sheet names the goods, not the shop: on HIS account cement, pipe and rope come from mrad and panels
// from Fahed (Ajaltoun). On anyone else's account "cement and sand" is whoever the row says, or nobody
// (Ziad's 2023-2025 cement rows had gone to Ajaltoun's supplier, found 2026-09-06).
const ACCOUNT_VENDOR_IDS = { 'georges-cash': [[/\bmrad\b(?!\s*electric)|cement|trabe|\bpipe\b|inches tube|nylon wire/i, 333, 'mrad نقليات مراد كافة مواد البناء'], [/fahed|wood \d|\d panels/i, 339, 'Fahed Wood']] };
const handVendor = (t, account) => {
  const lists = [VENDOR_IDS, ...(account && ACCOUNT_VENDOR_IDS[account.id] ? [ACCOUNT_VENDOR_IDS[account.id]] : [])];
  for (const L of lists) { const h = L.find(([rx]) => rx.test(t.partnerName || '')) || L.find(([rx]) => rx.test(t.description || '')); if (h) return h; }
  return null;
};
const RAW_MATERIALS = 5978;   // 611100 Purchasing Raw Materials, S LB

// ── who a row was paid to ──────────────────────────────────────────────────
// VENDOR_IDS above is the short hand-written list. Everything else is read from Odoo itself:
// every partner the company buys from, matched on its distinctive words. Our own people are
// left out — "Z32 Ziad Payment December" is his salary, not a purchase from Ziad Arabe.
const OUR_PEOPLE = new Set([366, 41, 299, 388, 322, 392, 421]);
// Words too generic to name a supplier: "steel" made every other steel seller Tchaghlassian, "work" made
// day labourers ("workers") J & P Steel Work, "naccache"/"beirut" made transport the generator company or
// the chamber of commerce (Ziad's rows, found 2026-09-06). A match needs a whole, distinctive word.
const SUP_STOP = new Set(['sarl', 'sal', 'ste', 'the', 'and', 'company', 'group', 'center', 'centre', 'est', 'establishment', 'trading', 'general', 'llc', 'inc', 'shop', 'store', 'lebanon', 'supplier', 'services', 'service',
  'steel', 'work', 'works', 'worker', 'workers', 'electric', 'electrical', 'electronics', 'electro', 'mechanic', 'paint', 'paints', 'tools', 'tool', 'wood', 'building', 'materials', 'material', 'hardware', 'transport', 'industries',
  'industry', 'factory', 'generator', 'tiles', 'aluminum', 'cleaning', 'safety', 'uniform', 'manufacturer', 'petroleum', 'insurance', 'express', 'tech', 'equipment', 'international', 'chamber', 'commerce', 'agriculture',
  'beirut', 'mount', 'jisr', 'antelias', 'naccache', 'milede', 'brother', 'brothers', 'maid', 'gypsum', 'dad', 'mum', 'micro', 'plus', 'handy', 'ballouz', 'solutions',
  'georges', 'tony', 'ahmad', 'joseph', 'saliba', 'maya', 'walid', 'hibri', 'akiki', 'charbel', 'elie', 'jean', 'pierre', 'michel', 'paint', 'painter', 'plumber',
  'abdel', 'abou', 'abo', 'mostafa', 'karam', 'salam', 'hassan', 'omar', 'zeid', 'issa',   // first names: a row "georges saad" is not Georges El Hajj, "Abdel Rahman worker" is not Abdel Salam
  'abed', 'mitri', 'khodr', 'khoder', 'ziad', 'mario', 'therese']);   // our own people: "abed · steel rack" is Abed's row, not the supplier Abed Tahan (found 2026-09-06)
let _supCache = { at: 0, list: [] };
async function suppliers(odooCall) {
  if (Date.now() - _supCache.at < 10 * 60000 && _supCache.list.length) return _supCache.list;
  const rows = await odooCall('res.partner', 'search_read', [[['supplier_rank', '>', 0]]],
    { fields: ['id', 'name', 'supplier_rank'], context: { allowed_company_ids: [2, 7, 10] }, limit: 3000 });
  _supCache = { at: Date.now(), list: rows.filter(p => !OUR_PEOPLE.has(p.id))
    .map(p => ({ id: p.id, name: p.name, rank: p.supplier_rank, words: norm(p.name).split(' ').filter(w => w.length > 3 && !SUP_STOP.has(w)) }))
    .filter(p => p.words.length) };
  return _supCache.list;
}
// the supplier a row names: the hand-written list first, then Odoo's own; the one we buy from
// most wins when several names appear.
async function vendorOf(odooCall, t, account) {
  const hand = handVendor(t, account);
  if (hand) return { id: hand[1], name: hand[2] };
  const list = await suppliers(odooCall);
  const text = ' ' + norm((t.partnerName || '') + ' ' + (t.description || '')) + ' ';
  const hits = list.filter(p => p.words.some(w => text.includes(' ' + w + ' ') || (w.length >= 6 && text.includes(' ' + w))));   // whole word; a long name may be written short ("tchag", "electromec s")
  if (!hits.length) return null;
  hits.sort((a, b) => b.rank - a.rank);
  return { id: hits[0].id, name: hits[0].name };
}

const PAYABLE_SLB = 5778;     // Account Payable, S LB

// ── A cash box, not a subcontractor ────────────────────────────────────────
// Ziad holds company money and spends it: he is not owed what he pays out, his CASH ACCOUNT
// is. So his rows are booked the way his journal is already written (Mario, 2026-09-06):
//
//   money handed to him   -> an entry moving it from Mario's cash account into his
//   money he hands back   -> the same entry the other way round
//   something he paid for -> the supplier's bill, settled by a payment ON HIS CASH JOURNAL
//
// A row whose bill Odoo already holds is never booked again: the bill is found by supplier,
// amount and date, and only the payment is added when it is still unpaid. Nothing here ever
// touches a partner ledger — his balance lives in the cash account, as the sheet reads it.
// The SARL's VAT is declared and its years are closed up to here: nothing new may be posted
// into that company on or before this date (Mario, 2026-09-06). A row whose bill lives in the
// SARL and falls inside the closed window is still linked to that bill — only the payment is
// left out, and the run reports it.
const SARL_CLOSED_UNTIL = '2026-06-30';
const CASHBOX = {
  'S LB':                   { companyId: 7, journal: 163, cash: 9169, marioCash: 5954, marioJournal: 87, billJournal: 85 },
  'SHIFT GROUP SARL (USD)':  { companyId: 2, journal: 152, cash: 9159, marioCash: 1073, marioJournal: 21, billJournal: null },
  'SHIFT DEVELOPMENT':       { companyId: 10, journal: 158, cash: 9173, marioCash: null, marioJournal: null, billJournal: null },
};
const prefixOf = account => account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
const cashMoveRef = (account, t) => prefixOf(account) + '-' + t.id;
// A cash-box account (Ziad) holds company cash; a partner-ledger account (Abed, Khodr, Mitri, Georges) fronts his own.
// Money between the two is ONE entry — the box's cash account against the worker's payable — booked by
// whichever side runs first; the other side finds it (same cash account, amount, ±3 days, the other
// account's prefix in the ref) and adopts it instead of booking again (doubles found 2026-09-06).
const isCashBox = account => !!(account && account.cashBox);
async function findOtherSideEntry(odooCall, cashAccountId, otherPrefix, amount, date, companyId, boxIn) {
  const lo = new Date(new Date(date + 'T00:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
  const hi = new Date(new Date(date + 'T00:00:00Z') - -3 * 86400000).toISOString().slice(0, 10);
  const L = await odooCall('account.move.line', 'search_read', [[['account_id', '=', cashAccountId], ['parent_state', '=', 'posted'], ['date', '>=', lo], ['date', '<=', hi], [boxIn ? 'debit' : 'credit', '=', amount], ['move_id.ref', '=like', otherPrefix + '-%']]],
    { fields: ['move_id'], context: { allowed_company_ids: [companyId], company_id: companyId }, limit: 5 });
  if (!L.length) return null;
  const [mv] = await odooCall('account.move', 'read', [[L[0].move_id[0]], ['id', 'name', 'state', 'ref']], { context: { allowed_company_ids: [companyId] } });
  return mv;
}

// the supplier bill Odoo already has for this row: same supplier, same amount, within 10 days
async function findBill(odooCall, vendorId, amount, date, companies) {
  const lo = new Date(new Date(date + 'T00:00:00Z') - 10 * 86400000).toISOString().slice(0, 10);
  const hi = new Date(new Date(date + 'T00:00:00Z') - -10 * 86400000).toISOString().slice(0, 10);
  const found = await odooCall('account.move', 'search_read',
    [[['move_type', '=', 'in_invoice'], ['state', '=', 'posted'], ['partner_id', '=', vendorId], ['invoice_date', '>=', lo], ['invoice_date', '<=', hi]]],
    { fields: ['id', 'name', 'amount_total', 'amount_residual', 'payment_state', 'company_id', 'invoice_date'], context: { allowed_company_ids: companies }, limit: 40 });
  return found.find(b => Math.abs(b.amount_total - amount) < 0.02) || null;
}

async function postCashBox(ctx, account, who, opts) {
  const { ws, txCol, odooCall, listAccounts } = ctx;
  const o = opts || {};
  const accounts = await listAccounts(ws);
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data());
  const rows = all.filter(t => t.src === 'excel' && !t.excluded && (t.debit > 0 || t.credit > 0) && t.nature && t.nature !== 'note'
      && !inOdoo(t) && !t.bookedMove && !t.noBook
      && (!o.from || t.date >= o.from) && (!o.to || t.date <= o.to))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const out = { rows: rows.length, transfers: 0, billsFound: 0, billsMade: 0, paid: 0, alreadyPaid: 0, noVendor: [], skipped: [], moved: 0, spent: 0 };
  const byNature = {}; for (const t of rows) byNature[t.nature] = (byNature[t.nature] || 0) + 1;
  out.byNature = byNature;
  if (o.dry) {
    out.petty = 0;
    for (const t of rows) { if (t.nature === 'transfer') out.transfers++; else { const v = await vendorOf(odooCall, t, account); if (v) out.billsFound++; else { out.petty++; if (out.noVendor.length < 12) out.noVendor.push({ date: t.date, amount: t.debit || t.credit, what: (t.description || '').slice(0, 44) }); } } }
    out.moved = money(rows.filter(t => t.nature === 'transfer').reduce((s, t) => s + (t.debit || t.credit), 0));
    out.spent = money(rows.filter(t => t.nature !== 'transfer').reduce((s, t) => s + (t.debit || 0), 0));
    return out;
  }
  const home = CASHBOX['S LB'];
  const usedBills = new Set(all.filter(t => t.bookedMove && t.bookedMove.id).map(t => t.bookedMove.id));   // bills already accounted for by a row
  for (const t of rows) {
    const ref = cashMoveRef(account, t);
    const amount = money(t.debit || t.credit);
    try {
      // ── money in or out of his box
      if (t.nature === 'transfer') {
        const c = home, ctxO = { allowed_company_ids: [c.companyId], company_id: c.companyId };
        let [mv] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'entry']]], { fields: ['id', 'name', 'state'], context: ctxO, limit: 1 });
        const other = accounts.find(a => a.id === t.cashAccountId);
        // the other side is a worker who fronts his own money: the entry goes against HIS payable, and if his
        // own booking already made it (his row ran first), that entry is adopted, never doubled
        const worker = other && other.odooPartner && other.odooPartner.id && !isCashBox(other) ? { id: +other.odooPartner.id, name: other.odooPartner.name } : null;
        let adopted = false;
        if (!mv && worker) { mv = await findOtherSideEntry(odooCall, c.cash, prefixOf(other), amount, t.date, c.companyId, t.credit > 0); adopted = !!mv; }
        if (!mv) {
          const label = t.credit > 0 ? 'into ' + account.name + ' on ' + t.date + ' — ' + (t.description || '')
                                     : 'out of ' + account.name + ' on ' + t.date + ' — ' + (t.description || '');
          const counter = worker ? { account_id: SLB.payable, partner_id: worker.id } : { account_id: c.marioCash };
          const lines = t.credit > 0
            ? [[0, 0, { account_id: c.cash, debit: amount, credit: 0, name: label }], [0, 0, { ...counter, debit: 0, credit: amount, name: label }]]
            : [[0, 0, { account_id: c.cash, debit: 0, credit: amount, name: label }], [0, 0, { ...counter, debit: amount, credit: 0, name: label }]];
          const id = await odooCall('account.move', 'create', [{ move_type: 'entry', company_id: c.companyId, journal_id: c.journal, date: t.date, ref,
            narration: account.name + ': ' + label + (other ? ' (' + other.name + ')' : '') + '. Made by Shift Hub.', line_ids: lines }], { context: ctxO });
          await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
          [mv] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state']], { context: ctxO });
        }
        out.transfers++; out.moved = money(out.moved + amount);
        await col.doc(t.id).set({ bookedMove: { id: mv.id, name: mv.name, ref, kind: 'cash-transfer', at: now(), state: mv.state }, ref: mv.name, service: c.company || 'S LB', company: 'S LB', companySrc: 'odoo',
          odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: mv.id, move: mv.name, date: t.date, amount, partner: 'Cash Mario', label: t.description, company: 'S LB', journal: 'Cash ZIAD USD', state: mv.state, docs: [], analytics: [], score: 10, why: ['money in or out of his box, from this row'] }] } }, { merge: true });
        continue;
      }
      // ── money arriving in the box from anyone but our own cash: Ziad collecting for us.
      // The payer's own account in Odoo is already right (Mario, 2026-09-06), so this must NOT
      // touch it: only the cash moves, out of the company's cash and into his box.
      if (!(t.debit > 0)) {
        const c = home, ctxO = { allowed_company_ids: [c.companyId], company_id: c.companyId };
        let [mv] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'entry']]], { fields: ['id', 'name', 'state'], context: ctxO, limit: 1 });
        if (!mv) {
          const label = 'collected into ' + account.name + ' on ' + t.date + ' — ' + (t.description || '');
          const id = await odooCall('account.move', 'create', [{ move_type: 'entry', company_id: c.companyId, journal_id: c.journal, date: t.date, ref,
            narration: account.name + ': ' + label + '. The payer account in Odoo is left untouched. Made by Shift Hub.',
            line_ids: [[0, 0, { account_id: c.cash, debit: amount, credit: 0, name: label }], [0, 0, { account_id: c.marioCash, debit: 0, credit: amount, name: label }]] }], { context: ctxO });
          await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
          [mv] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state']], { context: ctxO });
        }
        out.collected = (out.collected || 0) + 1; out.moved = money(out.moved + amount);
        await col.doc(t.id).set({ bookedMove: { id: mv.id, name: mv.name, ref, kind: 'cash-collected', at: now(), state: mv.state }, ref: mv.name, service: 'S LB', company: 'S LB', companySrc: 'odoo',
          odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: mv.id, move: mv.name, date: t.date, amount, partner: 'Cash Mario', label: t.description,
            company: 'S LB', journal: 'Cash ZIAD USD', state: mv.state, docs: [], analytics: [], score: 10, why: ['collected into his box, from this row'] }] } }, { merge: true });
        continue;
      }
      const v = await vendorOf(odooCall, t, account);
      if (!v) {
        // nobody to owe: petty spending straight out of the box — one entry, expense against his cash
        const c = home, ctxO = { allowed_company_ids: [c.companyId], company_id: c.companyId };
        let [mv] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'entry']]], { fields: ['id', 'name', 'state'], context: ctxO, limit: 1 });
        if (!mv) {
          const map = await loadMap(ws);
          const e = t.project ? map[norm(t.project)] : null;
          // what the cash went to: fuel, a day labourer's pay, goods for a site, or the rest
          const what = t.partnerName + ' ' + t.description;
          const acctId = isFuel(what) ? SLB.accounts.fuel
            : /worker|workers|labou?r|plaster|ballat|tiling|painter|plumber|welder|daily/i.test(what) ? SLB.accounts.labour
            : /steel|cement|sand\b|aggreg|gravel|block|brick|tube|pipe|wood|panel|rebar|gypsum|tiles?\b|paint\b|ceramic/i.test(what) ? RAW_MATERIALS
            : SLB.accounts.other;
          const label = t.date + ' \u00b7 ' + (t.description || 'cash expense');
          const spend = { account_id: acctId, debit: money(t.debit), credit: 0, name: label };
          if (e && e.id) spend.analytic_distribution = { [String(e.id)]: 100 };
          const id = await odooCall('account.move', 'create', [{ move_type: 'entry', company_id: c.companyId, journal_id: c.journal, date: t.date, ref,
            narration: account.name + ': paid in cash on ' + t.date + '. Made by Shift Hub.',
            line_ids: [[0, 0, spend], [0, 0, { account_id: c.cash, debit: 0, credit: money(t.debit), name: label }]] }], { context: ctxO });
          await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
          [mv] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state']], { context: ctxO });
        }
        out.petty = (out.petty || 0) + 1; out.spent = money(out.spent + t.debit);
        await col.doc(t.id).set({ bookedMove: { id: mv.id, name: mv.name, ref, kind: 'cash-expense', at: now(), state: mv.state }, ref: mv.name, service: 'S LB', company: 'S LB', companySrc: 'odoo',
          odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: mv.id, move: mv.name, date: t.date, amount: money(t.debit), partner: t.partnerName || '', label: t.description,
            company: 'S LB', journal: 'Cash ZIAD USD', state: mv.state, docs: [], analytics: [], score: 10, why: ['spent straight out of his cash box, from this row'] }] } }, { merge: true });
        continue;
      }
      let bill = await findBill(odooCall, v.id, t.debit, t.date, [2, 7, 10]);
      // a bill another row already accounts for is not this row's: two identical purchases a few days apart are two bills
      if (bill && usedBills.has(bill.id)) bill = null;
      let c = home;
      if (bill) { out.billsFound++; c = Object.values(CASHBOX).find(x => x.companyId === bill.company_id[0]) || home; }
      else {
        const ctxO = { allowed_company_ids: [home.companyId], company_id: home.companyId };
        const map = await loadMap(ws);
        const e = t.project ? map[norm(t.project)] : null;
        const an = e && e.id ? { id: e.id, name: e.name } : { id: GENERAL, name: 'GENERAL' };
        const id = await odooCall('account.move', 'create', [{ move_type: 'in_invoice', company_id: home.companyId, journal_id: home.billJournal, partner_id: v.id, invoice_date: t.date, date: t.date, ref,
          narration: account.name + ': paid in cash by ' + (account.owner || 'him') + ' on ' + t.date + ' (Excel row, no VAT invoice). Made by Shift Hub.',
          invoice_line_ids: [[0, 0, { name: t.date + ' · ' + (t.description || v.name), quantity: 1, price_unit: money(t.debit), account_id: RAW_MATERIALS, tax_ids: [[6, 0, []]], analytic_distribution: { [String(an.id)]: 100 } }]] }], { context: ctxO });
        await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
        [bill] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state', 'payment_state', 'amount_residual', 'company_id']], { context: ctxO });
        out.billsMade++;
      }
      const closedSarl = c.companyId === 2 && t.date <= SARL_CLOSED_UNTIL;
      if (closedSarl && (bill.payment_state === 'not_paid' || (bill.amount_residual || 0) > 0.005)) {
        (out.closedSarl = out.closedSarl || []).push({ id: t.id, date: t.date, amount: money(t.debit), bill: bill.name });
      } else if (bill.payment_state === 'not_paid' || (bill.amount_residual || 0) > 0.005) {
        const ctxP = { allowed_company_ids: [c.companyId], company_id: c.companyId, active_model: 'account.move', active_ids: [bill.id] };
        const wiz = await odooCall('account.payment.register', 'create', [{ journal_id: c.journal, payment_date: t.date, amount: money(Math.min(t.debit, bill.amount_residual || t.debit)) }], { context: ctxP });
        await odooCall('account.payment.register', 'action_create_payments', [[wiz]], { context: ctxP });
        out.paid++;
      } else out.alreadyPaid++;
      const [fresh] = await odooCall('account.move', 'read', [[bill.id], ['id', 'name', 'state', 'payment_state']], { context: { allowed_company_ids: [c.companyId] } });
      usedBills.add(bill.id);
      out.spent = money(out.spent + t.debit);
      await col.doc(t.id).set({ bookedMove: { id: fresh.id, name: fresh.name, ref, kind: 'cash-bill', at: now(), state: fresh.state, paymentState: fresh.payment_state }, ref: fresh.name, service: c.companyId === 2 ? 'SARL' : 'S LB',
        company: c.companyId === 2 ? 'SHIFT GROUP SARL (USD)' : 'S LB', companySrc: 'odoo', partnerId: v.id,
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: fresh.id, move: fresh.name, date: t.date, amount: money(t.debit), partner: v.name, partnerId: v.id, label: t.description,
          company: c.companyId === 2 ? 'SHIFT GROUP SARL (USD)' : 'S LB', journal: 'Bills', state: fresh.state, docs: [], analytics: [], score: 10, why: ['paid from his cash box, from this row'] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount, error: String(e.message || e).slice(0, 200) }); if (out.skipped.length > 8) break; }
  }
  return out;
}

// Money he moved the other way, or that came from someone other than Mario.
//
//   he gave cash back to Mario      -> an inbound payment on Cash Mario: we owe him that much more
//   another worker handed him money -> ONE entry in S LB between the two men's payable accounts:
//                                      his account debited (we owe him less), the giver's credited
//   he handed another worker money  -> the same entry the other way round
//
// Another person's cash account only qualifies when that account carries an Odoo partner.
const MISC_SLB = 65;
const otherSideOf = (t, accounts) => {
  const other = accounts.find(a => a.id === t.cashAccountId);
  return other && other.odooPartner && other.odooPartner.id ? { id: +other.odooPartner.id, name: other.odooPartner.name } : null;
};
async function postTransfers(ctx, account, who, opts) {
  const CO = bookCo(account);
  const { ws, txCol, odooCall, listAccounts } = ctx;
  const partner = account.odooPartner;
  if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const accounts = await listAccounts(ws);
  const col = txCol(account);
  const rows = (await col.get()).docs.map(d => d.data())
    .filter(t => t.src === 'excel' && !t.excluded && t.nature === 'transfer' && !inOdoo(t) && !t.bookedMove && !t.noBook
      && (t.debit > 0 || (t.credit > 0 && t.cashAccountId && t.cashAccountId !== 'mario-cash')))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const out = { rows: rows.length, posted: 0, found: 0, skipped: [], noPartner: [], total: 0 };
  const toMario = t => t.debit > 0 && (!t.cashAccountId || t.cashAccountId === 'mario-cash');
  if (opts && opts.dry) {
    for (const t of rows) if (!toMario(t) && !otherSideOf(t, accounts)) out.noPartner.push({ id: t.id, date: t.date, amount: t.debit || t.credit, other: t.partnerName });
    return { ...out, posted: rows.length - out.noPartner.length, total: money(rows.reduce((s, t) => s + (t.debit || t.credit), 0)) };
  }
  const prefix = account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const ctxO = { allowed_company_ids: [CO.companyId], company_id: CO.companyId };
  for (const t of rows) {
    const amount = money(t.debit || t.credit);
    const memo = prefix + '-' + t.id;
    try {
      if (toMario(t)) {
        const j = CASH_JOURNAL[CO.company];
        const c2 = { allowed_company_ids: [j.companyId], company_id: j.companyId };
        let [p] = await odooCall('account.payment', 'search_read', [[['memo', '=', memo], ['company_id', '=', j.companyId], ['state', 'not in', ['canceled']]]], { fields: ['id', 'state', 'move_id', 'name'], context: c2, limit: 1 });
        if (p) out.found++;
        else {
          const id = await odooCall('account.payment', 'create', [{ payment_type: 'inbound', partner_type: 'supplier', partner_id: +partner.id, amount, date: t.date, journal_id: j.id, memo, company_id: j.companyId }], { context: c2 });
          await odooCall('account.payment', 'action_post', [[id]], { context: c2 });
          [p] = await odooCall('account.payment', 'read', [[id], ['id', 'state', 'move_id', 'name']], { context: c2 });
          out.posted++;
        }
        out.total = money(out.total + amount);
        const mid = p.move_id ? p.move_id[0] : null;
        await col.doc(t.id).set({ bookedMove: { id: mid, name: p.name, ref: memo, kind: 'transfer', at: now(), state: p.state }, ref: p.name, service: CO.company, company: CO.company, companySrc: 'odoo',
          odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: mid, move: p.name, date: t.date, amount, partner: partner.name, partnerId: +partner.id, label: 'handed back to Cash Mario',
            company: CO.company, journal: 'Cash Mario USD', state: p.state, docs: [], analytics: [], score: 10, why: ['money he handed back, from this row'] }] } }, { merge: true });
        continue;
      }
      const o = otherSideOf(t, accounts);
      if (!o) { out.noPartner.push({ id: t.id, date: t.date, amount, other: t.partnerName }); continue; }
      const ref = prefix + '-' + t.id;
      let [mv] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'entry']]], { fields: ['id', 'name', 'state'], context: ctxO, limit: 1 });
      // the other man is a cash box (Ziad): his side is his cash account, not a payable — and if his own
      // booking already made the entry, adopt it (a worker ↔ box transfer is one entry, never two)
      const otherAcc = accounts.find(a => a.id === t.cashAccountId);
      const box = isCashBox(otherAcc) ? (CASHBOX[CO.company] || CASHBOX['S LB']) : null;
      if (!mv && box) mv = await findOtherSideEntry(odooCall, box.cash, prefixOf(otherAcc), amount, t.date, CO.companyId, t.credit > 0 ? false : true);
      if (mv) out.found++;
      else {
        const label = t.credit > 0 ? o.name + ' handed ' + partner.name + ' ' + fmt2(amount) + ' on ' + t.date
                                   : partner.name + ' handed ' + o.name + ' ' + fmt2(amount) + ' on ' + t.date;
        const mine = { account_id: CO.payable, partner_id: +partner.id, name: label };
        const theirs = box ? { account_id: box.cash, name: label } : { account_id: CO.payable, partner_id: o.id, name: label };
        const line_ids = t.credit > 0
          ? [[0, 0, { ...mine, debit: amount, credit: 0 }], [0, 0, { ...theirs, debit: 0, credit: amount }]]
          : [[0, 0, { ...mine, debit: 0, credit: amount }], [0, 0, { ...theirs, debit: amount, credit: 0 }]];
        const id = await odooCall('account.move', 'create', [{ move_type: 'entry', company_id: CO.companyId, journal_id: CO.misc, date: t.date, ref, narration: account.name + ': ' + label + '. Made by Shift Hub.', line_ids }], { context: ctxO });
        await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
        [mv] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state']], { context: ctxO });
        out.posted++;
      }
      out.total = money(out.total + amount);
      await col.doc(t.id).set({ bookedMove: { id: mv.id, name: mv.name, ref, kind: 'transfer', at: now(), state: mv.state }, ref: mv.name, service: CO.company, company: CO.company, companySrc: 'odoo',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: mv.id, move: mv.name, date: t.date, amount, partner: o.name, partnerId: o.id, label: t.credit > 0 ? 'received from ' + o.name : 'handed to ' + o.name,
          company: CO.company, journal: 'Miscellaneous', state: mv.state, docs: [], analytics: [], score: 10, why: ['transfer between the two accounts, from this row'] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount, error: String(e.message || e).slice(0, 200) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

// Money handed to him = a payment to him from that cash, against his supplier account.
async function postPayments(ctx, account, who, opts) {
  const CO = bookCo(account);
  const { ws, txCol, odooCall, acc } = ctx;
  const partner = account.odooPartner; if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const col = txCol(account);
  const rows = (await col.get()).docs.map(d => d.data())
    .filter(t => t.src === 'excel' && !t.excluded && t.credit > 0 && t.nature === 'transfer' && t.cashAccountId === 'mario-cash' && !inOdoo(t) && !t.bookedMove && !t.noBook)
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
      if (slbPart > 0) parts.push({ j: CASH_JOURNAL[CO.company], amount: slbPart, memo: sarlPart > 0 ? memo + '-slb' : memo, company: CO.company });
      const made = [];
      for (const part of parts) { const r = await makePayment(odooCall, part.j, partner, part.amount, t.date, part.memo); made.push({ ...part, p: r.p }); if (r.found) out.found++; else out.posted++; }
      const first = made[0], p = first.p;
      const moveId = p.move_id ? p.move_id[0] : null, name = made.map(m => m.p.name || m.p.move_id[1]).join(' + ');
      const company = made.length === 1 ? first.company : 'SARL ' + fmt2(made[0].amount) + ' + S LB ' + fmt2(made[1].amount);
      out.total = money(out.total + t.credit);
      await col.doc(t.id).set({ bookedMove: { id: moveId, name, ref: memo, kind: 'payment', at: now(), state: p.state, parts: made.map(m => ({ name: m.p.name, amount: m.amount, company: m.company })) }, ref: name, service: made.length === 1 ? first.company : 'split',
        company: made.length === 1 ? first.company : made[0].company, companySrc: 'odoo',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId, move: name, date: t.date, amount: money(t.credit), partner: partner.name, partnerId: +partner.id, label: 'paid to ' + partner.name + ' from Cash Mario',
          company: t.company || CO.company, journal: 'Cash Mario USD', state: p.state, docs: [], analytics: [], score: 10, why: ['payment made from this row'] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount: t.credit, error: String(e.message || e).slice(0, 160) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

// Money a supplier gave back that stayed in his pocket: a credit note from that supplier in
// S LB, settled by him, so his account is debited exactly as a bill of his credits it.
async function postRefunds(ctx, account, who, opts) {
  const CO = bookCo(account);
  const { ws, txCol, odooCall } = ctx;
  const partner = account.odooPartner;
  if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const map = await loadMap(ws);
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data());
  const rows = all.filter(t => t.src === 'excel' && !t.excluded && t.credit > 0 && t.nature === 'refund' && !inOdoo(t) && !t.bookedMove && !t.noBook).sort((a, b) => a.date < b.date ? -1 : 1);
  const an = analyticsFor(all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0), map);
  const out = { rows: rows.length, posted: 0, found: 0, noPartner: [], skipped: [], total: 0 };
  const prefix = account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const ctxO = { allowed_company_ids: [CO.companyId], company_id: CO.companyId };
  for (const t of rows) {
    const v = handVendor(t, account);
    if (!v) { out.noPartner.push({ id: t.id, date: t.date, amount: t.credit, partner: t.partnerName }); continue; }
    if (opts && opts.dry) { out.posted++; out.total = money(out.total + t.credit); continue; }
    const ref = prefix + '-' + t.id;
    try {
      let [note] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'in_refund']]], { fields: ['id', 'name', 'state', 'payment_state'], context: ctxO, limit: 1 });
      const a = an[t.id] || { id: GENERAL, name: 'GENERAL' };
      if (note) out.found++;
      else {
        const id = await odooCall('account.move', 'create', [{ move_type: 'in_refund', company_id: CO.companyId, journal_id: CO.journalId, partner_id: v[1], invoice_date: t.date, date: t.date, ref,
          narration: account.name + ': given back to ' + partner.name + ' on ' + t.date + ' (Excel row). Made by Shift Hub.',
          invoice_line_ids: [[0, 0, { name: t.date + ' · ' + (t.description || 'refund'), quantity: 1, price_unit: money(t.credit), account_id: CO.rawMaterials, tax_ids: [[6, 0, []]], analytic_distribution: { [String(a.id)]: 100 } }]] }], { context: ctxO });
        await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
        [note] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
        out.posted++;
      }
      if (note.payment_state === 'not_paid') {
        const wctx = { ...ctxO, active_model: 'account.move', active_ids: [note.id] };
        const wiz = await odooCall('account.payment.register', 'create', [{ journal_id: CO.sett, payment_date: t.date, x_paid_by: +partner.id }], { context: wctx });
        await odooCall('account.payment.register', 'action_create_payments', [[wiz]], { context: wctx });
        [note] = await odooCall('account.move', 'read', [[note.id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
      }
      out.total = money(out.total + t.credit);
      await col.doc(t.id).set({ bookedMove: { id: note.id, name: note.name, ref, kind: 'vendor-refund', at: now(), state: note.state, paymentState: note.payment_state }, ref: note.name, service: CO.company,
        company: CO.company, companySrc: 'odoo', partnerId: v[1], analyticId: a.id, analyticName: a.name, analyticSrc: t.analyticSrc === 'manual' ? 'manual' : 'excel',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: note.id, move: note.name, date: t.date, amount: money(t.credit), partner: v[2], partnerId: v[1], label: t.description,
          company: CO.company, journal: CO.journal, state: note.state, docs: [], analytics: [{ id: a.id, name: a.name, from: 'refund' }], score: 10, why: ['credit note made from this row, kept by ' + partner.name] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount: t.credit, error: String(e.message || e).slice(0, 200) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

// An unofficial supplier ticket he paid: the supplier's bill in S LB (no VAT), paid through Settlement by him.
async function postVendors(ctx, account, who, opts) {
  const CO = bookCo(account);
  const { ws, txCol, odooCall, acc } = ctx;
  const partner = account.odooPartner; if (!partner || !partner.id) throw new Error('set the account\'s Odoo partner first');
  const map = await loadMap(ws);
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data());
  const rows = all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0 && t.nature === 'vendor' && !inOdoo(t) && !t.bookedMove && !t.noBook).sort((a, b) => a.date < b.date ? -1 : 1);
  const an = analyticsFor(all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0), map);
  const out = { rows: rows.length, posted: 0, found: 0, noPartner: [], skipped: [], total: 0 };
  const prefix = account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const ctxO = { allowed_company_ids: [CO.companyId], company_id: CO.companyId };
  for (const t of rows) {
    // "abed · attal": the vendor is in the label (hand list), else any supplier Odoo knows (Mario, 2026-09-06:
    // a row naming a known vendor is that vendor's own bill, never a line of the month's bundle)
    const v = await vendorOf(odooCall, t, account);
    if (!v) { out.noPartner.push({ id: t.id, date: t.date, amount: t.debit, partner: t.partnerName }); continue; }
    if (opts && opts.dry) { out.posted++; out.total = money(out.total + t.debit); (out.preview = out.preview || []).push({ id: t.id, date: t.date, amount: t.debit, vendor: v.name, text: [t.partnerName, t.description].filter(Boolean).join(' · ') }); continue; }
    const ref = `${prefix}-${t.id}`;
    try {
      let [bill] = await odooCall('account.move', 'search_read', [[['ref', '=', ref], ['move_type', '=', 'in_invoice']]], { fields: ['id', 'name', 'state', 'payment_state'], context: ctxO, limit: 1 });
      const a = an[t.id] || { id: GENERAL, name: 'GENERAL' };
      if (bill) out.found++;
      else {
        const id = await odooCall('account.move', 'create', [{ move_type: 'in_invoice', company_id: CO.companyId, journal_id: CO.journalId, partner_id: v.id, invoice_date: t.date, date: t.date, ref,
          narration: `${account.name}: paid by ${partner.name} on ${t.date} (Excel row, no VAT invoice). Made by Shift Hub.`,
          invoice_line_ids: [[0, 0, { name: `${t.date} · ${t.description || v.name}`, quantity: 1, price_unit: money(t.debit), account_id: CO.rawMaterials, tax_ids: [[6, 0, []]], analytic_distribution: { [String(a.id)]: 100 } }]] }], { context: ctxO });
        await odooCall('account.move', 'action_post', [[id]], { context: ctxO });
        [bill] = await odooCall('account.move', 'read', [[id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
        out.posted++;
      }
      if (bill.payment_state === 'not_paid') {
        // Settlement journal + Paid by = him: the automation moves the debt onto his account
        const wctx = { ...ctxO, active_model: 'account.move', active_ids: [bill.id] };
        const wiz = await odooCall('account.payment.register', 'create', [{ journal_id: CO.sett, payment_date: t.date, x_paid_by: +partner.id }], { context: wctx });
        await odooCall('account.payment.register', 'action_create_payments', [[wiz]], { context: wctx });
        [bill] = await odooCall('account.move', 'read', [[bill.id], ['id', 'name', 'state', 'payment_state']], { context: ctxO });
      }
      out.total = money(out.total + t.debit);
      await col.doc(t.id).set({ bookedMove: { id: bill.id, name: bill.name, ref, kind: 'vendor-bill', at: now(), state: bill.state, paymentState: bill.payment_state }, ref: bill.name, service: CO.company,
        company: CO.company, companySrc: 'odoo', partnerId: v.id, analyticId: a.id, analyticName: a.name, analyticSrc: t.analyticSrc === 'manual' ? 'manual' : 'excel',
        odoo: { checkedAt: now(), matches: [{ chosen: true, moveId: bill.id, move: bill.name, date: t.date, amount: money(t.debit), partner: v.name, partnerId: v.id, label: t.description,
          company: CO.company, journal: CO.journal, state: bill.state, docs: [], analytics: [{ id: a.id, name: a.name, from: 'bill' }], score: 10, why: ['bill made from this row, settled by ' + partner.name] }] } }, { merge: true });
    } catch (e) { out.skipped.push({ id: t.id, date: t.date, amount: t.debit, error: String(e.message || e).slice(0, 200) }); if (out.skipped.length > 5) break; }
  }
  return out;
}

// ── a known supplier's row is its own bill, never a line of the month ──────
// The sheet reads "abed · deye 3700" as an expense he fronted; the month bundle would swallow it
// into the expenses bill from him. Mario, 2026-09-06: when the row names a supplier Odoo already
// knows, it is that supplier's own bill, settled "paid by" him — independent of the month. So
// every expense row that resolves to a known vendor is retyped `vendor` here: after each Excel
// import (the import recomputes types) and on demand from the page. A type chosen by hand is
// never touched, and a row already inside a month bill is only reported: retype it by hand and
// Rewrite the draft, or leave a posted month as it is.
async function vendorize(ctx, account, who, opts) {
  const { txCol, odooCall } = ctx;
  const col = txCol(account);
  const all = (await col.get()).docs.map(d => d.data());
  const rows = all.filter(t => t.src === 'excel' && !t.excluded && t.debit > 0 && !t.noBook && t.nature === 'expense' && t.natureSrc !== 'manual');
  const out = { checked: rows.length, flipped: [], inBill: [], dry: !!(opts && opts.dry) };
  for (const t of rows) {
    let v; try { v = await vendorOf(odooCall, t, account); } catch (e) { out.error = String(e.message || e).slice(0, 160); break; }   // Odoo away: leave the types as they are
    if (!v) continue;
    const item = { id: t.id, date: t.date, amount: t.debit, vendor: v.name, vendorId: v.id, text: [t.partnerName, t.description].filter(Boolean).join(' · ').slice(0, 90) };
    if (t.bookedMove) { out.inBill.push({ ...item, bill: t.bookedMove.name || t.bookedMove.ref, state: t.bookedMove.state }); continue; }
    out.flipped.push(item);
    if (out.dry) continue;
    await col.doc(t.id).set({ nature: 'vendor', natureSrc: 'odoo', partnerKind: 'partner', cashAccountId: '', vendorId: v.id, vendorName: v.name, updatedBy: who, updatedAt: now() }, { merge: true });
  }
  return out;
}

module.exports = { postTransfers, postRefunds, postCashBox, postPayments, postVendors, vendorize, natureOf, vendorOf, analyticMapFor, saveMapEntry, applyMap, months, bookMonth, norm, SLB, loadMapPublic: loadMap, PARTS, GENERAL };
