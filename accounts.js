// Cash & bank accounts as first-class objects of the Accounting app.
//
// The Whish page grew a grid, a rules engine and an Odoo matcher around one statement
// account. Every other account — Mario's wallet, Neo, Wise, the workers' cash — wants the
// same grid and the same logic, so an *account* is now a record created from the page
// ("+"), not a module written per bank. Firestore, under workspaces/<team>:
//   accounts/<id>            { id, name, type: 'cash'|'bank', currency, provider,
//                              odooJournals: [{ id, name, companyId, company }],
//                              opening: { date, amount, note }, createdAt, createdBy }
//   accounts/<id>/tx/<txId>  one line: date, description, debit (money out), credit
//                            (money in), partner/company/analytic/note as on Whish,
//                            src: 'odoo' | 'budget' | 'manual' | 'transfer' | 'telegram',
//                            paidBy (who physically paid), excluded/dupOf (a line that
//                            is a second record of another one, kept but not counted)
//   transfers/<id>           { date, fromId, toId, amount, currency, note, fromTxId, toTxId }
//                            one transfer = an OUT line on the source and an IN line on the
//                            destination; never an expense, never an income
//
// The Whish account keeps living in whishAccounts/<no>/tx: resolve() presents it as an
// account like any other, so the old URLs and the folder watcher keep working.
//
// Statement lines carry their own running balance (Whish prints it). Every other account
// is balanced from its opening row: the balance is pinned to `opening.amount` on
// `opening.date`, and lines before that date get the implied history.
//
//   GET    /api/accounting/accounts                      all accounts (Whish included)
//   POST   /api/accounting/accounts                      create { name, type, currency, odooJournals, opening }
//   GET    /api/accounting/accounts/<id>                 one account
//   PATCH  /api/accounting/accounts/<id>                 name / opening / journals
//   GET    /api/accounting/accounts/<id>/tx              lines (date, then id)
//   GET    /api/accounting/accounts/<id>/search?q=       every matching line of the account, any year
//   POST   /api/accounting/accounts/<id>/tx              add a manual line
//   PATCH  /api/accounting/accounts/<id>/tx/<txId>       annotate (same fields as Whish + paidBy, excluded)
//   DELETE /api/accounting/accounts/<id>/tx/<txId>       manual / budget lines only
//   POST   /api/accounting/accounts/<id>/tx-bulk         { items: [{ id, ...fields }] }
//   POST   /api/accounting/accounts/<id>/tx/<txId>/docs   attach a photo / scan / file to a line
//   GET    /api/accounting/accounts/<id>/tx/<txId>/docs/<docId>   the file itself
//   DELETE /api/accounting/accounts/<id>/tx/<txId>/docs/<docId>
//   GET    /api/accounting/odoo-file/<attachmentId>     an Odoo attachment, for the viewer
//   POST   /api/accounting/accounts/<id>/odoo-check      match lines against the account's Odoo journals
//   POST   /api/accounting/accounts/<id>/import-odoo     pull every line of the account's Odoo journals
//   POST   /api/accounting/accounts/<id>/import-budget   { budgetAccountId } pull the HomeBudget history
//   POST   /api/accounting/accounts/<id>/import-excel    read the account's Excel ledger (local machine only)
//   POST   /api/accounting/accounts/<id>/import-whatsapp read the account's WhatsApp group (local machine only)
//   POST   /api/accounting/accounts/<id>/whatsapp-live   { messages, since } from the laptop's nightly browser read → proposals
//   POST   /api/accounting/accounts/<id>/close-statement the statement was sent: every "new" row of the Excel becomes "old" (local machine only)
//   POST   /api/accounting/accounts/<id>/link-transfers  { loose? } join "from mario" lines with Mario's cash as transfers
//   POST   /api/accounting/scan/launch                   open HP Smart on this laptop
//   GET    /api/accounting/scan/new?since=<ms>            the page it just scanned, as bytes
//   GET    /api/accounting/statements                    per worker: last statement, sheet/hub/Odoo agreement, what waits for the ✓
//   GET    /api/accounting/whatsapp-groups?q=            the archive's groups, for the ⚙ form
//   GET    /api/accounting/odoo/journals                 the Odoo bank/cash journals, for the "+" form
//   GET    /api/accounting/transfers                     list
//   POST   /api/accounting/transfers                     { date, fromId, toId, amount, note, fromTxId?, toTxId? }
//   PATCH  /api/accounting/transfers/<id>                { date?, amount?, note? }
//   DELETE /api/accounting/transfers/<id>
// HP Smart saves its pages here (overridable, e.g. if the folder is ever moved)
const SCAN_DIR = process.env.SCAN_DIR
  || require('path').join(require('os').homedir(), 'OneDrive', 'Desktop', 'to arrange', 'shift group usd');

// which fields on a row mean its project changed, and so must reach the Odoo line it was booked as
const ANALYTIC_FIELDS = ['analyticId', 'analyticName', 'analyticSplit', 'analyticSrc'];

const acc = require('./accounting');
const ledgers = require('./ledgers');   // the workers' Excel ledgers, WhatsApp groups, transfer linking
const bills = require('./ledger-bills');
const statements = require('./statements');   // the workers' statement round: last sent, what agrees, what is waiting  // a worker's month → one draft bill; the analytic map

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };   // true = handled
const readBody = (req, max) => new Promise((resolve, reject) => {
  // keep the chunks as bytes and decode once: a "·" split across two chunks became U+FFFD and
  // that character went straight into the workbook (2026-09-07)
  const parts = []; let n = 0;
  req.on('data', c => { parts.push(c); n += c.length; if (n > (max || 4e6)) req.destroy(); });
  req.on('end', () => { try { const s = Buffer.concat(parts).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const money = n => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Annotation fields a person may set on any line. The Whish list, plus:
//   paidBy   who physically paid (mario | abed | georges | ziad | mitri | khodr | therese | other)
//   excluded the line is not counted in the balance (a duplicate, a note, a cancelled entry)
//   dupOf    the id of the line this one repeats
const ANNOT = ['note', 'kind', 'analyticId', 'analyticName', 'company', 'companySrc', 'partnerId', 'partnerName', 'partnerSrc',
  'noteSrc', 'kindSrc', 'analyticSrc', 'analyticFrom', 'suggestSkip', 'paidBy', 'paidBySrc', 'excluded', 'dupOf', 'transferId', 'review', 'nature', 'natureSrc', 'partnerKind', 'cashAccountId', 'projectFrom', 'retype', 'ask', 'answer', 'amountSrc', 'pendingExcel', 'noBook', 'waAccepted',
  // What was typed on the phone before Odoo had a say: free text, never rejected.
  // The laptop turns it into a real partner / analytic when you accept the proposal.
  'partnerText', 'analyticText',
  // asked for from the phone, booked from the laptop after you look at it
  'bookWanted', 'bookWantedAt', 'bookWantedBy',
  // when the WhatsApp message behind the line was sent, and by whom — every line born from a
  // message carries it, typed by hand or read by the importer (Mario, 2026-09-12: "record on
  // what time on whatsapp this was done")
  'waAt', 'waFrom',
  // ☑ Reviewed: a person looked at the line; the server stamps when and who (Mario, 2026-09-09)
  'reviewed', 'reviewedAt', 'reviewedBy',
  // ⛽ a benzine line: which car it went into, the odometer at the pump, the litres
  'car', 'carSrc', 'odometer', 'liters',
  // the line shared between analytic accounts by percentage, the Odoo way: [{ id, name, pct }]
  'analyticSplit'];   // `docs` is written by the upload route only, never by a PATCH
// Fields of a line a person typed (or Telegram sent). Odoo/statement lines keep theirs.
const LINE = ['date', 'description', 'debit', 'credit', 'ref', 'service'];
// what a correction can change in the workbook itself, on a row that came from it
const SHEET_FIELDS = ['date', 'description', 'debit', 'credit', 'hours', 'km', 'project'];

const PEOPLE = {
  mario: /\bmario\b/i, abed: /\babed\b|\babdo\b/i, georges: /\bgeorges?\b/i, ziad: /\bziad\b/i,
  mitri: /\bmitri\b|\bmetre\b/i, khodr: /\bkh[ou]d[eo]?r\b|\bkhudr\b/i, therese: /\bth[eé]r[eè]se\b/i,
};
// "paid by abed", "paid_mario", "received by ziad", "- paid by .pdf" (nobody named)
function paidByIn(texts) {
  for (const t of texts) {
    const m = String(t || '').match(/(?:paid|received|payé|pay)[ _-]*(?:by)?[ _-]+([a-zé]+)/i);
    if (!m) continue;
    for (const [who, rx] of Object.entries(PEOPLE)) if (rx.test(m[1])) return who;
  }
  return '';
}
const ownerOf = account => account.owner || Object.keys(PEOPLE).find(k => PEOPLE[k].test(account.name || '')) || '';

// ── Accounts ────────────────────────────────────────────────────────────────
function whishAsAccount(d) {
  const x = d.data();
  return { id: d.id, name: 'Whish · ' + (x.name || d.id), type: 'bank', provider: 'whish', currency: x.currency || 'USD', owner: 'mario',
    statement: true, odooJournalWord: 'whish', odooJournals: [], opening: null, whish: { account: x.account, phone: x.phone, lastUpload: x.lastUpload || '' } };
}
async function listAccounts(ws) {
  const [a, w] = await Promise.all([ws.collection('accounts').get(), ws.collection('whishAccounts').get()]);
  return [...w.docs.map(whishAsAccount), ...a.docs.map(d => ({ id: d.id, ...d.data() }))]
    .sort((x, y) => (x.type === y.type ? 0 : x.type === 'cash' ? -1 : 1) || String(x.name).localeCompare(String(y.name)));
}
// An account by id — from `accounts`, or the Whish account wearing the same coat.
async function resolve(ws, id) {
  const d = await ws.collection('accounts').doc(id).get();
  if (d.exists) return { id, ...d.data(), ref: ws.collection('accounts').doc(id) };
  const w = await ws.collection('whishAccounts').doc(id).get();
  if (w.exists) return { ...whishAsAccount(w), ref: ws.collection('whishAccounts').doc(id) };
  return null;
}
const txCol = a => a.ref.collection('tx');
// "09:05", "2026-09-07 09:05" or an ISO instant → ISO instant; a bare time is Beirut time on the line's day
function waInstant(v, day) {
  v = String(v || '').trim(); let m;
  if ((m = v.match(/^(\d{1,2}):(\d{2})$/)) && day) v = `${day} ${m[1].padStart(2, '0')}:${m[2]}`;
  if ((m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/))) return new Date(`${m[1]}T${m[2]}:00+03:00`).toISOString();
  const d = new Date(v); return isNaN(d) ? null : d.toISOString();
}

const { LOG_AREAS, logCol, diffOf, hubLog } = require('./hub-log');
const dailyAccess = require('./daily-access');

// ── ⛽ Fuel by car ────────────────────────────────────────────────────────────
// A benzine line carries the car it went into and the odometer at the pump, so the fuel view
// can say what each car burns per km (Mario, 2026-09-09). Abed drives the BMW and Georges the
// RAV4; Khoder and Ziad take the Laredo or the Tacoma, so theirs is read off the words (or the
// photo) and otherwise asked on the row. The page reads a line the same way (fuelOf there).
// ── The timesheet, and the copy of it the hub keeps ─────────────────────────
// His workbook lives on Mario's laptop, so only the laptop can read it. Everything else — the
// phone, the deployed hub — reads a mirror of the days, one document per month under the account
// (Mario, 2026-09-10: the hours and their projects belong on his ledger and on a sheet of their
// own). The mirror is refreshed on every import and every time the 🕐 screen is opened locally;
// it is never written back to the workbook, which stays the record.
const hasTimesheet = a => !!(a && a.timesheet && (a.timesheet.file || (a.excel && a.excel.file)));
async function readTimesheetOf(a) {
  const cfg = a.timesheet || {};
  const file = cfg.file || (a.excel && a.excel.file);
  if (!file) throw new Error('this account has no workbook with a timesheet');
  return ledgers.readTimesheet(file, cfg.sheet || 'timesheet', { rate: cfg.rate, rates: cfg.rates, freeHours: cfg.freeHours });
}
async function mirrorTimesheet(a, read) {
  const col = a.ref.collection('timesheet');
  const byMonth = {};
  for (const d of read.days || []) (byMonth[d.month] = byMonth[d.month] || []).push(d);
  const db = a.ref.firestore;
  const at = now();
  for (let i = 0; i < read.months.length; i += 200) {
    const b = db.batch();
    for (const M of read.months.slice(i, i + 200)) {
      const { tasks, ...rest } = M;                       // `tasks` is the 🕐 screen's own note, not the mirror's
      b.set(col.doc(M.month), { ...rest, days: byMonth[M.month] || [], readAt: at,
        file: read.file, sheet: read.sheet, freeHours: read.freeHours }, { merge: false });
    }
    await b.commit();
  }
  return { months: read.months.length, days: (read.days || []).length, at };
}

const CARS = ['BMW', 'RAV4', 'Laredo', 'Tacoma'];
const OWN_CAR = { abed: 'BMW', georges: 'RAV4' };
const isFuel = s => /benzin|fuel|essence|petrol|gasoline|mazout|gasoil|diesel|\btank\b|⛽/i.test(s || '') && !/water tank/i.test(s || '');
const carIn = s => { const m = String(s || '').match(/\b(bmw|rav ?4|laredo|tacoma)\b/i); return m ? CARS.find(c => c.toLowerCase() === m[1].replace(/\s/g, '').toLowerCase()) : ''; };
const odometerIn = s => { const m = String(s || '').match(/odomet\w*\D{0,12}(\d{1,3}(?:[,. ]\d{3})+|\d{4,7})|(\d{1,3}(?:[,. ]\d{3})+|\d{5,7})\s*km\b/i); const v = m && (m[1] || m[2]); return v ? +v.replace(/[,. ]/g, '') : null; };
function fuelOf(t, account) {
  if (!(t.car || isFuel([t.description, t.partnerName, t.note].join(' ')))) return null;
  const words = (t.description || '') + ' ' + (t.note || '');
  const car = t.car || carIn(words) || OWN_CAR[(account && account.owner) || ''] || '';
  const odoSet = t.odometer != null && t.odometer !== '';
  return { car, carSrc: t.car ? (t.carSrc || 'manual') : car ? 'auto' : '', odometer: odoSet ? +t.odometer : odometerIn(words), odoSrc: odoSet ? 'manual' : 'auto', liters: t.liters || null };
}

// ── Odoo helpers ─────────────────────────────────────────────────────────────
let _journalCache = { at: 0, list: [] };
async function odooJournals(odooCall) {
  if (Date.now() - _journalCache.at < 10 * 60000 && _journalCache.list.length) return _journalCache.list;
  const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id', 'name'] });
  const rows = await odooCall('account.journal', 'search_read', [[['type', 'in', ['bank', 'cash']]]],
    { fields: ['id', 'name', 'company_id', 'type', 'currency_id', 'default_account_id', 'active'], context: { allowed_company_ids: companies.map(c => c.id), active_test: false }, order: 'company_id, name' });
  _journalCache = { at: Date.now(), list: rows.map(r => ({
    id: r.id, name: r.name + (r.active === false ? ' (archived)' : ''), type: r.type, active: r.active !== false, companyId: r.company_id ? r.company_id[0] : null, company: r.company_id ? r.company_id[1] : '',
    currency: r.currency_id ? r.currency_id[1] : '', accountId: r.default_account_id ? r.default_account_id[0] : null, account: r.default_account_id ? r.default_account_id[1] : ''
  })) };
  return _journalCache.list;
}
// The matcher wants { rows, ctx } like journalsNamed() gives: build it from the account's own journals.
async function journalsOf(odooCall, account) {
  if (!(account.odooJournals || []).length) return null;
  const all = await odooJournals(odooCall);
  const ids = new Set(account.odooJournals.map(j => +j.id));
  const rows = all.filter(j => ids.has(j.id)).map(j => ({ id: j.id, name: j.name, company_id: [j.companyId, j.company], default_account_id: [j.accountId, j.account] }));
  const ctx = { allowed_company_ids: [...new Set(rows.map(r => r.company_id[0]))] };
  return { rows, ctx };
}
const shortCompany = s => String(s || '').replace(/SHIFT GROUP SARL \(USD\)/, 'SARL').replace(/SHIFT GROUP SARL \(LBP\)/, 'SARL LBP').replace(/SHIFT DEVELOPMENT/, 'S DEV').replace(/SHIFT GROUP OFFSHORE SAL/, 'OFFSHORE');

// Where an account's Odoo side lives: either a set of cash/bank journals, or — for a
// worker who advances his own money and is settled as a contractor — his supplier
// payable across the companies. Both are read the same way.
//
// Every line of the account's Odoo source becomes a line here. The Odoo side is the
// truth for what it holds — partner, company, the bill it settles, the project on that
// bill — so those land as 'odoo' facts, never as suggestions. Who physically paid is read
// from the attachment names ("… paid by abed.pdf") and the memo, and flagged when it is
// not the account's owner: Cash Mario in Odoo was used as a general cash book.
async function importOdoo(odooCall, account, who) {
  const all = await odooJournals(odooCall);
  const out = { journals: [], lines: 0, added: 0, updated: 0, paidByOthers: 0, split: 0 };
  const splitBases = new Set();   // 'odoo-<lineId>' rows now replaced by one row per bill
  const col = txCol(account);
  const existing = {};
  (await col.where('src', '==', 'odoo').get()).docs.forEach(d => { existing[d.id] = d.data(); });
  const madeFrom = {};   // Odoo move id → the Excel row it was booked from (bills, payments made by the hub)
  (await col.where('src', '==', 'excel').get()).docs.forEach(d => { const b = d.data().bookedMove; if (b && b.id && !madeFrom[b.id]) madeFrom[b.id] = d.id; });
  const owner = ownerOf(account);
  const writes = [];
  // one source per journal, or one per company when the account follows a partner's payable
  const sources = [];
  const pid = account.odooPartner && +account.odooPartner.id;
  for (const j0 of account.odooJournals || []) {
    const j = all.find(x => x.id === +j0.id);
    if (!j || !j.accountId) { out.journals.push({ id: j0.id, error: 'journal not found' }); continue; }
    sources.push({ id: j.id, name: j.name, companyId: j.companyId, company: j.company,
      domain: [['account_id', '=', j.accountId], ['parent_state', '!=', 'cancel']] });
  }
  if (pid) {
    const companies = await odooCall('res.company', 'search_read', [[]], { fields: ['id', 'name'] });
    for (const c of companies) sources.push({ id: 'p' + c.id, name: (account.odooPartner.name || 'partner') + ' payable', companyId: c.id, company: c.name, isPartner: true,
      domain: [['partner_id', '=', pid], ['account_id.account_type', '=', 'liability_payable'], ['parent_state', '!=', 'cancel']] });
  }
  for (const j of sources) {
    const ctx = { allowed_company_ids: [j.companyId], company_id: j.companyId };
    const L = await odooCall('account.move.line', 'search_read', [j.domain],
      { fields: ['id', 'date', 'name', 'ref', 'debit', 'credit', 'amount_currency', 'partner_id', 'move_id', 'payment_id', 'journal_id', 'parent_state', 'account_id'], context: ctx, limit: 20000, order: 'date, id' });
    if (!L.length) { out.journals.push({ id: j.id, name: j.name, company: j.company, lines: 0 }); continue; }
    const ownAccounts = [...new Set(L.map(l => l.account_id[0]))];
    const moveIds = [...new Set(L.map(l => l.move_id[0]))];
    const M = moveIds.length ? await odooCall('account.move', 'read', [moveIds, ['name', 'ref', 'narration', 'move_type', 'attachment_ids']], { context: ctx }) : [];
    const byMove = Object.fromEntries(M.map(m => [m.id, m]));
    const payIds = [...new Set(L.map(l => l.payment_id && l.payment_id[0]).filter(Boolean))];
    let P = payIds.length ? await odooCall('account.payment', 'read', [payIds, ['memo', 'reconciled_bill_ids', 'reconciled_invoice_ids', 'payment_type']], { context: ctx }) : [];
    const byPay = Object.fromEntries(P.map(p => [p.id, p]));
    const settleByMove = {};
    if (moveIds.length) {
      try {
        const S = await odooCall('account.payment', 'search_read', [[['x_transfer_move_id', 'in', moveIds]]], { fields: ['id', 'name', 'memo', 'reconciled_bill_ids', 'reconciled_invoice_ids', 'payment_type', 'x_transfer_move_id', 'move_id'], context: ctx });
        for (const sp of S) { settleByMove[sp.x_transfer_move_id[0]] = sp; P.push(sp); }
      } catch (e) { /* no settlement field on this database */ }
    }
    const billIds = [...new Set(P.flatMap(p => [...(p.reconciled_bill_ids || []), ...(p.reconciled_invoice_ids || [])]))];
    const B = billIds.length ? await odooCall('account.move', 'read', [billIds, ['name', 'ref', 'invoice_date', 'amount_total', 'attachment_ids', 'move_type']], { context: ctx }) : [];
    const byBill = Object.fromEntries(B.map(b => [b.id, b]));
    const attIds = [...new Set([...M, ...B].flatMap(m => m.attachment_ids || []))];
    const AT = attIds.length ? await odooCall('ir.attachment', 'read', [attIds, ['name']], { context: ctx }) : [];
    const attName = Object.fromEntries(AT.map(a => [a.id, a.name]));
    const anByMove = await acc.analyticOfMoves(odooCall, moveIds, ctx);
    // the other side of a plain entry (no payment): tells what the cash went to
    const others = moveIds.length ? await odooCall('account.move.line', 'search_read', [[['move_id', 'in', moveIds], ['account_id', 'not in', ownAccounts], ['display_type', 'not in', ['line_section', 'line_note']]]],
      { fields: ['move_id', 'account_id', 'name', 'partner_id'], context: ctx, limit: 20000 }) : [];
    const otherOf = {}; for (const o of others) (otherOf[o.move_id[0]] = otherOf[o.move_id[0]] || []).push(o);

    for (const l of L) {
      const m = byMove[l.move_id[0]] || {};
      const p = l.payment_id ? byPay[l.payment_id[0]] : (settleByMove[m.id] || null);
      const bills = p ? [...(p.reconciled_bill_ids || []), ...(p.reconciled_invoice_ids || [])].map(id => byBill[id]).filter(Boolean) : [];
      const fileIds = [...new Set([...(m.attachment_ids || []), ...bills.flatMap(b => b.attachment_ids || [])])].filter(id => attName[id]).map(id => ({ id, name: attName[id] }));
      const files = fileIds.map(x => x.name);
      const lineName = String(l.name || '').replace(/^Manual:\s*/, '');
      const desc = (p && p.memo) || m.ref || (lineName && lineName !== 'Manual' ? lineName : '') || (bills[0] && (bills[0].ref || bills[0].name)) || '';
      const other = (otherOf[m.id] || [])[0];
      const description = [desc, !desc && other ? other.account_id[1] : ''].filter(Boolean).join(' ');
      const rec = anByMove[m.id] || { analytics: [], docs: [], docIds: {} };
      // one entry per bill: the reconciled name "BILL/… (ref)" wins over the bare bill name
      const docs = [...new Set([...rec.docs, ...bills.map(b => b.name).filter(n => !rec.docs.some(d => d.startsWith(n)))])].filter(d => d && d !== m.name);
      const docIds = { ...(rec.docIds || {}), ...Object.fromEntries(bills.map(b => [b.name, b.id])), ...(p && p.name && p.move_id ? { [p.name]: p.move_id[0] } : {}) };
      const paidBy = paidByIn([...files, p && p.memo, m.ref, m.narration]);
      const counterparty = j.isPartner ? (other && other.partner_id ? other.partner_id : null) : l.partner_id;
      // One payment settling several bills is several facts, never one grouped line: the
      // partial reconciliations say how much of it went to each bill, so the line is split
      // into one row per bill, each with its own amount, its own scan and its own project.
      const total = money(l.debit || l.credit);
      const sign = l.amount_currency < 0 ? -1 : 1;
      const payDoc = p && p.name && p.move_id ? { [p.name]: p.move_id[0] } : {};
      let parts = [{ bill: null, amount: total, cur: l.amount_currency || 0, analytics: rec.analytics, fileIds, docs, docIds }];
      const allocs = (rec.alloc || []).filter(a => bills.some(b => b.id === a.docId) && money(a.amount) > 0);
      if (allocs.length > 1) {
        parts = allocs.map(a => {
          const b = bills.find(x => x.id === a.docId);
          return { bill: b, amount: money(a.amount), cur: l.amount_currency ? sign * money(a.cur || a.amount) : 0,
            analytics: a.analytics.length ? a.analytics : rec.analytics,
            fileIds: (b.attachment_ids || []).filter(id => attName[id]).map(id => ({ id, name: attName[id] })),
            docs: [a.doc], docIds: { [a.doc]: a.docId, ...payDoc } };
        });
        // the payment's own scans stay on the first row; what the bills do not account for
        // (an advance paid beyond them) is a row of its own, never folded into a bill
        const mine = fileIds.filter(f => (m.attachment_ids || []).includes(f.id));
        parts[0].fileIds = [...mine, ...parts[0].fileIds.filter(f => !mine.some(x => x.id === f.id))];
        const rest = money(total - parts.reduce((s, x) => s + x.amount, 0));
        if (Math.abs(rest) > 0.005) parts.push({ bill: null, amount: rest,
          cur: l.amount_currency ? money(l.amount_currency - parts.reduce((s, x) => s + x.cur, 0)) : 0,
          analytics: rec.analytics, fileIds: [], docs: [], docIds: { ...payDoc } });
      }
      const split = parts.length > 1;
      if (split) splitBases.add('odoo-' + l.id);
      parts.forEach((part, pi) => {
        const id = 'odoo-' + l.id + (split ? '-b' + (part.bill ? part.bill.id : 'x' + pi) : '');
        const prev = existing[id] || (split && pi === 0 ? existing['odoo-' + l.id] : null) || {};
        const an = part.analytics[0];
        const pFiles = part.fileIds.map(x => x.name);
        const pDesc = part.bill ? (part.bill.ref || part.bill.name || description) : description;
        const t = {
          id, src: 'odoo', date: l.date, ref: m.name || '', service: shortCompany(j.company),
          description: pDesc, name: counterparty ? counterparty[1] : '', phone: '',
          // Odoo debit on the cash account = money came in = statement credit.
          // On a payable it reads the same way: a credit is money he advanced, a debit is money he was paid.
          debit: l.credit ? part.amount : 0, credit: l.debit ? part.amount : 0, amountCurrency: part.cur || 0,
          state: l.parent_state, files: pFiles, fileIds: part.fileIds, importedAt: now(),
          odoo: { checkedAt: now(), matches: [{
            chosen: true, lineId: l.id, moveId: m.id, move: m.name, date: l.date, amount: part.amount,
            billId: part.bill ? part.bill.id : null, partOf: split ? parts.length : 0,
            partner: counterparty ? counterparty[1] : '', partnerId: counterparty ? counterparty[0] : null, label: lineName,
            company: j.company, journal: j.name, state: l.parent_state, docs: part.docs, docIds: part.docIds, odooRef: pDesc || (p && p.memo) || m.ref || '', analytics: part.analytics, score: 10, why: ['imported from Odoo'],
          }] },
        };
        // a question put to Mario on this Odoo entry, and his answer, live on the line across imports
        if (prev.ask) t.ask = prev.ask;
        if (prev.answer) t.answer = prev.answer;
        if (prev.note && !t.note) t.note = prev.note;
        if (counterparty && prev.partnerSrc !== 'manual') Object.assign(t, { partnerId: counterparty[0], partnerName: counterparty[1], partnerSrc: 'odoo' });
        if (prev.companySrc !== 'manual') Object.assign(t, { company: j.company, companySrc: 'odoo', kind: 'work', kindSrc: 'odoo' });
        if (an && prev.analyticSrc !== 'manual') Object.assign(t, { analyticId: an.id, analyticName: an.name, analyticSrc: 'odoo', analyticFrom: an.from });
        if (paidBy && prev.paidBySrc !== 'manual') Object.assign(t, { paidBy, paidBySrc: 'odoo' });
        // An account kept in an Excel ledger IS that ledger: Odoo is matched onto its rows,
        // never counted as lines of its own. The Odoo line stays, hidden, as the evidence.
        if (account.excel && account.excel.file) {
          t.excluded = true;
          // the settlement's own entry names the row it settles ("… - ABEDCASH-xl-…")
          const byRef = String([m.ref, m.narration, p && p.memo, lineName].join(' ')).match(new RegExp(account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '') + '-(xl-[\\w-]+)'));
          // a payment of a bill a row is booked to (his own cash paying an Attal invoice the row was tied to) belongs to that row as well
          const ownBills = part.bill ? [part.bill] : bills;
          const fromRow = madeFrom[m.id] || ownBills.map(b => madeFrom[b.id]).find(Boolean) || (byRef && byRef[1].replace(/-(sarl|slb)$/, ''));   // a payment split between the companies carries a suffix
          t.tiedBy = '';
          if (fromRow) { t.dupOf = fromRow; t.dupSrc = 'auto'; t.odooOnly = false; t.tiedBy = madeFrom[m.id] ? 'made' : 'ref'; }
          else if (prev.dupOf) { t.dupOf = prev.dupOf; t.dupSrc = prev.dupSrc || 'auto'; t.odooOnly = false; if (prev.dupSrc === 'manual') t.tiedBy = prev.tiedBy || 'manual'; }
          // a cents adjustment between the sheet and the supplier's invoice lives in Odoo only — never a line here (Mario, 2026-09-06)
          else if (/-ROUNDING-/i.test(String(m.ref || ''))) { t.odooOnly = false; t.dupOf = null; t.tiedBy = 'rounding'; }
          else { t.odooOnly = true; t.dupOf = null; }
        } else if (paidBy && owner && paidBy !== owner && pi === 0) out.paidByOthers++;
        if (existing[id]) out.updated++; else out.added++;
        if (split) out.split++;
        writes.push({ ref: col.doc(id), data: t });
      });
    }
    out.journals.push({ id: j.id, name: j.name, company: j.company, lines: L.length });
    out.lines += L.length;
  }
  await acc.batchSet(account.ref.firestore, writes);
  // an Odoo line that is gone (cancelled, deleted) leaves here too, unless a person tied something to it by hand
  const seen = new Set(writes.map(w => w.ref.id));
  const gone = Object.keys(existing).filter(id => !seen.has(id) && (splitBases.has(id) || existing[id].dupSrc !== 'manual'));
  for (let i = 0; i < gone.length; i += 450) { const bt = account.ref.firestore.batch(); gone.slice(i, i + 450).forEach(id => bt.delete(col.doc(id))); await bt.commit(); }
  out.removed = gone.length;
  await account.ref.set({ lastOdooImport: now(), lastOdooImportBy: who }, { merge: true });
  return out;
}

// HomeBudget kept the wallet for years; its rows come in as history. A Budget row that
// repeats an Odoo line (same amount, same way, within 3 days) is linked to it and
// excluded from the balance — matched, not summed.
async function importBudget(ws, account, budgetAccountId, who) {
  const bid = String(budgetAccountId);
  const [A, E, I, T, C, S, PY] = await Promise.all(['budgetAccounts', 'budgetExpenses', 'budgetIncome', 'budgetTransfers', 'budgetCategories', 'budgetSubCategories', 'budgetPayees']
    .map(c => ws.collection(c).get()));
  const nameOf = snap => Object.fromEntries(snap.docs.map(d => [d.id, d.data().name || '']));
  const accName = nameOf(A), cat = nameOf(C), sub = nameOf(S), payee = nameOf(PY);
  const amt = r => money(r.accAmount != null && r.accAmount !== '' ? r.accAmount : r.amount);
  const rows = [];
  E.docs.forEach(d => { const r = d.data(); if (String(r.accountId) !== bid) return;
    rows.push({ id: 'hb-e-' + d.id, date: r.date, debit: amt(r), credit: 0, description: [payee[r.payeeId], cat[r.catId], sub[r.subId], r.notes].filter(Boolean).join(' · ') || 'expense',
      hb: { kind: 'expense', catId: r.catId || '', subId: r.subId || '', payeeId: r.payeeId || '', notes: r.notes || '' } }); });
  I.docs.forEach(d => { const r = d.data(); if (String(r.accountId) !== bid) return;
    rows.push({ id: 'hb-i-' + d.id, date: r.date, debit: 0, credit: amt(r), description: [r.name, r.notes].filter(Boolean).join(' · ') || 'income',
      hb: { kind: 'income', notes: r.notes || '' } }); });
  T.docs.forEach(d => { const r = d.data();
    if (String(r.fromId) === bid) rows.push({ id: 'hb-t-' + d.id, date: r.date, debit: money(r.fromAmount != null ? r.fromAmount : r.amount), credit: 0,
      description: 'Transfer → ' + (accName[r.toId] || r.toId) + (r.notes ? ' · ' + r.notes : ''), kind: 'transfer', hb: { kind: 'transfer', toId: r.toId, notes: r.notes || '' } });
    if (String(r.toId) === bid) rows.push({ id: 'hb-t-' + d.id, date: r.date, debit: 0, credit: money(r.toAmount != null ? r.toAmount : r.amount),
      description: 'Transfer ← ' + (accName[r.fromId] || r.fromId) + (r.notes ? ' · ' + r.notes : ''), kind: 'transfer', hb: { kind: 'transfer', fromId: r.fromId, notes: r.notes || '' } }); });

  const col = txCol(account);
  const cur = await col.get();
  const existing = {}; cur.docs.forEach(d => { existing[d.id] = d.data(); });
  const odoo = cur.docs.map(d => d.data()).filter(t => t.src === 'odoo' && !t.excluded);
  const days = (a, b) => Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000;
  // one-to-one: closest date first; links a person made by hand are kept
  const taken = new Set(Object.values(existing).filter(t => t.dupSrc === 'manual').map(t => t.dupOf).filter(Boolean));
  const pairs = [];
  for (const r of rows) for (const o of odoo) {
    if (taken.has(o.id)) continue;
    const same = (r.debit && Math.abs(o.debit - r.debit) < 0.011) || (r.credit && Math.abs(o.credit - r.credit) < 0.011);
    if (same && days(r.date, o.date) <= 3) pairs.push({ r, o, d: days(r.date, o.date) });
  }
  pairs.sort((a, b) => a.d - b.d);
  const dup = new Map(), used = new Set();
  for (const p of pairs) { if (dup.has(p.r.id) || used.has(p.o.id)) continue; dup.set(p.r.id, p.o.id); used.add(p.o.id); }

  let added = 0, updated = 0, linked = 0;
  const writes = rows.map(r => {
    const prev = existing[r.id] || {};
    const t = { ...r, src: 'budget', ref: '', service: 'Budget', importedAt: now(), budgetAccountId: bid };
    if (prev.dupSrc !== 'manual') {
      const d = dup.get(r.id);
      if (d) { t.dupOf = d; t.excluded = true; t.dupSrc = 'auto'; linked++; }
      else if (prev.dupSrc === 'auto') { t.dupOf = null; t.excluded = false; t.dupSrc = ''; }
    }
    if (existing[r.id]) updated++; else added++;
    return { ref: col.doc(r.id), data: t };
  });
  await acc.batchSet(ws.firestore, writes);
  await account.ref.set({ budgetAccountId: bid, budgetAccountName: accName[bid] || '', lastBudgetImport: now(), lastBudgetImportBy: who }, { merge: true });
  return { rows: rows.length, added, updated, linkedToOdoo: linked };
}

// ── Transfers ────────────────────────────────────────────────────────────────
const trLine = (tr, side, otherName) => ({
  id: 'tr-' + tr.id, src: 'transfer', transferId: tr.id, date: tr.date, ref: '', service: 'Transfer', phone: '',
  description: (side === 'out' ? 'Transfer → ' : 'Transfer ← ') + otherName + (tr.note ? ' · ' + tr.note : ''),
  debit: side === 'out' ? money(tr.amount) : 0, credit: side === 'in' ? money(tr.amount) : 0,
  company: '', kind: 'transfer', kindSrc: 'transfer', updatedAt: now(),
});
async function writeTransferLines(ws, tr) {
  const [from, to] = await Promise.all([resolve(ws, tr.fromId), resolve(ws, tr.toId)]);
  if (!from || !to) throw new Error('unknown account');
  const b = ws.firestore.batch();
  // an existing line (a Whish top-up, an Odoo entry) is linked, not doubled
  if (tr.fromTxId) b.set(txCol(from).doc(String(tr.fromTxId)), { transferId: tr.id, kind: 'transfer', kindSrc: 'transfer', updatedAt: now() }, { merge: true });
  else b.set(txCol(from).doc('tr-' + tr.id), trLine(tr, 'out', to.name), { merge: true });
  if (tr.toTxId) b.set(txCol(to).doc(String(tr.toTxId)), { transferId: tr.id, kind: 'transfer', kindSrc: 'transfer', updatedAt: now() }, { merge: true });
  else b.set(txCol(to).doc('tr-' + tr.id), trLine(tr, 'in', from.name), { merge: true });
  await b.commit();
  return { from, to };
}
async function removeTransferLines(ws, tr, FieldValue) {
  const [from, to] = await Promise.all([resolve(ws, tr.fromId), resolve(ws, tr.toId)]);
  const b = ws.firestore.batch();
  const unlink = { transferId: FieldValue.delete(), kind: '', kindSrc: '', updatedAt: now() };
  if (from) { if (tr.fromTxId) b.set(txCol(from).doc(String(tr.fromTxId)), unlink, { merge: true }); else b.delete(txCol(from).doc('tr-' + tr.id)); }
  if (to) { if (tr.toTxId) b.set(txCol(to).doc(String(tr.toTxId)), unlink, { merge: true }); else b.delete(txCol(to).doc('tr-' + tr.id)); }
  await b.commit();
}

const journalsIn = list => (Array.isArray(list) ? list : []).map(j => ({ id: +j.id, name: j.name || '', companyId: j.companyId != null ? +j.companyId : null, company: j.company || '' })).filter(j => j.id);
const openingIn = o => o && o.date ? { date: String(o.date), amount: money(o.amount), note: String(o.note || '') } : null;
const odooPartnerIn = x => x && x.id ? { id: +x.id, name: String(x.name || '') } : null;
const excelIn = x => x && x.file ? { file: String(x.file).trim(), sheet: String(x.sheet || '').trim(), layout: String(x.layout || '').toLowerCase().trim() } : null;
// `name` is the chat title as WhatsApp Web shows it — the archive fills it for groups, but a
// one-to-one chat (Anthony, Kamal) has no subject there, so it is set by hand
const whatsappIn = x => x && x.chatId ? { chatId: +x.chatId, since: /^\d{4}-\d{2}-\d{2}$/.test(String(x.since || '')) ? String(x.since) : '', lbpRate: +x.lbpRate || 0,
  ...(x.name ? { name: String(x.name).trim() } : {}) } : null;

// ── Router ───────────────────────────────────────────────────────────────────
// ── A worker's day, read out of his WhatsApp group ───────────────────────────
// Khodr posts his arrival and his finish (in Arabic, with or without the hour) and then
// the project on a line of its own. `day-read.mjs` in D:\vscode\wa-contacts drives the
// signed-in browser; here we only turn what it read into a proposed line.
const WA_CHATS = { 'khodr-cash': 'accounting khoder', 'georges-cash': 'accounting georges',
  'abed-cash': 'accounting abed', 'ziad-cash': 'accounting ziad (money)💰', 'mitri-cash': 'accounting mitri+mario' };
const WA_DIR = 'D:\\vscode\\wa-contacts';

function runWaDay(chat, date) {
  return new Promise((resolve, reject) => {
    const p = require('child_process').spawn(process.execPath, ['day-read.mjs', '--chat', chat, '--date', date],
      { cwd: WA_DIR, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('WhatsApp did not answer in three minutes')); }, 200000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(out.indexOf('{')))); }
      catch (e) { reject(new Error((err || out || 'no answer').trim().slice(0, 200))); }
    });
  });
}

// "وصلت الساعة 8:37 AM" / "أنا وصلت" → in;  "انا خلصت 2:04PM" / "خلصت" → out.
// A short line that is neither is the project ("Ajaltoun", "Mckinsey", "Naqqache").
const HOUR = /(\d{1,2})[:.](\d{2})\s*([AP]\.?M\.?)?/i;
function hourIn(text, fallback) {
  const m = String(text).match(HOUR);
  if (!m) return fallback;
  let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toUpperCase().replace(/\./g, '');
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  // he writes 5 for five in the afternoon as often as not — trust the message's own clock
  if (!ap && fallback && h < 12 && +fallback.slice(0, 2) >= 12) h += 12;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
const mins = t => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));

function dayFromMessages(messages, account) {
  const his = messages.filter(m => m.from !== 'me');
  let arrived = '', finished = '', projects = [], notes = [];
  for (const m of his) {
    const t = String(m.text || '').trim();
    if (!t || t.startsWith('[')) continue;
    if (/وصلت|wasalt|arrived/i.test(t)) { arrived = hourIn(t, m.at); continue; }
    if (/خلصت|khalast|finish/i.test(t)) { finished = hourIn(t, m.at); continue; }
    // a bare short line with no digits is the project he was on
    for (const line of t.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      if (/^[\p{L} .'&-]{3,28}$/u.test(line) && !/\d/.test(line)) projects.push(line);
      else notes.push(line);
    }
  }
  const hours = arrived && finished && mins(finished) > mins(arrived)
    ? Math.round((mins(finished) - mins(arrived)) / 6) / 10 : 0;
  // his day is hours × the hourly rate plus a flat transport (see the labour-rate note)
  const rate = account.hourlyRate || 25 / 9, transport = account.transport == null ? 5 : account.transport;
  const amount = hours ? Math.round((hours * rate + transport) * 100) / 100 : 0;
  return {
    accountId: account.id, arrived, finished, hours, amount,
    projects: [...new Set(projects)],
    project: projects[0] || '',
    description: [arrived && finished ? `${arrived}–${finished} · ${hours} h` : '', ...notes].filter(Boolean).join(' · '),
    why: !arrived || !finished ? 'he did not write both his arrival and his finish — check the messages' : ''
  };
}

async function handle(req, res, url, user, ctx) {
  const { db, admin, TEAM_ID, odooCall, local } = ctx;
  // Everything that reads or writes a workbook on D:\ or the WhatsApp archive only exists on
  // Mario's laptop (Mario, 2026-09-09): online the button is off and the route says so.
  const LOCAL_ONLY = "this reads the Excel/WhatsApp on Mario's laptop — it only works there, not on the website";
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  let m;

  if (url === '/api/accounting/odoo/journals' && req.method === 'GET') {
    try { return json(res, 200, await odooJournals(odooCall)); }
    catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  // Khodr writes his day in his WhatsApp group instead of on the paper — arrival, finish,
  // and the project on its own line. The archive under whatsapp-local is only as fresh as
  // the last phone backup, so the day is read live through the browser (laptop only).
  if (url.startsWith('/api/accounting/daily/whatsapp') && req.method === 'GET') {
    if (!ctx.local) return json(res, 400, { error: 'WhatsApp is read from the laptop' });
    const q = new URL(req.url, 'http://x').searchParams;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : new Date().toISOString().slice(0, 10);
    const id = String(q.get('account') || 'khodr-cash');
    const acc = await resolve(ws, id);
    if (!acc) return json(res, 404, { error: 'no such person' });
    const chat = (acc.whatsapp && acc.whatsapp.chatName) || WA_CHATS[id];
    if (!chat) return json(res, 400, { error: 'no WhatsApp group is set for ' + (acc.name || id) });
    let read;
    try { read = await runWaDay(chat, date); }
    catch (e) { return json(res, 502, { error: String(e.message || e).slice(0, 300) }); }
    if (read.error) return json(res, 502, { error: read.error, names: read.names });
    return json(res, 200, { date, chat: read.chat, messages: read.messages || [], proposal: dayFromMessages(read.messages || [], acc) });
  }

  // ── The day report ───────────────────────────────────────────────────────
  // The paper Mario fills on site: one line per person per day — who worked, on which
  // project, what he did, and what he is owed for it. Every line lands on that person's
  // own ledger as a normal typed row, so 📅 Book months picks it up unchanged.
  // Accounts on the sheet are the ones flagged `daily` (a person, not a wallet).
  if (url.startsWith('/api/accounting/daily') && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : new Date().toISOString().slice(0, 10);
    const days = Math.min(31, Math.max(1, +(q.get('days') || 1) || 1));   // 1 = that day; more = that day and the ones before
    const from = new Date(date + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - (days - 1));
    const since = from.toISOString().slice(0, 10);
    const all = await listAccounts(ws);
    const people = all.filter(a => a.daily && !a.archived);
    const lines = [];
    await Promise.all(people.map(async a => {
      const acc = await resolve(ws, a.id);
      const snap = await txCol(acc).where('date', '>=', since).where('date', '<=', date).get();
      snap.docs.forEach(d => { const t = d.data(); if (t.src !== 'odoo') lines.push({ ...t, accountId: a.id, accountName: a.name }); });
    }));
    lines.sort((x, y) => x.date < y.date ? 1 : x.date > y.date ? -1 : String(x.accountName).localeCompare(String(y.accountName)));
    const access = ctx.access || { apps: ['accounting'], admin: true, projects: [] };
    const readOnly = dailyAccess.readOnlyFor(access);
    const shown = readOnly ? dailyAccess.filterForPartner(lines, access.projects) : lines;
    // progress photos / videos the workers posted on /site for these days (no amount on them)
    const media = [];
    await Promise.all(people.map(async a => {
      const snap = await ws.collection('site').doc(a.id).collection('posts').where('date', '>=', since).where('date', '<=', date).get();
      snap.docs.forEach(d => { const p = d.data(); if ((p.kind === 'photo' || p.kind === 'video') && p.parsed && p.parsed.receipt === false) media.push({ thread: a.id, who: a.name, postId: p.id, kind: p.kind, date: p.date, at: p.at, note: p.parsed.note || '' }); });
    }));
    return json(res, 200, { date, since, readOnly,
      people: readOnly ? [] : people.map(p => ({ id: p.id, name: p.name, owner: p.owner || '', odooPartner: p.odooPartner || null, defaultRate: p.defaultRate || 0, defaultProject: p.defaultProject || null, wa: !!((p.whatsapp && p.whatsapp.chatName) || WA_CHATS[p.id]) })),
      lines: shown, media: readOnly ? [] : media });
  }

  // Several lines at once — the whole day in one round trip (the phone is on site data).
  if (url === '/api/accounting/daily' && req.method === 'POST') {
    const b = await readBody(req);
    const rows = Array.isArray(b.lines) ? b.lines.slice(0, 60) : [];
    if (!rows.length) return json(res, 400, { error: 'no lines' });
    const out = [];
    for (const r of rows) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : String(b.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { out.push({ error: 'a date is needed' }); continue; }
      const acc = await resolve(ws, String(r.accountId || ''));
      if (!acc) { out.push({ error: 'no such person' }); continue; }
      const debit = money(r.debit), credit = money(r.credit);
      const id = 'm-' + newId();
      const t = { id, src: 'manual', date, ref: '', service: '', phone: '',
        description: String(r.description || '').trim(), debit, credit,
        nature: ['labour', 'expense', 'vendor', 'transfer'].includes(r.nature) ? r.nature : 'labour', natureSrc: 'manual',
        analyticId: r.analyticId || null, analyticName: String(r.analyticName || ''), analyticSrc: r.analyticId ? 'manual' : '',
        analyticText: r.analyticId ? '' : String(r.analyticText || ''),
        partnerId: acc.odooPartner ? acc.odooPartner.id : null, partnerName: acc.odooPartner ? acc.odooPartner.name : '',
        partnerSrc: acc.odooPartner ? 'auto' : '',
        note: String(r.note || ''), noteSrc: r.note ? 'manual' : '', daily: true,
        createdAt: now(), createdBy: who, updatedAt: now(), updatedBy: who };
      // A day with no price yet (Mario, 2026-09-07: Anthony's line is 0 until he prices it)
      // is kept, but never booked until the amount is filled in.
      if (!debit && !credit) { t.noBook = true; t.ask = 'no amount yet — price this day before booking'; }
      await txCol(acc).doc(id).set(t);
      // on the person's own account, so it shows in his 🕘 beside every other edit …
      await acc.ref.collection('log').add({ at: now(), who, txId: id,
        line: [date, t.description].filter(Boolean).join(' · ').slice(0, 80),
        before: {}, after: { date, description: t.description, debit, credit, nature: t.nature }, undo: false });
      out.push({ ok: true, id, accountId: acc.id, name: acc.name || acc.id });
    }
    const made = out.filter(o => o.ok);
    // … and once for the day itself, so the Daily page has a log of its own
    if (made.length) await hubLog(ws, 'daily', { who, txId: String(b.date || made[0].id),
      line: `${b.date || ''} · ${made.length} line${made.length === 1 ? '' : 's'} written`.trim(),
      before: {}, after: { lines: made.map(o => `${o.name}: ${o.id}`) } });
    return json(res, 200, { saved: made.length, lines: out });
  }

  if (url === '/api/accounting/accounts' && req.method === 'GET') return json(res, 200, await listAccounts(ws));

  // the HomeBudget accounts, so the "+" form can offer one as history (light: no rows)
  if (url === '/api/accounting/budget-accounts' && req.method === 'GET') {
    const snap = await ws.collection('budgetAccounts').get();
    return json(res, 200, snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id, currency: d.data().currency || '', archived: !!d.data().archived })));
  }

  // Remove an account and its lines. Only for accounts made here — the Whish account is its statements.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'DELETE') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'the Whish account cannot be deleted here' });
    const used = await ws.collection('transfers').where('fromId', '==', a.id).limit(1).get();
    const used2 = await ws.collection('transfers').where('toId', '==', a.id).limit(1).get();
    if (!used.empty || !used2.empty) return json(res, 400, { error: 'transfers point at this account — delete them first' });
    const snap = await txCol(a).select().get();
    for (let i = 0; i < snap.docs.length; i += 450) { const b = db.batch(); snap.docs.slice(i, i + 450).forEach(d => b.delete(d.ref)); await b.commit(); }
    await a.ref.delete();
    return json(res, 200, { ok: true, lines: snap.size });
  }

  if (url === '/api/accounting/accounts' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!name) return json(res, 400, { error: 'a name is required' });
    const type = b.type === 'bank' ? 'bank' : 'cash';
    let id = slug(b.id || name) || newId();
    if (await resolve(ws, id)) id = id + '-' + newId().slice(-4);
    const journals = journalsIn(b.odooJournals);
    const data = { id, name, type, currency: String(b.currency || 'USD').toUpperCase(), provider: b.provider || (journals.length ? 'odoo' : 'manual'),
      owner: String(b.owner || '').toLowerCase(), odooJournals: journals, opening: openingIn(b.opening), statement: false, createdAt: now(), createdBy: who };
    if (b.daily) data.daily = true;
    if (b.defaultRate) data.defaultRate = money(b.defaultRate);
    if (b.defaultProject) data.defaultProject = b.defaultProject;
    if (odooPartnerIn(b.odooPartner)) data.odooPartner = odooPartnerIn(b.odooPartner);
    if (excelIn(b.excel)) data.excel = excelIn(b.excel);
    if (whatsappIn(b.whatsapp)) data.whatsapp = whatsappIn(b.whatsapp);
    await ws.collection('accounts').doc(id).set(data);
    return json(res, 200, data);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const { ref: _ref, ...rest } = a; return json(res, 200, rest);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)$/)) && req.method === 'PATCH') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'the Whish account is defined by its statements' });
    const b = await readBody(req), data = { updatedAt: now(), updatedBy: who };
    if ('name' in b) data.name = String(b.name).trim();
    if ('type' in b) data.type = b.type === 'bank' ? 'bank' : 'cash';
    if ('currency' in b) data.currency = String(b.currency).toUpperCase();
    if ('owner' in b) data.owner = String(b.owner || '').toLowerCase();
    if ('archived' in b) data.archived = !!b.archived;
    if ('odooJournals' in b) data.odooJournals = journalsIn(b.odooJournals);
    if ('odooPartner' in b) data.odooPartner = odooPartnerIn(b.odooPartner);
    // which company carries his bills and his payable ('S LB' by default, 'SHIFT DEVELOPMENT' for Georges)
    if ('billCompany' in b) data.billCompany = String(b.billCompany || '').trim() || null;
    // a person whose day is written on the Day report sheet, and what his day costs by default
    if ('daily' in b) data.daily = !!b.daily;
    if ('defaultRate' in b) data.defaultRate = money(b.defaultRate);
    if ('defaultProject' in b) data.defaultProject = b.defaultProject || null;
    if ('opening' in b) data.opening = openingIn(b.opening);
    if ('excel' in b) data.excel = excelIn(b.excel) ? { ...(a.excel || {}), ...excelIn(b.excel) } : null;
    if ('whatsapp' in b) data.whatsapp = whatsappIn(b.whatsapp) ? { ...(a.whatsapp || {}), ...whatsappIn(b.whatsapp) } : null;
    await a.ref.set(data, { merge: true });
    return json(res, 200, { ok: true });
  }

  // ⛽ Every benzine line of every account since a day, with its car and odometer, for the fuel
  // view. Nothing is written: a car or odometer nobody typed is read off the words, as on the page.
  if (url.startsWith('/api/accounting/fuel') && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const since = /^\d{4}-\d{2}-\d{2}$/.test(q.get('since') || '') ? q.get('since') : new Date().getFullYear() + '-01-01';
    const rows = [];
    for (const a0 of await listAccounts(ws)) {
      const a = await resolve(ws, a0.id); if (!a) continue;
      const snap = await txCol(a).where('date', '>=', since).get();
      for (const d of snap.docs) {
        const t = d.data(); if (t.excluded || !(t.debit > 0)) continue;
        const f = fuelOf(t, a); if (!f) continue;
        rows.push({ accountId: a.id, who: a.name || a.id, id: d.id, date: t.date, description: String(t.description || '').slice(0, 120), amount: t.debit || 0, ...f });
      }
    }
    rows.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    return json(res, 200, { since, cars: CARS, rows });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    // ?since=YYYY-MM-DD  only the lines from that day on (the page opens on the current year:
    //                    Ziad's account holds 6,000+ lines over four years, 6 MB, half a minute)
    // ?src=excel,manual  only these sources (an Excel-kept account shows its Excel rows; the
    //                    Odoo/WhatsApp lines behind them are fetched when their chip is clicked)
    // With ?since the answer is { tx, before } — `before` carries what the earlier lines add up
    // to, so the running balance starts right without loading them. Without it: the plain array.
    const q = new URL(req.url, 'http://x').searchParams;
    const t0 = Date.now();
    const json = (r, code, body) => { const s = JSON.stringify(body); console.log(`tx ${m[1]} ${req.url.split('?')[1] || 'all'}: ${Array.isArray(body) ? body.length : body.tx.length} lines, ${Math.round(s.length / 1024)} KB, ${Date.now() - t0} ms`); r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(s); return true; };
    const since = /^\d{4}-\d{2}-\d{2}$/.test(q.get('since') || '') ? q.get('since') : '';
    const srcs = (q.get('src') || '').split(',').map(s => s.trim()).filter(Boolean);
    const order = (x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : String(x.ref || x.id).localeCompare(String(y.ref || y.id), undefined, { numeric: true });
    if (!since && !srcs.length) {
      const snap = await txCol(a).get();
      return json(res, 200, snap.docs.map(d => d.data()).sort(order));
    }
    const col = txCol(a);
    const readPeriod = async () => {
      if (!srcs.length) return (await col.where('date', '>=', since).get()).docs;
      try {   // src + date needs the composite index (src asc, date asc) on the tx group; before it exists, read the period and filter here
        return (await (since ? col.where('src', 'in', srcs.slice(0, 30)).where('date', '>=', since) : col.where('src', 'in', srcs.slice(0, 30))).get()).docs;
      } catch (e) {
        if (!/index/i.test(String(e.message))) throw e;
        console.warn('tx: no (src, date) index yet, filtering in memory —', String(e.message).slice(0, 400));
        return (await (since ? col.where('date', '>=', since) : col).get()).docs.filter(d => srcs.includes(d.data().src));
      }
    };
    // the lines before the window, fields only: enough for a count and the balance they leave.
    // ?carry=0 skips it — a chip fetching one more source into a grid that already has the carry
    const readBefore = async () => since && q.get('carry') !== '0' ? (await col.where('date', '<', since).select('date', 'debit', 'credit', 'excluded', 'xlAmount').get()).docs.map(d => d.data()) : null;
    const [docs, old] = await Promise.all([readPeriod(), readBefore()]);
    const tx = docs.map(d => d.data()).sort(order);
    let before = null;
    if (old) {
      const mv = t => t.excluded ? 0 : (t.credit || 0) - (t.debit || 0);
      // the same lines by the sheet's own unrounded figure, so the header sums and the balance
      // read like the workbook even when the grid only loaded the last few months
      const xlmv = t => t.excluded ? 0 : t.xlAmount != null ? -(+t.xlAmount) : (t.credit || 0) - (t.debit || 0);
      const op = a.opening && a.opening.date ? a.opening : null;
      before = {
        count: old.length,
        net: Math.round(old.reduce((s, t) => s + mv(t), 0) * 100) / 100,
        xlNet: old.reduce((s, t) => s + xlmv(t), 0),
        // balance pinned at the opening date: what the lines from that day up to the window add to it
        netFromOpening: op && op.date <= since ? Math.round(old.filter(t => t.date >= op.date).reduce((s, t) => s + mv(t), 0) * 100) / 100 : null,
        first: old.length ? old.reduce((m, t) => t.date < m ? t.date : m, '9999') : null,
      };
    }
    return json(res, 200, { tx, before, since, src: srcs });
  }

  // Search the WHOLE account, not the loaded window (Mario, 2026-09-07): the grid only ever
  // holds a period, but the search box must find a line from any year. The collection is read
  // once and filtered here — Firestore has no substring index — and only the matches travel.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/search$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const p = new URL(req.url, 'http://x').searchParams;
    const q = String(p.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return json(res, 400, { error: 'type at least two characters' });
    const cap = Math.min(2000, +(p.get('limit') || 500));
    const t0 = Date.now();
    const words = q.split(/\s+/).filter(Boolean);
    // ?field=  narrows the search to one column, the way Odoo's search box offers
    // "Search Partner for: attal" — everything, or exactly the column you picked.
    const FIELDS = {
      description: t => [t.description, t.service],
      ref: t => [t.ref],
      partner: t => [t.partnerName, t.phone],
      company: t => [t.company],
      analytic: t => [t.analyticName, t.project],
      note: t => [t.note],
      amount: t => [t.debit, t.credit, t.debit ? Number(t.debit).toFixed(2) : '', t.credit ? Number(t.credit).toFixed(2) : ''],
      date: t => [t.date],
      paidby: t => [t.paidBy],
    };
    const field = FIELDS[String(p.get('field') || '').toLowerCase()] || null;
    const hay = t => (field ? field(t) : [t.date, t.ref, t.description, t.note, t.partnerName, t.analyticName, t.company,
      t.service, t.phone, t.paidBy, t.src, t.debit, t.credit]).filter(v => v != null && v !== '').join(' ').toLowerCase();
    const snap = await txCol(a).get();
    const all = snap.docs.map(d => d.data());
    const hits = all.filter(t => { const h = hay(t); return words.every(w => h.includes(w)); })
      .sort((x, y) => x.date < y.date ? 1 : x.date > y.date ? -1 : 0);   // newest first
    console.log(`search ${m[1]} "${q}"${p.get('field') ? ' in ' + p.get('field') : ''}: ${hits.length} of ${all.length} lines, ${Date.now() - t0} ms`);
    return json(res, 200, { q, field: p.get('field') || '', scanned: all.length, found: hits.length, tx: hits.slice(0, cap), capped: hits.length > cap });
  }

  // ── The HP scanner, on this laptop ─────────────────────────────────────────
  // "Launch" opens HP Smart; the page then asks "anything new?" until a page appears in
  // the scan folder, and attaches it to the line. Local machine only — there is no
  // scanner behind the Render/Vercel copy.
  if (url === '/api/accounting/scan/launch' && req.method === 'POST') {
    if (!ctx.local) return json(res, 400, { error: 'the scanner is on the laptop, not on the server' });
    try {
      require('child_process').spawn('cmd', ['/c', 'start', '', 'hpsmart:'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, folder: SCAN_DIR, at: Date.now() });
    } catch (e) { return json(res, 500, { error: 'could not open HP Smart: ' + e.message }); }
  }
  // the newest scan dropped after ?since=<ms>, as bytes, so the page can attach it
  if (url.startsWith('/api/accounting/scan/new') && req.method === 'GET') {
    if (!ctx.local) return json(res, 400, { error: 'the scanner is on the laptop, not on the server' });
    const since = +(new URL(req.url, 'http://x').searchParams.get('since') || 0);
    try {
      const fs2 = require('fs'), path2 = require('path');
      if (!fs2.existsSync(SCAN_DIR)) return json(res, 200, { waiting: true, folder: SCAN_DIR, missing: true });
      const hits = fs2.readdirSync(SCAN_DIR)
        .filter(f => /\.(pdf|jpe?g|png|tiff?)$/i.test(f))
        .map(f => ({ f, st: fs2.statSync(path2.join(SCAN_DIR, f)) }))
        .filter(x => x.st.isFile() && x.st.mtimeMs > since)
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      if (!hits.length) return json(res, 200, { waiting: true, folder: SCAN_DIR });
      const top = hits[0];
      const buf = fs2.readFileSync(path2.join(SCAN_DIR, top.f));
      const ext = top.f.split('.').pop().toLowerCase();
      const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext.startsWith('tif') ? 'image/tiff' : 'image/jpeg';
      return json(res, 200, { name: top.f, mime, size: buf.length, dataBase64: buf.toString('base64') });
    } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  // ── The paper behind a line ────────────────────────────────────────────────
  // A photo taken on the phone, a file dropped on the laptop, or a page off the HP
  // scanner. It lands in the project's Storage bucket and the line keeps a small record
  // of it; when the line is booked, the file goes to Odoo as the entry's attachment.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)\/docs$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such line' });
    const b = await readBody(req, 20e6);   // a scan or a photo travels base64, so allow the room
    const raw = String(b.dataBase64 || '').replace(/^data:[^,]*,/, '');
    if (!raw) return json(res, 400, { error: 'no file' });
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) return json(res, 400, { error: 'the file is empty' });
    if (buf.length > 12e6) return json(res, 400, { error: 'the file is larger than 12 MB' });
    const mime = String(b.mime || 'application/octet-stream').slice(0, 80);
    const ext = (String(b.name || '').match(/\.([a-z0-9]{1,5})$/i) || [, mime.split('/')[1] || 'bin'])[1].toLowerCase();
    const docId = newId();
    const key = `tx-docs/${a.id}/${m[2]}/${docId}.${ext}`;
    // The bucket is the right home for these. Firebase Storage is not switched on for this
    // project yet, so until it is, the bytes go in a document of their own — never on the
    // line itself, which the grid reads by the thousand (Mario, 2026-09-07).
    let store = 'bucket';
    try {
      const bk = admin.storage().bucket();
      const [live] = await bk.exists();
      if (!live) throw new Error('bucket not created');
      await bk.file(key).save(buf, { contentType: mime, resumable: false, metadata: { metadata: { account: a.id, tx: m[2], by: who } } });
    } catch (e) {
      if (buf.length > 700e3) return json(res, 400, { error: 'Firebase Storage is not enabled for this project, so a file must stay under 700 KB. Enable Storage in the Firebase console and any size will work.' });
      await ws.collection('txDocs').doc(docId).set({ account: a.id, tx: m[2], mime, name: String(b.name || '').slice(0, 120), b64: buf.toString('base64'), at: now(), by: who });
      store = 'firestore';
      console.warn('tx doc kept in Firestore (Storage not enabled):', e.message);
    }
    const doc = { id: docId, name: String(b.name || ('photo.' + ext)).slice(0, 120), mime, size: buf.length,
      key, store, at: now(), by: who, from: String(b.from || 'upload').slice(0, 20) };   // camera | upload | scan
    const docs = [...(cur.docs || []), doc];
    await ref.set({ docs, updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, doc);
  }

  // An Odoo attachment, streamed through the app so the page can show it: the browser has no
  // Odoo session on this domain, so /web/content would only ever hand back a login page.
  if ((m = url.match(/^\/api\/accounting\/odoo-file\/(\d+)$/)) && req.method === 'GET') {
    try {
      const [f] = await odooCall('ir.attachment', 'read', [[+m[1]], ['name', 'mimetype', 'datas']],
        { context: { allowed_company_ids: [2, 4, 7, 8, 9, 10] } });
      if (!f || !f.datas) return json(res, 404, { error: 'no such attachment' });
      const buf = Buffer.from(f.datas, 'base64');
      res.writeHead(200, { 'Content-Type': f.mimetype || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${String(f.name || 'file').replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=86400' });
      res.end(buf);
      return true;
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // the file itself, streamed back through the app (the bucket stays private)
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)\/docs\/([\w-]+)$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const cur = (await txCol(a).doc(m[2]).get()).data();
    const doc = (cur && cur.docs || []).find(d => d.id === m[3]);
    if (!doc) return json(res, 404, { error: 'no such file' });
    let buf;
    if (doc.store === 'firestore') {
      const d = (await ws.collection('txDocs').doc(doc.id).get()).data();
      if (!d) return json(res, 404, { error: 'the file is gone' });
      buf = Buffer.from(d.b64, 'base64');
    } else {
      [buf] = await admin.storage().bucket().file(doc.key).download();
    }
    res.writeHead(200, { 'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${doc.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
    return true;
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)\/docs\/([\w-]+)$/)) && req.method === 'DELETE') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    const doc = (cur && cur.docs || []).find(d => d.id === m[3]);
    if (!doc) return json(res, 404, { error: 'no such file' });
    try {
      if (doc.store === 'firestore') await ws.collection('txDocs').doc(doc.id).delete();
      else await admin.storage().bucket().file(doc.key).delete();
    } catch (e) { console.warn('doc delete', e.message); }
    await ref.set({ docs: (cur.docs || []).filter(d => d.id !== m[3]), updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, { ok: true });
  }

  // A line typed by hand (or sent from Telegram). Money out is `debit`, money in `credit`,
  // as on a bank statement.
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (a.provider === 'whish') return json(res, 400, { error: 'Whish lines come from the statement' });
    const b = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return json(res, 400, { error: 'date (yyyy-mm-dd) required' });
    const debit = money(b.debit), credit = money(b.credit);
    if (!debit && !credit) return json(res, 400, { error: 'an amount is required' });
    const id = b.id ? String(b.id) : 'm-' + newId();
    const t = { id, src: b.src === 'telegram' ? 'telegram' : 'manual', date: b.date, ref: String(b.ref || ''), service: '', phone: '',
      description: String(b.description || '').trim(), debit, credit, createdAt: now(), createdBy: who, updatedAt: now(), updatedBy: who };
    for (const k of ANNOT) if (k in b) t[k] = b[k];
    if (t.waAt) t.waAt = waInstant(t.waAt, t.date);
    if (t.company) { t.companySrc = t.companySrc || 'manual'; t.kind = t.company === 'Personal' ? 'personal' : 'work'; t.kindSrc = 'manual'; }
    if (t.partnerName) t.partnerSrc = t.partnerSrc || 'manual';
    if (t.analyticName) t.analyticSrc = t.analyticSrc || 'manual';
    if (t.paidBy) t.paidBySrc = t.paidBySrc || 'manual';
    if (t.note) t.noteSrc = 'manual';
    await txCol(a).doc(id).set(t);
    return json(res, 200, t);
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)$/)) && req.method === 'PATCH') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such line' });
    const data = {};
    for (const k of ANNOT) if (k in body) data[k] = body[k];
    if (data.waAt) data.waAt = waInstant(data.waAt, body.date || cur.date);
    // the line itself may be edited only when a person wrote it
    // a person wrote it, or it is a row of the workbook — which is corrected in the sheet below
    // a /site post is a proposal the same way (2026-09-12)
    if (['manual', 'telegram', 'whatsapp', 'excel', 'site'].includes(cur.src)) {
      for (const k of LINE) {
        if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
        data[k] = k === 'debit' || k === 'credit' ? money(body[k]) : body[k];
      }
    }
    // the amount itself may be corrected on ANY line of ANY account except an Odoo mirror line (Mario, 2026-09-07)
    else if (cur.src !== 'odoo') for (const k of ['debit', 'credit']) if (k in body) data[k] = money(body[k]);
    if ('excluded' in body || 'dupOf' in body) data.dupSrc = 'manual';
    if (body.excluded === false) data.review = false;
    // ✓ on a WhatsApp line is the acceptance that lets it reach Odoo and the workbook — nothing
    // read off WhatsApp is booked before that (Mario, 2026-09-08)
    // a /site post is a proposal the same way (2026-09-12)
    if ((cur.src === 'whatsapp' || cur.src === 'site') && (body.excluded === false || body.review === false || 'answer' in body || body.waAccepted === true)) data.waAccepted = true;
    if ((cur.src === 'whatsapp' || cur.src === 'site') && (body.excluded === true || body.waAccepted === false)) data.waAccepted = false;
    // A transfer moves against one of our own cash accounts — whichever the row names ("from
    // Mario", "to Ziad"), Mario's when it names nobody. The type dropdown and the WhatsApp lines
    // used to leave it empty, and an empty one is what no poster would book, so the line sat
    // accepted and unbooked (Mario, 2026-09-09: "this should be auto linked to mario cash").
    const willBe = 'nature' in data ? data.nature : cur.nature;
    if (willBe === 'transfer' && !('cashAccountId' in data) && !cur.cashAccountId) {
      data.partnerKind = data.partnerKind || cur.partnerKind || 'cash';
      data.cashAccountId = bills.cashAccountFor([cur.partnerName, cur.partnerText, cur.description].filter(Boolean).join(' '), a.owner);
    }
    if ('paidBy' in body) data.paidBySrc = body.paidBy ? 'manual' : '';
    // ☑ Reviewed is stamped here, not by the page, so the column always says who really looked and
    // when. An undo/redo carries its own reviewedAt back and is replayed as it was.
    if ('reviewed' in body && !('reviewedAt' in body)) { data.reviewed = !!body.reviewed; data.reviewedAt = data.reviewed ? now() : ''; data.reviewedBy = data.reviewed ? who : ''; }
    // ⛽ the car is one of ours (or none); odometer and litres are numbers or nothing
    if ('car' in body) { data.car = CARS.includes(body.car) ? body.car : ''; data.carSrc = data.car ? (body.carSrc || 'manual') : ''; }
    for (const k of ['odometer', 'liters']) if (k in body) { const v = parseFloat(String(body[k] == null ? '' : body[k]).replace(/[^\d.]/g, '')); data[k] = isFinite(v) && v > 0 ? (k === 'odometer' ? Math.round(v) : Math.round(v * 100) / 100) : null; }
    // analytic shares: [{ id, name, pct }] adding up to 100, or nothing — a lone share is just the analytic
    if ('analyticSplit' in body) {
      const rows = Array.isArray(body.analyticSplit) ? body.analyticSplit.map(s => ({ id: +s.id, name: String(s.name || ''), pct: Math.round(+s.pct * 100) / 100 })).filter(s => s.id > 0 && s.pct > 0) : [];
      data.analyticSplit = rows.length > 1 ? rows : null;
    }
    // hours and km live in the workbook, not on the line: they may travel alone
    if (!Object.keys(data).length && !(cur.src === 'excel' && SHEET_FIELDS.some(k => k in body))) return json(res, 400, { error: 'nothing to update' });
    data.updatedAt = now(); data.updatedBy = who;
    // what the line said before, for undo and for the account's change log (Mario 2026-09-07)
    const before = {}; for (const k of Object.keys(data)) if (k !== 'updatedAt' && k !== 'updatedBy') before[k] = k in cur ? cur[k] : null;
    await ref.set(data, { merge: true });
    // The workbook is the account (Mario, 2026-09-07): a correction to a sheet row is written into
    // the sheet itself — the amount, the day, the hours and km behind it, the note — so the next
    // import reads it back instead of putting the old figure in again.
    let sheet = null;
    if (cur.src === 'excel' && a.excel && a.excel.file && SHEET_FIELDS.some(k => k in body)) {
      try {
        if (!local) throw new Error(LOCAL_ONLY);
        sheet = await ledgers.writeExcelRow({ acc, txCol, ws, resolve, listAccounts, odooCall }, a, { ...cur, id: m[2] }, body);
        if (sheet.wrote.length) {
          const after = { sheetWrittenAt: data.updatedAt, amountSrc: '' };
          if ('debit' in data || 'credit' in data) after.xlAmount = money((data.debit != null ? data.debit : cur.debit || 0) - (data.credit != null ? data.credit : cur.credit || 0));
          if ('hours' in body) after.hours = Number(body.hours) || 0;
          await ref.set(after, { merge: true });
        }
      } catch (e) {
        // the sheet is the account: if it would not take the change, the line does not keep it either
        sheet = { error: String(e.message || e) };
        const back = {}; for (const k of LINE) if (k in data) back[k] = k in cur ? cur[k] : null;
        if (Object.keys(back).length) await ref.set(back, { merge: true });
      }
    }
    // The project follows the row into Odoo. Changing it on the hub used to stop here, so the bill
    // kept whatever the Book run had written and the two drifted (Mario, 2026-09-10).
    let odooAnalytic = null;
    if (ANALYTIC_FIELDS.some(k => k in body)) {
      const now2 = { ...cur, ...data, id: m[2] };
      if ((now2.bookedMove && now2.bookedMove.id) || (now2.odoo && (now2.odoo.matches || []).some(x => x.chosen))) {
        try { odooAnalytic = await bills.pushAnalytic({ acc, txCol, ws, resolve, listAccounts, odooCall }, a, now2); }
        catch (e) { odooAnalytic = { error: String(e.message || e).slice(0, 200) }; }
      }
    }
    const after = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'updatedAt' && k !== 'updatedBy'));
    if (!body.__silent) await a.ref.collection('log').add({ at: data.updatedAt, who, txId: m[2], line: [cur.date, cur.description].filter(Boolean).join(' · ').slice(0, 80), before, after, undo: !!body.__undo });
    // `after` goes back too: it carries what the server added on its own (the review stamp)
    return json(res, 200, { ok: true, before, after, ...(sheet ? { sheet } : {}), ...(odooAnalytic ? { odooAnalytic } : {}) });
  }

  // the account's change log, newest first (undo/redo read it back after a reload)
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/log$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const lim = Math.min(500, +(new URL(url, 'http://x').searchParams.get('limit') || 100));
    const snap = await a.ref.collection('log').orderBy('at', 'desc').limit(lim).get();
    return json(res, 200, { entries: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx\/([\w-]+)$/)) && req.method === 'DELETE') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const ref = txCol(a).doc(m[2]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such line' });
    // An Odoo row is a fact and cannot be deleted — as long as the entry behind it is still there.
    // When that entry has been deleted in Odoo (a purchase rebooked in another company leaves the
    // old chain behind), the row mirrors nothing and is just an orphan, so it may go.
    // Mario, 2026-09-10, on Khoder's two 4-Aug SEC rows. Note `read` must ask for a REAL field:
    // with only ['id'] Odoo hands back a stub for every id, deleted ones included.
    if (cur.src === 'odoo') {
      const chosen = cur.odoo && (cur.odoo.matches || []).find(x => x.chosen);
      const moveId = (cur.staleOdoo && cur.staleOdoo.moveId) || (chosen && chosen.moveId)
        || (cur.bookedMove && cur.bookedMove.id) || null;
      if (!Number.isInteger(moveId)) return json(res, 400, { error: 'this Odoo line names no entry — check Odoo on it first' });
      let live = [];
      try { live = await odooCall('account.move', 'read', [[moveId], ['name']], {}); }
      catch (e) { return json(res, 400, { error: 'could not ask Odoo whether that entry still exists: ' + String(e.message || e) }); }
      if (live.length) return json(res, 400, { error: `this line mirrors ${live[0].name} in Odoo, which still exists — Odoo lines are facts` });
      // a /site post is a proposal the same way (2026-09-12)
    } else if (!['manual', 'telegram', 'budget', 'excel', 'whatsapp', 'site'].includes(cur.src)) {
      return json(res, 400, { error: 'only typed or imported ledger lines can be deleted; statement lines are facts' });
    }
    if (cur.transferId) return json(res, 400, { error: 'this line belongs to a transfer — delete the transfer' });
    // the paper goes with the line, wherever it was kept — except a /site line, whose file
    // belongs to the post, not the line (Mario, 2026-09-12)
    if (cur.src !== 'site') {
      for (const d of cur.docs || []) {
        try {
          if (d.store === 'firestore') await ws.collection('txDocs').doc(d.id).delete();
          else await admin.storage().bucket().file(d.key).delete();
        } catch (e) { console.warn('doc delete with line', e.message); }
      }
    }
    await ref.delete();
    // a WhatsApp / site proposal Mario deleted by hand stays deleted: the hourly read would
    // otherwise propose the same message again (Mario, 2026-09-12: "added for the second time")
    if (cur.src === 'whatsapp' || cur.src === 'site') await a.ref.set({ waDeleted: { [m[2]]: now() } }, { merge: true });
    await a.ref.collection('log').add({ at: now(), who, txId: m[2],
      line: [cur.date, cur.description].filter(Boolean).join(' · ').slice(0, 80),
      before: { date: cur.date, description: cur.description || '', debit: cur.debit || 0, credit: cur.credit || 0, src: cur.src },
      after: {}, undo: false });
    return json(res, 200, { ok: true, before: cur, after: {} });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/tx-bulk$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const col = txCol(a), at = now();
    const writes = (body.items || []).filter(i => i && /^[\w-]+$/.test(String(i.id))).map(i => {
      const data = { updatedAt: at, updatedBy: who };
      for (const k of ANNOT) if (k in i) data[k] = i[k];
      return { ref: col.doc(String(i.id)), data };
    });
    await acc.batchSet(db, writes);
    return json(res, 200, { ok: true, saved: writes.length });
  }

  // Look for the lines in the account's Odoo journals (imported Odoo lines are already facts and are skipped).
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/odoo-check$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const body = await readBody(req);
    const col = txCol(a);
    let txs = (await col.get()).docs.map(d => d.data()).filter(t => t.src !== 'odoo');
    if (Array.isArray(body.ids) && body.ids.length) { const s = new Set(body.ids.map(String)); txs = txs.filter(t => s.has(String(t.id))); }
    if (!txs.length) return json(res, 200, {});
    try {
      const journals = await journalsOf(odooCall, a);
      if (!journals && a.provider !== 'whish') return json(res, 400, { error: 'this account has no Odoo journal to check against' });
      const cs = await ws.collection('whishContacts').get();
      const names = Object.fromEntries(cs.docs.map(d => [d.id, (d.data().name || '')]));
      const found = await acc.odooCheck(odooCall, txs.map(t => ({ ...t, contactName: names[t.phone] || '' })), { journals, journalWord: 'whish' });
      const at = now();
      const writes = txs.map(t => {
        const matches = found[t.id] || [];
        const data = { odoo: { checkedAt: at, matches } };
        const win = matches.find(x => x.chosen);
        if (win) {
          if (win.partner) data.odooPartner = win.partner;
          if (win.partner && t.partnerSrc !== 'manual') { data.partnerName = win.partner; data.partnerId = win.partnerId || null; data.partnerSrc = 'odoo'; }
          if (win.company && t.companySrc !== 'manual') { data.company = win.company; data.companySrc = 'odoo'; data.kind = 'work'; data.kindSrc = 'odoo'; }
          const an = (win.analytics || [])[0];
          if (an && t.analyticSrc !== 'manual') { data.analyticId = an.id; data.analyticName = an.name; data.analyticSrc = 'odoo'; data.analyticFrom = an.from; }
        }
        return { ref: col.doc(String(t.id)), data };
      });
      await acc.batchSet(db, writes);
      return json(res, 200, found);
    } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-odoo$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    if (!(a.odooJournals || []).length && !(a.odooPartner && a.odooPartner.id)) return json(res, 400, { error: 'this account has no Odoo journals and no Odoo partner' });
    try { return json(res, 200, await importOdoo(odooCall, a, who)); }
    catch (e) { console.error('import-odoo', e); return json(res, 502, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-budget$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    const bid = b.budgetAccountId || a.budgetAccountId;
    if (!bid) return json(res, 400, { error: 'budgetAccountId required' });
    try { return json(res, 200, await importBudget(ws, a, bid, who)); }
    catch (e) { console.error('import-budget', e); return json(res, 502, { error: String(e.message || e) }); }
  }

  // the workers' ledgers — read on Mario's machine, matched here
  const ledgerCtx = { acc, txCol, ws, resolve, listAccounts, odooCall, local };
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-excel$/)) && req.method === 'POST') {
    if (!local) return json(res, 400, { error: LOCAL_ONLY });
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (excelIn(b.excel)) { a.excel = { ...(a.excel || {}), ...excelIn(b.excel) }; await a.ref.set({ excel: a.excel }, { merge: true }); }
    try {
      const r = await ledgers.importExcel(ledgerCtx, a, who);
      // a row naming a supplier Odoo knows is that supplier's own bill, not a line of the month (Mario, 2026-09-06)
      if (!a.cashBox) { try { r.vendorized = await bills.vendorize(ledgerCtx, a, who, {}); } catch (e) { r.vendorized = { error: String(e.message || e).slice(0, 160) }; } }
      // the same workbook holds his timesheet: bring the mirror up to date and put the open
      // month's cost into Odoo, so project cost is live instead of waiting for month end
      // (Mario, 2026-09-10: "my cost data is live, not waiting the end of the month")
      if (hasTimesheet(a)) {
        try {
          const read = await readTimesheetOf(a);
          r.timesheet = await mirrorTimesheet(a, read);
          r.timesheet.odoo = await bills.refreshOpenTimesheet(ledgerCtx, a, who, read);
        } catch (e) { r.timesheet = { error: String(e.message || e).slice(0, 200) }; }
      }
      return json(res, 200, r);
    }
    catch (e) { console.error('import-excel', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/close-statement$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const cb = await readBody(req).catch(() => ({}));
    try { return json(res, 200, await ledgers.closeStatement(ledgerCtx, a, who, cb || {})); }
    catch (e) { console.error('close-statement', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // ── Laptop jobs: the website asks, the laptop does ───────────────────────────────────────
  // WhatsApp and the Excel workbooks live on Mario's laptop, so those buttons used to be dead on
  // hub.shift-group.co. Now the page drops a request on the account; the always-on WhatsApp
  // daemon (wa-contacts/wa-daemon.mjs) polls this list every 30 s, runs the read through the
  // local server, and posts the result back (Mario, 2026-09-12: "pressing on the WhatsApp
  // button is not working").
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/laptop-job$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    const kind = ['whatsapp', 'excel'].includes(b.kind) ? b.kind : '';
    if (!kind) return json(res, 400, { error: 'kind: whatsapp | excel' });
    const job = { kind, at: now(), by: who };
    await a.ref.set({ laptopJob: job, laptopJobResult: admin.firestore.FieldValue.delete() }, { merge: true });
    return json(res, 200, { ok: true, job });
  }
  if (url === '/api/accounting/laptop-jobs' && req.method === 'GET') {
    const all = await listAccounts(ws);
    return json(res, 200, all.filter(a => a.laptopJob && a.laptopJob.kind).map(a => ({ id: a.id, name: a.name, ...a.laptopJob })));
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/laptop-job\/done$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    const result = { at: now(), kind: (a.laptopJob && a.laptopJob.kind) || b.kind || '', ok: !b.error, summary: String(b.summary || b.error || '').slice(0, 300) };
    await a.ref.set({ laptopJob: admin.firestore.FieldValue.delete(), laptopJobResult: result }, { merge: true });
    await hubLog(ws, 'whatsapp', { who, txId: 'laptop-job', line: `${a.id}: ${result.kind} — ${result.summary}`, before: {}, after: result });
    return json(res, 200, { ok: true, result });
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/import-whatsapp$/)) && req.method === 'POST') {
    if (!local) return json(res, 400, { error: LOCAL_ONLY });
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (whatsappIn(b.whatsapp)) { a.whatsapp = { ...(a.whatsapp || {}), ...whatsappIn(b.whatsapp) }; await a.ref.set({ whatsapp: a.whatsapp }, { merge: true }); }
    try { return json(res, 200, await ledgers.importWhatsapp(ledgerCtx, a, who)); }
    catch (e) { console.error('import-whatsapp', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // the nightly live read (wa-contacts/nightly.mjs) pushes what range-read.mjs saw in his group;
  // the lines land as proposals behind the ✓ gate exactly like the archive import
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/whatsapp-live$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (!Array.isArray(b.messages)) return json(res, 400, { error: 'messages[] required' });
    try {
      const r = await ledgers.importWhatsappLive(ledgerCtx, a, who, b.messages, String(b.since || ''));
      await hubLog(ws, 'whatsapp', { who, txId: 'live', line: `${a.id}: ${r.messages} msgs → ${r.added} new, ${r.updated} updated, ${r.kept} kept`, before: {}, after: r });
      return json(res, 200, r);
    } catch (e) { console.error('whatsapp-live', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/link-transfers$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await ledgers.linkTransfers(ledgerCtx, a, who, { loose: !!b.loose, marioId: b.marioId })); }
    catch (e) { console.error('link-transfers', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // the worker's months: what is bookable, what is booked, which projects still need an analytic account
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/months$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    try { const map = await bills.analyticMapFor(ledgerCtx, a); return json(res, 200, { months: await bills.months(ledgerCtx, a), ...map }); }   // the map first, so the months know what is mapped
    catch (e) { console.error('months', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // a cash box (Ziad): money in and out of his cash account, and the bills his cash paid
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/post-cashbox$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.postCashBox(ledgerCtx, a, who, { dry: !!b.dry, from: b.from || '', to: b.to || '' })); }
    catch (e) { console.error('post-cashbox', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // money a supplier gave back that stayed with him: a credit note from that supplier, settled by him
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/post-refunds$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.postRefunds(ledgerCtx, a, who, { dry: !!b.dry })); }
    catch (e) { console.error('post-refunds', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // money he moved back to us, or that came from another worker's cash: an entry between the two accounts
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/post-transfers$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.postTransfers(ledgerCtx, a, who, { dry: !!b.dry })); }
    catch (e) { console.error('post-transfers', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // the sheet's projects → Odoo analytic accounts, with what each project cost (labour / benzine / misc / vendors)
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/analytic-map$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    try { return json(res, 200, await bills.analyticMapFor(ledgerCtx, a)); }
    catch (e) { console.error('analytic-map', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/book-month$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.bookMonth(ledgerCtx, a, b.month, b.part || 'labour', who, { post: !!b.post, redo: !!b.redo })); }
    catch (e) { console.error('book-month', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // one accepted line → Odoo at once, with its WhatsApp photos moved onto the document (Mario 2026-09-07)
  // the hours behind his pay, month by month and project by project
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/timesheet$/)) && req.method === 'GET') {
    if (!local) return json(res, 400, { error: LOCAL_ONLY });
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    try {
      const r = await readTimesheetOf(a);
      await mirrorTimesheet(a, r);
      return json(res, 200, { ...r, booked: a.timesheetBooked || {} });
    } catch (e) { console.error('timesheet', e); return json(res, 400, { error: String(e.message || e) }); }
  }

  // The days as the hub last read them. The workbook only exists on Mario's laptop, so the phone
  // and the deployed hub read this mirror instead — refreshed on every import and every time the
  // 🕐 screen is opened from the laptop (Mario, 2026-09-10).
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/timesheet-days$/)) && req.method === 'GET') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const q = new URL(req.url, 'http://x').searchParams;
    const snap = await a.ref.collection('timesheet').get();
    const months = snap.docs.map(d => d.data())
      .filter(M => (!q.get('from') || M.month >= q.get('from').slice(0, 7)) && (!q.get('to') || M.month <= q.get('to').slice(0, 7)))
      .sort((x, y) => x.month < y.month ? -1 : 1);
    return json(res, 200, { months, booked: a.timesheetBooked || {}, timesheet: a.timesheet || null,
      days: months.flatMap(M => (M.days || []).map(d => ({ ...d, month: M.month, rate: M.rate }))) });
  }

  // read the workbook again and put the open month's cost straight into Odoo — the same thing an
  // import does, without waiting for one (Mario, 2026-09-10: cost data live, not at month end)
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/timesheet-refresh$/)) && req.method === 'POST') {
    if (!local) return json(res, 400, { error: LOCAL_ONLY });
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    try {
      const read = await readTimesheetOf(a);
      const mirror = await mirrorTimesheet(a, read);
      return json(res, 200, { mirror, odoo: await bills.refreshOpenTimesheet(ledgerCtx, a, who, read) });
    } catch (e) { console.error('timesheet-refresh', e); return json(res, 400, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/book-timesheet$/)) && req.method === 'POST') {
    if (!local) return json(res, 400, { error: LOCAL_ONLY });
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.bookTimesheetMonth(ledgerCtx, a, b.month, who, { post: b.post !== false, redo: !!b.redo })); }
    catch (e) { console.error('book-timesheet', e); return json(res, 400, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/book-row$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    if (!b.txId) return json(res, 400, { error: 'txId is required' });
    try { return json(res, 200, await bills.bookRow(ledgerCtx, a, b.txId, who)); }
    catch (e) { console.error('book-row', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // the received rows as payments to him; the unofficial vendor tickets as bills settled by him
  // expense rows that name a supplier Odoo knows become vendor rows (their own bill, out of the month); { dry } previews
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/vendorize$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await bills.vendorize(ledgerCtx, a, who, { dry: !!b.dry })); }
    catch (e) { console.error('vendorize', e); return json(res, 400, { error: String(e.message || e) }); }
  }
  if ((m = url.match(/^\/api\/accounting\/accounts\/([\w-]+)\/post-(payments|vendors)$/)) && req.method === 'POST') {
    const a = await resolve(ws, m[1]);
    if (!a) return json(res, 404, { error: 'no such account' });
    const b = await readBody(req);
    try { return json(res, 200, await (m[2] === 'payments' ? bills.postPayments : bills.postVendors)(ledgerCtx, a, who, { dry: !!b.dry })); }
    catch (e) { console.error('post-' + m[2], e); return json(res, 400, { error: String(e.message || e) }); }
  }
  // Excel project name → Odoo analytic account, kept for good
  if (url === '/api/accounting/analytic-map' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const key = await bills.saveMapEntry(ws, b.key, b.analyticId ? { id: b.analyticId, name: b.analyticName } : null, who);
      let rows = 0;
      if (b.accountId) { const a = await resolve(ws, b.accountId); if (a) rows = await bills.applyMap(ledgerCtx, a); }
      return json(res, 200, { ok: true, key, rowsUpdated: rows });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // where each worker stands: his last statement, whether sheet/hub/Odoo still agree with it,
  // and what has come in since that is waiting for the ✓ (Mario, 2026-09-08)
  if (url.startsWith('/api/accounting/statements') && req.method === 'GET') {
    try { return json(res, 200, await statements.summary({ db, admin, TEAM_ID, odooCall, local }, { fast: /fast=1/.test(url) })); }
    catch (e) { console.error('statements', e); return json(res, 400, { error: String(e.message || e) }); }
  }

  // the statement he is about to receive — prepared, never sent on its own
  if (url.startsWith('/api/accounting/statements/draft') && req.method === 'GET') {
    const id = new URL('http://x' + url).searchParams.get('id') || '';
    const a = await resolve(ws, id);
    if (!a) return json(res, 404, { error: 'no such account' });
    try {
      const all = await statements.summary({ db, admin, TEAM_ID, odooCall, local }, { fast: true });
      const row = (all.accounts || []).find(x => x.id === a.id);
      if (!row) return json(res, 400, { error: 'not a worker account' });
      return json(res, 200, { text: statements.draft(row), row });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }
  // read each worker's accounting group through the browser on this laptop: how far it has been
  // read, and how much he has written since his last statement
  if (url.startsWith('/api/accounting/statements/scan') && req.method === 'POST') {
    if (!local) return json(res, 400, { error: 'the groups can only be read from the laptop' });
    try {
      const r = await statements.scanGroups({ db, admin, TEAM_ID, odooCall, local });
      await hubLog(ws, 'statements', { who, txId: 'scan', line: `read ${r && r.read ? r.read : 0} group(s)`,
        before: {}, after: r && typeof r === 'object' ? r : { result: r } });
      return json(res, 200, r);
    }
    catch (e) { console.error('statements scan', e); return json(res, 400, { error: String(e.message || e) }); }
  }

  if (url.startsWith('/api/accounting/whatsapp-groups') && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    try { return json(res, 200, ledgers.listGroups(q)); }
    catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ── dashboard: every account's balance, summed here so the page does not download 8,000 lines ──
  if (url === '/api/accounting/balances' && req.method === 'GET') {
    const accounts = await listAccounts(ws);
    const out = [];
    for (const a of accounts) {
      const full = await resolve(ws, a.id);
      const snap = await txCol(full).select('date', 'debit', 'credit', 'excluded', 'balance', 'ref', 'review', 'src').get();
      const tx = snap.docs.map(d => d.data());
      let balance = 0;
      if (a.statement) {
        const o = tx.filter(t => t.balance != null).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : (+x.ref || 0) - (+y.ref || 0));
        balance = o.length ? money(o[o.length - 1].balance) : 0;
      } else {
        const mv = t => t.excluded ? 0 : (t.credit || 0) - (t.debit || 0);
        const op = a.opening;
        balance = money(op ? op.amount + tx.filter(t => t.date >= op.date).reduce((s, t) => s + mv(t), 0) : tx.reduce((s, t) => s + mv(t), 0));
      }
      const dates = tx.map(t => t.date).filter(Boolean).sort();
      out.push({ id: a.id, name: a.name, type: a.type, owner: a.owner || '', currency: a.currency || 'USD', provider: a.provider || '', archived: !!a.archived,
        balance, lines: tx.length, counted: tx.filter(t => !t.excluded).length, review: tx.filter(t => t.review).length, first: dates[0] || '', last: dates[dates.length - 1] || '',
        opening: a.opening || null, pinned: !!a.opening || !!a.statement });
    }
    return json(res, 200, out);
  }

  // ── gold & silver: holdings read from the workbook (laptop), prices editable anywhere ──
  const goldRef = ws.collection('settings').doc('gold');
  if (url === '/api/accounting/gold' && req.method === 'GET') {
    const d = await goldRef.get();
    return json(res, 200, d.exists ? d.data() : { holdings: [], prices: {} });
  }
  if (url === '/api/accounting/gold' && req.method === 'PATCH') {
    const b = await readBody(req), data = { updatedAt: now(), updatedBy: who };
    if (b.prices && typeof b.prices === 'object') {
      const cur = (await goldRef.get()).data() || {};
      data.prices = { ...(cur.prices || {}) };
      for (const k of ['gold', 'silver']) if (k in b.prices) data.prices[k] = money(b.prices[k]);
      data.prices.asOf = String(b.prices.asOf || now().slice(0, 10));
    }
    const prev = (await goldRef.get()).data() || {};
    await goldRef.set(data, { merge: true });
    const d = diffOf(prev, data, ['prices']);
    if (Object.keys(d.after).length) await hubLog(ws, 'gold', { who, txId: 'gold', line: 'gold / silver price',
      before: d.before, after: d.after, undo: !!b.__undo });
    return json(res, 200, { ok: true, ...d });
  }
  if (url === '/api/accounting/gold/import' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const g = await ledgers.readGold(b.file);
      const cur = (await goldRef.get()).data() || {};
      const prices = { ...g.prices, ...(cur.prices || {}) };            // a price typed here beats the sheet's
      if (!prices.asOf) prices.asOf = g.readAt.slice(0, 10);
      await goldRef.set({ holdings: g.holdings, prices, file: g.file, importedAt: g.readAt, importedBy: who }, { merge: true });
      return json(res, 200, { holdings: g.holdings.length, prices, file: g.file });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ── transfers ──
  // the change log of one area, newest first — the same shape an account's /log returns
  if ((m = url.match(/^\/api\/accounting\/log\/([\w-]+)$/)) && req.method === 'GET') {
    if (!LOG_AREAS.includes(m[1])) return json(res, 404, { error: 'no such log' });
    const lim = Math.min(500, +(new URL(url, 'http://x').searchParams.get('limit') || 100));
    const snap = await logCol(ws, m[1]).orderBy('at', 'desc').limit(lim).get();
    return json(res, 200, { entries: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }

  if (url === '/api/accounting/transfers' && req.method === 'GET') {
    const [snap, accounts] = await Promise.all([ws.collection('transfers').get(), listAccounts(ws)]);
    const nm = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).map(t => ({ ...t, fromName: nm[t.fromId] || t.fromId, toName: nm[t.toId] || t.toId }))
      .sort((x, y) => x.date < y.date ? 1 : x.date > y.date ? -1 : 0);
    return json(res, 200, list);
  }

  if (url === '/api/accounting/transfers' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return json(res, 400, { error: 'date (yyyy-mm-dd) required' });
    if (!b.fromId || !b.toId || b.fromId === b.toId) return json(res, 400, { error: 'two different accounts are required' });
    const amount = money(b.amount);
    if (!(amount > 0)) return json(res, 400, { error: 'an amount is required' });
    const id = newId();
    const tr = { id, date: b.date, fromId: String(b.fromId), toId: String(b.toId), amount, currency: String(b.currency || 'USD').toUpperCase(),
      note: String(b.note || '').trim(), fromTxId: b.fromTxId ? String(b.fromTxId) : '', toTxId: b.toTxId ? String(b.toTxId) : '', createdAt: now(), createdBy: who };
    try {
      const { from, to } = await writeTransferLines(ws, tr);
      await ws.collection('transfers').doc(id).set(tr);
      await hubLog(ws, 'transfers', { who, txId: id, line: `${tr.date} · ${from.name} → ${to.name} ${tr.amount} ${tr.currency}`,
        before: {}, after: { date: tr.date, amount: tr.amount, note: tr.note, fromId: tr.fromId, toId: tr.toId } });
      return json(res, 200, { ...tr, fromName: from.name, toName: to.name, before: {}, after: tr });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  if ((m = url.match(/^\/api\/accounting\/transfers\/([\w-]+)$/)) && req.method === 'PATCH') {
    const ref = ws.collection('transfers').doc(m[1]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such transfer' });
    const b = await readBody(req);
    const tr = { ...cur, id: m[1] };
    if ('date' in b && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) tr.date = b.date;
    if ('amount' in b && money(b.amount) > 0) tr.amount = money(b.amount);
    if ('note' in b) tr.note = String(b.note || '').trim();
    tr.updatedAt = now(); tr.updatedBy = who;
    await writeTransferLines(ws, tr);
    await ref.set(tr);
    const d = diffOf(cur, tr, ['date', 'amount', 'note']);
    if (Object.keys(d.after).length) await hubLog(ws, 'transfers', { who, txId: m[1],
      line: `${tr.date} · ${tr.amount} ${tr.currency}${tr.note ? ' · ' + tr.note : ''}`.slice(0, 80),
      before: d.before, after: d.after, undo: !!b.__undo });
    return json(res, 200, { ...tr, ...d });
  }

  if ((m = url.match(/^\/api\/accounting\/transfers\/([\w-]+)$/)) && req.method === 'DELETE') {
    const ref = ws.collection('transfers').doc(m[1]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such transfer' });
    await removeTransferLines(ws, { id: m[1], ...cur }, admin.firestore.FieldValue);
    await ref.delete();
    await hubLog(ws, 'transfers', { who, txId: m[1], line: `${cur.date} · ${cur.amount} ${cur.currency || ''} deleted`.slice(0, 80),
      before: { date: cur.date, amount: cur.amount, note: cur.note || '', fromId: cur.fromId, toId: cur.toId }, after: {} });
    return json(res, 200, { ok: true, before: cur, after: {} });
  }

  return false;
}

module.exports = { handle, resolve, listAccounts, txCol, journalsOf, ANNOT, paidByIn, importOdoo, importBudget };   // importOdoo: for standalone runs (scratchpad scripts) that must not go through the shared local server
