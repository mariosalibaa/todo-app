// The workers' ledgers: Georges, Abed, Khodr, Ziad, Mitri each keep (or Mario keeps for
// them) an Excel workbook and a WhatsApp "accounting" group. Odoo holds a third copy —
// their cash journals. The three are matched, never summed:
//
//   importExcel     every row of the workbook becomes a line (src 'excel'); a row that
//                   repeats an Odoo line is linked to it (dupOf) and not counted
//   importWhatsapp  every money message of the group becomes a line (src 'whatsapp');
//                   one that repeats an Excel or Odoo line is linked; one nobody wrote
//                   down anywhere is kept aside (`review`) until a person accepts it
//   linkTransfers   "100$ from mario" on a worker's account and the matching money-out
//                   on Mario's cash are the same movement: one Transfer joining both
//
// Sign convention on a worker's account (same as the Odoo cash journals): debit = money
// the person paid or is owed (a supplier fronted, a day of labour), credit = money handed
// to them. Balance < 0 = the company owes them.
//
// Both readers need files that live on Mario's machine (the Dropbox workbooks, the
// decrypted WhatsApp archive) and libraries the Render service does not ship; they load
// lazily and answer with a clear error elsewhere.
const fs = require('fs');
const path = require('path');
const bills = require('./ledger-bills');   // what a row is (transfer / labour / expense / vendor), the analytic map, monthly bills

const money = n => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const slugId = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18);

function tryRequire(name, extra) {
  for (const p of [name, ...(extra || [])]) { try { return require(p); } catch (e) { /* next */ } }
  return null;
}
const EXTRA = {
  exceljs: ['D:/vscode/georges-sheet/node_modules/exceljs', 'D:/vscode/accounting/node_modules/exceljs'],
  'better-sqlite3': ['D:/vscode/whatsapp-local/node_modules/better-sqlite3'],
};

// ── Excel ───────────────────────────────────────────────────────────────────
const cell = c => {
  if (c == null) return '';
  if (c instanceof Date) return isNaN(c) ? '' : c;
  if (typeof c === 'object') {
    if (c.result !== undefined) return cell(c.result);
    if (c.richText) return c.richText.map(r => r.text).join('');
    if (c.text) return c.text;
    if (c.error) return '';
    return '';
  }
  return c;
};
const num = c => { const v = cell(c); if (v === '' || v == null) return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? money(n) : 0; };
const str = c => { const v = cell(c); return v instanceof Date ? '' : String(v).replace(/\s+/g, ' ').trim(); };
const day = c => {
  const v = cell(c);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  const d = String(v).match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (d) return `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  return '';
};
const hours = c => { const v = cell(c); return typeof v === 'number' ? money(v) : 0; };

// Every layout turns one row (1-based cell array) into 0..n movements {amount, description,
// project, kind}. amount > 0 = the person paid / is owed (debit), < 0 = received (credit) —
// this is how Abed, Georges, Khodr and Mitri's sheets are written; Ziad's is a wallet view
// (+ = in), so his layout flips.
// amount, what the row says, the project it belongs to, its kind, and the counterparty:
// on a row he was paid, who handed him the money; on a row he spent, what he spent it on.
const OWNED = (amount, description, project, kind, extra) => ({ amount, description, project: project || '', kind: kind || '', ...(extra || {}) });
const CASH_OF = { mario: 'Mario cash', ziad: 'Ziad cash', georges: 'Georges cash', abed: 'Abed cash', mitri: 'Mitri cash', khodr: 'Khodr cash', khoder: 'Khodr cash', therese: 'Therese' };
const titled = x => { const v = String(x || '').trim(); return v ? v[0].toUpperCase() + v.slice(1) : ''; };
const LAYOUTS = {
  // A status | B date | C amount | D partner | E analytic | F label | G account
  abed: { sheet: 'Abed', date: 2, status: 1, owner: 'abed',
    rows: (r, own) => { const a = num(r[3]);
      const partner = str(r[4]), label = str(r[6]), an = str(r[5]);
      if (!a) return [OWNED(0, [partner, label].filter(Boolean).join(' · ') || 'note', /^payment$/i.test(an) ? '' : an, 'note')];   // a row without an amount is still a row
      const self = new RegExp('^' + own + '$', 'i').test(partner);
      const isPay = a < 0;
      // Abed's day: 50$ alone, 70$ when his son works with him (Mario, 2026-09-05); 25$ = half a day
      const dayOf = x => x === 70 ? 'day with son' : x === 50 ? 'day alone' : x === 25 ? 'half day' : x === 35 ? 'half day with son' : 'work';
      const desc = isPay ? ['received', str(r[7]) && str(r[7]) !== own ? 'from ' + str(r[7]) : '', label].filter(Boolean).join(' ') || 'received'
        : self && !label ? 'Abed · ' + dayOf(a) : [partner, label].filter(Boolean).join(' · ') || 'expense';
      return [OWNED(a, desc, /^payment$/i.test(an) ? '' : an, isPay ? 'transfer' : self ? 'labour' : '',
        { partner: partner || (isPay ? 'mario' : ''), ...(self && !isPay ? { withSon: a === 70 || a === 35 } : {}) })]; } },
  // A status | B date | C amount | D account (person / vendor) | E vendor bill | F project | G note
  georges: { sheet: 'Georges', date: 2, status: 1, owner: 'georges',
    rows: (r, own) => { const a = num(r[3]);
      const who = str(r[4]), bill = str(r[5]), note = str(r[7]);
      if (!a) return [OWNED(0, [who, bill, note].filter(Boolean).join(' · ') || 'note', str(r[6]), 'note')];
      const self = new RegExp('^' + own, 'i').test(who);
      const isPay = a < 0;
      const desc = isPay ? ['received', who && !self ? 'from ' + who : '', note].filter(Boolean).join(' ') || 'received'
        : [who, bill, note].filter(Boolean).join(' · ') || 'expense';
      return [OWNED(a, desc, str(r[6]), isPay ? 'transfer' : self && !bill ? 'labour' : '', { partner: who || (isPay ? 'mario' : '') })]; } },
  // A ID | B name | C status | D date | E start | F end | G h | H Due1 | I Due2 | J Type | K Km | L T2 | M Project | N Due4 | O Note Exp | P Credit | Q Credit Account | R Note Credit
  khoder: { sheet: 'data', date: 4, status: 3, owner: 'khodr',
    rows: r => { const out = [];
      const h = hours(r[7]), wage = money(num(r[8]) + num(r[9])), exp = num(r[14]), cr = num(r[16]);   // the sheet's own total = Due1 + Due2 + Due4 + Credit
      const project = str(r[13]);
      if (wage) out.push(OWNED(wage, `${h ? h.toFixed(2) + ' h' : 'labour'}${num(r[9]) ? ' + transport' : ''}`, project, 'labour', { hours: h, partner: 'khodr' }));
      if (exp) { const what = str(r[15]) || 'expense'; out.push(OWNED(exp, what, project, /previous balance/i.test(what) ? 'opening' : '', { partner: /previous balance/i.test(what) ? '' : what })); }
      if (cr) { const from = str(r[17]), note = str(r[18]); out.push(OWNED(cr, [cr < 0 ? 'received' : 'given', from ? (cr < 0 ? 'from ' : 'to ') + from : '', note].filter(Boolean).join(' '), '', 'transfer', { partner: from || 'mario' })); }
      return out; } },
  // A yy-mm | B status | C date | D Hr | E type | F KM | G Due1 | H Due2 | I Due3 | J Received | K Note | L Project
  mitri: { sheet: 'data', date: 3, status: 2, owner: 'mitri',
    rows: r => { const out = [];
      const h = hours(r[4]), wage = num(r[7]) + num(r[8]), exp = num(r[9]), rec = num(r[10]);
      const note = str(r[11]), project = str(r[12]);
      const nameIn = t => (String(t || '').match(/from\s+([a-z]+)/i) || [])[1] || '';
      if (wage) out.push(OWNED(wage, `${h ? h + ' h' : 'labour'}${str(r[5]) ? ' ' + str(r[5]) : ''}${num(r[6]) ? ' ' + num(r[6]) + ' km' : ''}${note && !exp && !rec ? ' · ' + note : ''}`, project, 'labour', { hours: h, partner: 'mitri' }));
      if (exp) out.push(OWNED(exp, note || 'expense', project, '', { partner: note.replace(/\d+[.,]?\d*\s*\$?/g, '').trim().slice(0, 40) }));
      if (rec) out.push(OWNED(rec, rec < 0 ? (note || 'received') : (note || 'bonus'), project, rec < 0 ? 'transfer' : '', { partner: rec < 0 ? (nameIn(note) || 'mario') : 'mitri' }));
      return out; } },
  // A status | B date | C amount (+ in, − out) | D label | E project | F type | G account | H account2
  ziad: { sheet: 'accounting', date: 2, status: 1, owner: 'ziad',
    rows: r => { const a = num(r[3]);
      const label = str(r[4]), acct = str(r[7]), tag = str(r[8]), type = str(r[6]);
      if (!a) return [OWNED(0, label || 'note', '', 'note')];
      const isTr = /transfer/i.test([type, acct, tag].join(' '));
      const isPrev = /previous balance/i.test(label + type);
      const from = (label.match(/from\s+([a-z]+)/i) || [])[1] || '';
      return [OWNED(-a, [label, acct && !/transfer/i.test(acct) && !new RegExp(acct, 'i').test(label) ? acct : '', /official|invoice/i.test(tag) ? tag.toLowerCase() : ''].filter(Boolean).join(' · '),
        str(r[5]) === 'general' ? '' : str(r[5]), isPrev ? 'opening' : isTr ? 'transfer' : '',
        { lbp: num(r[10]) || 0, partner: a > 0 ? (from || 'mario') : (acct && !/transfer/i.test(acct) ? acct : '') })]; } },
};

async function readExcel(file, layoutName, sheetName) {
  const ExcelJS = tryRequire('exceljs', EXTRA.exceljs);
  if (!ExcelJS) throw new Error('exceljs is not installed on this machine — run the import from Mario\'s laptop');
  const lay = LAYOUTS[layoutName];
  if (!lay) throw new Error('unknown Excel layout: ' + layoutName);
  if (!file || !fs.existsSync(file)) throw new Error('workbook not found: ' + file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName || lay.sheet);
  if (!ws) throw new Error(`sheet "${sheetName || lay.sheet}" not in ${path.basename(file)} (has: ${wb.worksheets.map(w => w.name).join(', ')})`);
  const rows = [];
  ws.eachRow((row, i) => {
    const r = row.values;                                // 1-based
    const date = day(r[lay.date]);
    if (!date) return;
    const status = str(r[lay.status]).toLowerCase();
    for (const mv of lay.rows(r, lay.owner)) rows.push({ ...mv, date, period: status === 'old' || status === 'new' ? status : '', row: i });
  });
  return { rows, sheet: ws.name, file: path.basename(file) };
}

// ── Matching ────────────────────────────────────────────────────────────────
const days = (a, b) => Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000;
const words = s => String(s || '').toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter(w => w.length > 2);
const sameDir = (r, o) => (r.debit > 0 && o.debit > 0) || (r.credit > 0 && o.credit > 0);
const amt = t => t.debit || t.credit || 0;

// One-to-one: an incoming row and a target line with the same amount, the same way, a few
// days apart. Closest dates pair first. `loose` allows a small gap in the amount when the
// texts share a word (Abed writes "7" for a 7.60 Attal ticket).
function pairUp(rows, targets, opts) {
  const { maxDays = 3, taken = new Set(), loose = false } = opts || {};
  const pairs = [];
  for (const r of rows) for (const o of targets) {
    if (taken.has(o.id) || !sameDir(r, o)) continue;
    const d = days(r.date, o.date); if (d > maxDays) continue;
    const a = amt(r), b = amt(o), diff = Math.abs(a - b);
    if (diff < 0.011) pairs.push({ r, o, d, w: 0 });
    else if (loose && diff <= Math.max(1, a * 0.1)) {
      const wr = words(r.description + ' ' + (r.partnerName || '')), wo = words(o.description + ' ' + (o.partnerName || '') + ' ' + (o.files || []).join(' '));
      if (wr.some(w => wo.includes(w))) pairs.push({ r, o, d, w: 1 });
    }
  }
  pairs.sort((a, b) => a.w - b.w || a.d - b.d);
  const dup = new Map(), used = new Set(taken);
  for (const p of pairs) { if (dup.has(p.r.id) || used.has(p.o.id)) continue; dup.set(p.r.id, { id: p.o.id, loose: !!p.w }); used.add(p.o.id); }
  return dup;
}

async function importExcel(ctx, account, who) {
  const { acc, txCol } = ctx;
  const cfg = account.excel || {};
  if (!cfg.file) throw new Error('no workbook set on this account (⚙ → Excel ledger)');
  const { rows, sheet, file } = await readExcel(cfg.file, cfg.layout || account.owner, cfg.sheet);
  const lay = LAYOUTS[cfg.layout || account.owner] || {};
  const amap = ctx.ws ? await bills.loadMapPublic(ctx.ws) : {};
  const col = txCol(account);
  const cur = await col.get();
  const existing = {}; cur.docs.forEach(d => { existing[d.id] = d.data(); });
  // the Excel is the account: every Odoo line (hidden or not) is a candidate to fold onto a row
  const odoo = cur.docs.map(d => d.data()).filter(t => t.src === 'odoo');

  // stable ids: date + side + cents + a slug of the text, numbered when a day repeats itself
  const seen = {};
  const lines = rows.map(r => {
    const debit = r.amount > 0 ? money(r.amount) : 0, credit = r.amount < 0 ? money(-r.amount) : 0;
    const base = `xl-${r.date}-${debit ? 'd' : 'c'}${Math.round((debit || credit) * 100)}-${slugId(r.description) || 'x'}`;
    seen[base] = (seen[base] || 0) + 1;
    const id = seen[base] > 1 ? `${base}-${seen[base]}` : base;
    // money in = someone handed it to him, so the counterparty is that person's cash;
    // money out = what he spent it on, as the sheet writes it
    const raw = String(r.partner || '').trim().toLowerCase();
    const partnerName = credit && !/attal|tchagh|solaris|khoury|kbm|khc|njk|narinco|medco|electromec|metaleo/i.test(raw) ? (CASH_OF[raw] || titled(r.partner) || 'Mario cash') : titled(r.partner);
    const vendorInLabel = raw === (lay.owner === 'khodr' ? 'khoder' : lay.owner) && /attal|tchagh|solaris|khoury|kbm|khc|njk|narinco|medco|electromec|metaleo|epoxy|steel|paint|laser/i.test(r.description || '');
    const nat = bills.natureOf({ credit, kind: vendorInLabel ? '' : r.kind, partnerRaw: vendorInLabel ? String(r.description).replace(/^abeds*·s*/i, '') : raw, owner: lay.owner === 'khodr' ? 'khoder' : lay.owner });
    if (vendorInLabel) { r.kind = ''; }
    return { id, src: 'excel', date: r.date, ref: '', service: 'Excel', phone: '', description: r.description, debit, credit,
      project: r.project || '', partnerName, period: r.period || '', ...nat,
      kind: r.kind || '', kindSrc: r.kind ? 'excel' : '', hours: r.hours || 0, excelRow: r.row, importedAt: now() };
  });

  // a spend with no project (benzine) belongs to the site he worked that day, else the last one seen
  { const byDay = {}; for (const l of lines) if (l.project && l.kind === 'labour') byDay[l.date] = byDay[l.date] || l.project;
    let last = ''; for (const l of lines.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) {
      if (l.project) { last = l.project; continue; }
      if (l.nature === 'transfer') { l.project = ''; l.projectFrom = ''; continue; }
      if ((l.debit || l.credit) && l.kind !== 'note' && l.kind !== 'opening') { const after = () => { const d = Object.keys(byDay).sort().find(x => x > l.date); return d ? byDay[d] : ''; }; const p = byDay[l.date] || last || after(); if (p) { l.project = p; l.projectFrom = byDay[l.date] ? 'same day' : last ? 'day before' : 'day after'; } }
    } }
  const taken = new Set(Object.values(existing).filter(t => t.dupSrc === 'manual').map(t => t.dupOf).filter(Boolean));
  const dup = pairUp(lines.filter(l => !(existing[l.id] || {}).bookedMove), odoo, { taken, loose: true });
  const byId = Object.fromEntries(odoo.map(o => [o.id, o]));
  let added = 0, updated = 0, linked = 0, loose = 0;
  const odooWrites = {};                                              // Odoo line id → its new state
  for (const o of odoo) odooWrites[o.id] = { excluded: true, odooOnly: true, dupOf: null, dupSrc: '' };
  // an Odoo entry the hub made from a row (a monthly bill, a payment) stays that row's entry
  const madeFrom = {}; for (const l of lines) { const b = (existing[l.id] || {}).bookedMove; if (b && b.id && !madeFrom[b.id]) madeFrom[b.id] = l.id; }
  for (const o of odoo) { const mid = o.odoo && o.odoo.matches && o.odoo.matches[0] && o.odoo.matches[0].moveId; if (mid && madeFrom[mid]) odooWrites[o.id] = { excluded: true, odooOnly: false, dupOf: madeFrom[mid], dupSrc: 'auto' }; }
  // an entry the Odoo import tied by name to a row keeps that tie while the row exists
  const rowIds = new Set(lines.map(l => l.id));
  for (const o of odoo) if (o.tiedBy && o.dupOf && rowIds.has(o.dupOf)) odooWrites[o.id] = { excluded: true, odooOnly: false, dupOf: o.dupOf, dupSrc: 'auto' };
  // a person's own link (dupSrc manual) is kept as it is
  for (const o of odoo) if (o.dupSrc === 'manual' && o.dupOf) odooWrites[o.id] = { excluded: true, odooOnly: false };
  const writes = lines.map(t => {
    const prev = existing[t.id] || {};
    const { partnerName, project, nature, partnerKind, cashAccountId, ...rest } = t;
    const data = { ...rest, project, projectFrom: t.projectFrom || '', excluded: false, dupOf: null };          // the Excel row always counts
    // what the sheet itself says about the row
    if (prev.partnerSrc !== 'manual') Object.assign(data, { partnerName: partnerName || '', partnerId: null, partnerSrc: partnerName ? 'excel' : '' });
    if (prev.natureSrc !== 'manual') Object.assign(data, { nature: nature || '', partnerKind: partnerKind || '', cashAccountId: cashAccountId || '' });
    if (prev.analyticSrc !== 'manual') {
      const e = project ? amap[bills.norm(project)] : null;
      Object.assign(data, e && e.id ? { analyticName: e.name, analyticId: e.id, analyticSrc: 'excel' } : { analyticName: project || '', analyticId: null, analyticSrc: project ? 'excel' : '' });
    }
    // a row already booked into a monthly bill keeps that link whatever else changes
    if (prev.bookedMove) { data.bookedMove = prev.bookedMove; data.ref = prev.ref; data.service = prev.service; data.odoo = prev.odoo; }
    // money he was handed is not an expense of any company but the one that holds his account
    // money handed to him and everything unofficial live in S LB; an official vendor's bill is the SARL's until Odoo says otherwise
    const co = nature === 'transfer' || nature === 'labour' || nature === 'expense' ? 'S LB' : nature === 'vendor' || nature === 'refund' ? 'SHIFT GROUP SARL (USD)' : '';
    if (prev.companySrc !== 'manual') Object.assign(data, { company: co, companySrc: co ? 'excel' : '' });
    const d = dup.get(t.id);
    const o = d ? byId[d.id] : null;
    if (o) {
      // fold the Odoo facts onto the row: it now carries the entry it was booked as
      linked++; if (d.loose) loose++;
      const win = (o.odoo && o.odoo.matches || []).find(m => m.chosen) || null;
      data.odoo = { checkedAt: now(), matches: win ? [{ ...win, why: [...(win.why || []), d.loose ? 'close amount, shared word' : 'same amount, same days'] }] : [] };
      data.matchedOdoo = o.id; data.ref = o.ref || ''; data.files = o.files || []; data.service = o.service || 'Excel';
      // the row keeps the sheet's own word for the partner; the Odoo partner shows on a second line from the match
      if (o.partnerId && prev.partnerSrc !== 'manual') data.partnerId = o.partnerId;
      if (o.company && prev.companySrc !== 'manual') Object.assign(data, { company: o.company, companySrc: 'odoo', kind: prev.kindSrc === 'manual' ? prev.kind : (t.kind || 'work'), kindSrc: prev.kindSrc === 'manual' ? 'manual' : (t.kind ? 'excel' : 'odoo') });
      if (o.analyticId && prev.analyticSrc !== 'manual') Object.assign(data, { analyticId: o.analyticId, analyticName: o.analyticName, analyticSrc: 'odoo', analyticFrom: o.analyticFrom || '' });
      if (o.paidBy && prev.paidBySrc !== 'manual') Object.assign(data, { paidBy: o.paidBy, paidBySrc: 'odoo' });
      odooWrites[o.id] = { excluded: true, odooOnly: false, dupOf: t.id, dupSrc: 'auto' };
    } else if (prev.matchedOdoo) {
      // matched last time, not any more: the sheet's own facts (set above) stand alone again
      data.odoo = null; data.matchedOdoo = null; data.ref = ''; data.files = []; data.service = 'Excel';
      data.analyticFrom = '';
      if (prev.paidBySrc === 'odoo') { data.paidBy = ''; data.paidBySrc = ''; }
    }
    if (prev.kindSrc === 'manual') { delete data.kind; delete data.kindSrc; }
    if (existing[t.id]) updated++; else added++;
    return { ref: col.doc(t.id), data };
  });
  for (const [id, data] of Object.entries(odooWrites)) writes.push({ ref: col.doc(id), data });
  // rows that left the sheet leave here too (unless a person annotated them)
  const keep = new Set(lines.map(l => l.id));
  const gone = cur.docs.filter(d => d.data().src === 'excel' && !keep.has(d.id) && !d.data().transferId && d.data().dupSrc !== 'manual' && !d.data().note);
  for (let i = 0; i < gone.length; i += 450) { const b = account.ref.firestore.batch(); gone.slice(i, i + 450).forEach(d => b.delete(d.ref)); await b.commit(); }
  await acc.batchSet(account.ref.firestore, writes);
  const first = lines.reduce((m, l) => !m || l.date < m ? l.date : m, ''), last = lines.reduce((m, l) => l.date > m ? l.date : m, '');
  await account.ref.set({ excel: { ...cfg, sheet, lastFile: file, first, last }, lastExcelImport: now(), lastExcelImportBy: who }, { merge: true });
  return { rows: lines.length, added, updated, removed: gone.length, linkedToOdoo: linked, looseLinks: loose, first, last, file, sheet };
}

// ── WhatsApp ────────────────────────────────────────────────────────────────
const AR_DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
const latinDigits = s => String(s || '').replace(/[٠-٩۰-۹]/g, d => AR_DIGITS[d]);
const PEOPLE_AR = { mario: /ماريو/, abed: /عبد/, georges: /جورج/, ziad: /زياد/, mitri: /متري|مطري/, khodr: /خضر/, therese: /تريز/, whish: /وش/ };
const PEOPLE_LAT = { mario: /\bmario\b/i, abed: /\babed\b|\babdo\b/i, georges: /\bgeorges?\b/i, ziad: /\bziad\b/i, mitri: /\bmitri\b|\bmetre\b/i, khodr: /\bkh[ou]d[eo]?r\b|\bkhudr\b/i, therese: /\bth[eé]r[eè]se\b/i, whish: /\bwhish\b/i };
const personIn = (s, table) => { for (const [k, rx] of Object.entries(table)) if (rx.test(s || '')) return k; return ''; };

// One message → { amount (USD), currency, side: 'debit'|'credit'|'', skip: reason } or null when it is not money.
function parseMoney(text, owner, fromMe, lbpRate) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const t = latinDigits(raw);
  if (/\b(tanks?|liters?|litres?|\d+\s*l)\b\s+from/i.test(t) || /^\d+\s*(tanks?|l)\b/i.test(t)) return { skip: 'fuel' };
  // Mario's running-balance notes ("*balance* 185$ to khoder", "باقي من حسابك 76$", "واصل اضافي 66$") are not movements
  if (/balance|باقي|متوجب|اضافي|subtotal|\btotal\b/i.test(t)) return { skip: 'balance note' };
  if (/^(ok|👍|\.+|same as picture)/i.test(t)) return null;
  let amount = 0, currency = '';
  let m = t.match(/(-?\d+(?:[.,]\d+)?)\s*(?:\$|usd|dollars?)/i) || t.match(/\$\s*(-?\d+(?:[.,]\d+)?)/);
  if (m) { amount = parseFloat(m[1].replace(',', '.')); currency = 'USD'; }
  else if ((m = t.match(/(\d+(?:[.,]\d+)?)\s*دولار(?:\s*و\s*(\d+)\s*سنت)?/))) { amount = parseFloat(m[1].replace(',', '.')) + (m[2] ? parseInt(m[2], 10) / 100 : 0); currency = 'USD'; }
  else if ((m = t.match(/(\d+(?:[.,]\d+)?)\s*(مليون|الف|ألف|ليرة|lbp|l\.l\.?|ll)\b/i))) {
    const mult = /مليون/.test(m[2]) ? 1e6 : /الف|ألف/.test(m[2]) ? 1e3 : 1;
    amount = parseFloat(m[1].replace(',', '.')) * mult / (lbpRate || 89500); currency = 'LBP';
  }
  else if (/^\s*-?\d+(?:[.,]\d+)?\s*$/.test(t)) return { skip: 'bare number' };
  if (!amount || !isFinite(amount)) return null;
  const neg = amount < 0; amount = Math.abs(amount);
  let side = '';
  const low = t.toLowerCase();
  if (/(الف|ألف|ليرة|مليون|دولار)/.test(t) && !/\bfrom\b|\bto\b/i.test(t)) {
    // the worker's own note, in Arabic
    if (/قبض|قبضت|وصلني|استلمت/.test(t)) side = 'credit';
    else if (/من عند|للشغيل|للمعلم|حق|بنزين|اجرة|جعالة|تعبئة|تعباية|مواصلات|واصل ل/.test(t)) side = 'debit';
    else { const mm = t.match(/من\s+(\S+)/); side = mm && personIn(mm[1], PEOPLE_AR) ? 'credit' : 'debit'; }
  } else {
    const from = (low.match(/from\s+([a-zé]+)/) || [])[1] || '', to = (low.match(/\bto\s+([a-zé]+)/) || [])[1] || '';
    const pf = personIn(from, PEOPLE_LAT) || (from ? 'other' : ''), pt = personIn(to, PEOPLE_LAT) || (to ? 'other' : '');
    if (/on (the )?behalf of/.test(low)) side = 'credit';
    else if (/paid by\s+([a-z]+)\s+to\s+([a-z]+)/.test(low)) side = pt === owner ? 'credit' : pf === owner ? 'debit' : '';
    else if (pf && pt) side = pt === owner ? 'credit' : pf === owner ? 'debit' : '';
    else if (pf) side = pf === owner ? 'debit' : 'credit';
    else if (pt) side = pt === owner ? 'credit' : pt === 'mario' ? 'debit' : '';
    else if (/\bpaid\b|\bfor\b/.test(low)) side = fromMe ? 'credit' : 'debit';
    else side = fromMe ? 'credit' : 'debit';
    if (!side) return { amount: money(amount), currency, skip: 'between other people' };
  }
  if (neg) side = side === 'debit' ? 'credit' : 'debit';
  return { amount: money(amount), currency, side };
}

function openArchive() {
  const Database = tryRequire('better-sqlite3', EXTRA['better-sqlite3']);
  if (!Database) throw new Error('better-sqlite3 is not installed on this machine — run the import from Mario\'s laptop');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync('D:/vscode/whatsapp-local/config.json', 'utf8')); } catch (e) { /* defaults */ }
  const file = process.env.WHATSAPP_DB || cfg.msgstore || 'D:/Dropbox/whatsapp/msgstore.db';
  if (!fs.existsSync(file)) throw new Error('WhatsApp archive not found: ' + file);
  return new Database(file, { readonly: true, fileMustExist: true });
}
const beirutDay = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });

function listGroups(q) {
  const db = openArchive();
  try {
    const rows = db.prepare(`select c._id id, c.subject, j.raw_string jid, (select count(*) from message m where m.chat_row_id = c._id) n,
      (select max(timestamp) from message m where m.chat_row_id = c._id) last from chat c join jid j on j._id = c.jid_row_id
      where c.subject is not null and (? = '' or lower(c.subject) like ?) order by last desc limit 200`).all(q || '', '%' + (q || '').toLowerCase() + '%');
    return rows.map(r => ({ id: r.id, name: r.subject, jid: r.jid, messages: r.n, last: r.last ? beirutDay(r.last) : '' }));
  } finally { db.close(); }
}

async function importWhatsapp(ctx, account, who) {
  const { acc, txCol } = ctx;
  const cfg = account.whatsapp || {};
  if (!cfg.chatId) throw new Error('no WhatsApp group set on this account (⚙ → WhatsApp group)');
  const owner = account.owner || '';
  const since = cfg.since || '2025-07-01';
  const db = openArchive();
  let msgs, chatName = '';
  try {
    chatName = (db.prepare('select subject from chat where _id = ?').get(+cfg.chatId) || {}).subject || '';
    msgs = db.prepare(`select m._id id, m.timestamp ts, m.from_me me, m.text_data text, j.raw_string sender from message m
      left join jid j on j._id = m.sender_jid_row_id where m.chat_row_id = ? and m.text_data is not null and m.timestamp >= ? order by m.timestamp`)
      .all(+cfg.chatId, Date.parse(since + 'T00:00:00Z'));
  } finally { db.close(); }

  const col = txCol(account);
  const cur = await col.get();
  const existing = {}; cur.docs.forEach(d => { existing[d.id] = d.data(); });
  const targets = cur.docs.map(d => d.data()).filter(t => (t.src === 'odoo' || t.src === 'excel' || t.src === 'manual' || t.src === 'telegram') && !t.excluded);

  const lines = [], skipped = {};
  for (const m of msgs) {
    const p = parseMoney(m.text, owner, !!m.me, cfg.lbpRate);
    if (!p) continue;
    if (p.skip) { skipped[p.skip] = (skipped[p.skip] || 0) + 1; continue; }
    const text = String(m.text).replace(/\s+/g, ' ').trim();
    lines.push({ id: 'wa-' + m.id, src: 'whatsapp', date: beirutDay(m.ts), ref: '', service: 'WhatsApp', phone: '',
      description: text.slice(0, 160), debit: p.side === 'debit' ? p.amount : 0, credit: p.side === 'credit' ? p.amount : 0,
      waFrom: m.me ? 'mario' : 'them', waCurrency: p.currency, waAt: new Date(m.ts).toISOString(),
      kind: /\bfrom\b|\bto\b/i.test(text) && p.side ? 'transfer' : '', kindSrc: 'whatsapp', importedAt: now() });
  }
  const taken = new Set(Object.values(existing).filter(t => t.dupSrc === 'manual').map(t => t.dupOf).filter(Boolean));
  const dup = pairUp(lines, targets, { taken, maxDays: 4, loose: true });
  let added = 0, updated = 0, linked = 0, review = 0, accepted = 0;
  const writes = lines.map(t => {
    const prev = existing[t.id] || {};
    const data = { ...t };
    if (!/\bfrom\b|\bto\b/i.test(t.description) || !t.kind) { delete data.kind; delete data.kindSrc; }
    if (prev.kindSrc === 'manual') { delete data.kind; delete data.kindSrc; }
    if (prev.dupSrc === 'manual') { if (!prev.excluded) accepted++; }
    else {
      const d = dup.get(t.id);
      if (d) { data.dupOf = d.id; data.excluded = true; data.dupSrc = 'auto'; data.review = false; linked++; }
      else { data.dupOf = null; data.excluded = true; data.dupSrc = 'auto'; data.review = true; review++; }
    }
    if (existing[t.id]) updated++; else added++;
    return { ref: col.doc(t.id), data };
  });
  await acc.batchSet(account.ref.firestore, writes);
  const first = lines.reduce((m, l) => !m || l.date < m ? l.date : m, ''), last = lines.reduce((m, l) => l.date > m ? l.date : m, '');
  await account.ref.set({ whatsapp: { ...cfg, name: chatName, since, first, last }, lastWhatsappImport: now(), lastWhatsappImportBy: who }, { merge: true });
  return { messages: msgs.length, lines: lines.length, added, updated, linked, review, accepted, skipped, first, last, group: chatName };
}

// ── Transfers between this account and the other people's ───────────────────
// "100$ from mario" here and 100 leaving Mario's cash days apart are one movement; so are
// "received from Ziad" and 100 leaving Ziad's. A line is paired with the account of the
// person it names (Mario when it names nobody but is a transfer), each side used once.
// Two Odoo lines of the same journal entry are the same movement for certain.
async function linkTransfers(ctx, account, who, opts) {
  const { ws, listAccounts, txCol, resolve } = ctx;
  const owner = account.owner || '';
  if (!owner) throw new Error('set the owner of this account first (⚙)');
  const all = (await listAccounts(ws)).filter(a => a.id !== account.id && a.owner && !a.statement && !a.archived);
  const byOwner = {}; for (const a of all) (byOwner[a.owner] = byOwner[a.owner] || []).push(a);
  if (!Object.keys(byOwner).length) throw new Error('no other account with an owner to link with');
  const text = t => [t.description, t.partnerName, t.name, (t.files || []).join(' ')].join(' ');
  const namesOf = t => Object.keys(PEOPLE_LAT).filter(k => k !== 'whish' && PEOPLE_LAT[k].test(text(t)));
  const moveOf = t => t.src === 'odoo' && t.odoo && t.odoo.matches && t.odoo.matches[0] ? t.odoo.matches[0].moveId : null;
  const mine = (await txCol(account).get()).docs.map(d => d.data()).filter(t => !t.excluded && !t.transferId);
  const lines = {};                                                   // account id → its free lines
  for (const a of all) lines[a.id] = (await txCol(await resolve(ws, a.id)).get()).docs.map(d => d.data()).filter(t => !t.excluded && !t.transferId);
  const pairs = [];
  for (const a of mine) {
    const named = namesOf(a).filter(n => n !== owner);
    const isTr = a.kind === 'transfer' || /\bfrom\b|\breceived\b|\bto mario\b/i.test(a.description || '');
    if (!named.length && !isTr) continue;
    const who2 = named.length ? named : ['mario'];
    const side = a.credit > 0 ? 'in' : 'out';                          // in: they → this account; out: this account → them
    const targets = who2.flatMap(n => byOwner[n] || []);
    const aMove = moveOf(a);
    for (const other of targets) for (const m of lines[other.id]) {
      const same = side === 'in' ? Math.abs((m.debit || 0) - a.credit) < 0.011 : Math.abs((m.credit || 0) - a.debit) < 0.011;
      if (!same) continue;
      const d = days(a.date, m.date); if (d > 4) continue;
      const sameMove = aMove && moveOf(m) === aMove;
      pairs.push({ a, m, other, d, w: sameMove ? 0 : PEOPLE_LAT[owner].test(text(m)) ? 1 : 2, side });
    }
  }
  pairs.sort((x, y) => x.w - y.w || x.d - y.d);
  const usedA = new Set(), usedM = new Set(), made = [];
  const maxNew = (opts && opts.limit) || 1000;
  for (const p of pairs) {
    if (usedA.has(p.a.id) || usedM.has(p.other.id + '/' + p.m.id)) continue;
    if (p.w === 2 && !(opts && opts.loose)) continue;                 // the other side must name this person unless asked otherwise
    usedA.add(p.a.id); usedM.add(p.other.id + '/' + p.m.id);
    if (made.length >= maxNew) break;
    const id = newId();
    const amount = money(p.side === 'in' ? p.a.credit : p.a.debit);
    const tr = { id, date: p.a.date, fromId: p.side === 'in' ? p.other.id : account.id, toId: p.side === 'in' ? account.id : p.other.id, amount, currency: account.currency || 'USD',
      note: 'auto-linked: ' + (p.a.description || '').slice(0, 80), fromTxId: p.side === 'in' ? p.m.id : p.a.id, toTxId: p.side === 'in' ? p.a.id : p.m.id, auto: true, createdAt: now(), createdBy: who };
    const b = ws.firestore.batch();
    const mark = { transferId: id, kind: 'transfer', kindSrc: 'transfer', updatedAt: now() };
    b.set(txCol(account).doc(p.a.id), mark, { merge: true });
    b.set(txCol(await resolve(ws, p.other.id)).doc(p.m.id), mark, { merge: true });
    b.set(ws.collection('transfers').doc(id), tr);
    await b.commit();
    made.push({ id, date: tr.date, amount, from: tr.fromId, to: tr.toId, mine: p.a.id, other: p.m.id, how: p.w === 0 ? 'same Odoo entry' : p.w === 1 ? 'named' : 'amount only' });
  }
  const unmatched = mine.filter(a => !usedA.has(a.id) && (namesOf(a).some(n => n !== owner) || a.kind === 'transfer' || /\bfrom\b|\breceived\b/i.test(a.description || '')))
    .map(a => ({ id: a.id, date: a.date, amount: amt(a), description: a.description }));
  return { linked: made.length, transfers: made, unmatched: unmatched.length, unmatchedLines: unmatched.slice(0, 200) };
}

// ── Gold & silver ───────────────────────────────────────────────────────────
// Mario's bullion sits in one workbook: a `gold` sheet and two silver sheets, each with a
// purchases table "buyer | date | amount paid | qty | unit | …" and a market price cell.
// Read on the laptop, stored under settings/gold so the dashboard works anywhere.
const OZ_PER_KG = 32.1507;
const GOLD_FILE = process.env.GOLD_XLSX || 'D:/Dropbox/0. SHIFT/0. ACCOUNTING/ms/00. XLS/0. GOLD/20250422 gold+silver.xlsx';
async function readGold(file) {
  const ExcelJS = tryRequire('exceljs', EXTRA.exceljs);
  if (!ExcelJS) throw new Error('exceljs is not installed on this machine — read the workbook from Mario\'s laptop');
  file = file || GOLD_FILE;
  if (!fs.existsSync(file)) throw new Error('workbook not found: ' + file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const holdings = [], prices = {};
  for (const ws of wb.worksheets) {
    const name = ws.name.toLowerCase();
    const metal = name.startsWith('gold') ? 'gold' : name.startsWith('silver') && !name.includes('history') ? 'silver' : '';
    if (!metal) continue;
    let head = 0;
    ws.eachRow((row, i) => { if (!head && /^buyer$/i.test(str(row.values[1]))) head = i; });
    if (!head) continue;
    // market price: gold F3 ($/oz); silver F3 = $/kg, G3 = $/oz
    const p = metal === 'gold' ? num(ws.getRow(3).values[6]) : num(ws.getRow(3).values[7]);
    if (p && !prices[metal]) prices[metal] = p;
    ws.eachRow((row, i) => {
      if (i <= head) return;
      const r = row.values, buyer = str(r[1]), date = day(r[2]), paid = num(r[3]), qty = num(r[4]), unit = str(r[5]);
      if (!buyer || !qty) return;
      const oz = /kg/i.test(unit) ? money(qty * OZ_PER_KG) : money(qty);
      const owner = /mario/i.test(buyer) ? 'mario' : /therese/i.test(buyer) ? 'therese' : /youssef|yousef/i.test(buyer) ? 'youssef' : slugId(buyer);
      holdings.push({ metal, owner, buyer, date, paid, qty, unit, oz, sheet: ws.name, row: i });
    });
  }
  return { holdings, prices, file: path.basename(file), readAt: now() };
}

module.exports = { importExcel, importWhatsapp, linkTransfers, listGroups, readExcel, parseMoney, LAYOUTS, readGold };
