// ── Where each worker stands ────────────────────────────────────────────────
// One line per man: the last statement he actually received on WhatsApp, whether his workbook,
// this hub and Odoo still say the same thing at that date, and what has come in since that is
// still waiting for Mario's ✓. The cycle is: he writes on WhatsApp → the lines land here as
// proposals → Mario accepts them one by one → the sheet, Odoo and a fresh statement follow
// (Mario, 2026-09-08: "I will know when the latest statement was done").
const ledgers = require('./ledgers');

const money = n => Math.round((Number(n) || 0) * 100) / 100;
// a row moves the balance by the sheet's own figure, at the sheet's own precision
const amt = t => t.xlAmount != null ? -(+t.xlAmount) : (t.credit || 0) - (t.debit || 0);
const mv = t => t.excluded ? 0 : amt(t);

// every account that belongs to a person with a workbook and an accounting group
const isWorker = a => !a.archived && a.excel && a.excel.file && a.whatsapp && a.odooPartner && a.owner !== 'mario';

async function odooAt(odooCall, partnerId, date) {
  const lines = await odooCall('account.move.line', 'search_read',
    [[['partner_id', '=', partnerId], ['parent_state', '=', 'posted'],
      ['account_id.account_type', 'in', ['liability_payable', 'asset_receivable']],
      ...(date ? [['date', '<=', date]] : [])]],
    { fields: ['balance'], context: { allowed_company_ids: [2, 4, 7, 8, 9, 10] } });
  return money(lines.reduce((s, l) => s + l.balance, 0));
}

// The workbook itself, read from disk — the column that catches a sheet edited after the last import.
async function sheetFigures(account) {
  try {
    const cfg = account.excel || {};
    const r = await ledgers.readExcel(cfg.file, cfg.layout || account.owner, cfg.sheet);
    const rows = (r.rows || []).filter(x => x.amount || x.raw != null);
    const val = x => x.raw != null ? -(+x.raw) : -(+x.amount);
    const old = rows.filter(x => x.period === 'old');
    return {
      old: money(old.reduce((s, x) => s + val(x), 0)),
      all: money(rows.reduce((s, x) => s + val(x), 0)),
      lastOld: old.map(x => x.date).sort().pop() || '',
      rows: rows.length, newRows: rows.length - old.length,
    };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}

async function summary(ctx, opts = {}) {
  const { db, admin, TEAM_ID, odooCall, local } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const snap = await ws.collection('accounts').get();
  const accounts = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isWorker);
  const out = [];
  for (const a of accounts) {
    const txs = (await ws.collection('accounts').doc(a.id).collection('tx')
      .select('date', 'debit', 'credit', 'excluded', 'xlAmount', 'src', 'period', 'waAccepted', 'review', 'description', 'bookedMove').get())
      .docs.map(d => ({ id: d.id, ...d.data() }));
    const counted = txs.filter(t => !t.excluded);
    // what he last saw: the sheet's "old" block, or the statement we recorded when it was sent
    const oldRows = counted.filter(t => t.period === 'old');
    const rec = a.statement || null;
    const stmtDate = (rec && rec.date) || (oldRows.map(t => t.date).sort().pop() || '');
    const stmtBalance = rec && rec.balance != null ? money(rec.balance)
      : oldRows.length ? money(oldRows.reduce((s, t) => s + mv(t), 0)) : null;
    const hubAt = stmtDate ? money(counted.filter(t => t.date <= stmtDate).reduce((s, t) => s + mv(t), 0)) : null;
    const hubNow = money(counted.reduce((s, t) => s + mv(t), 0));
    let odooAtDate = null, odooNow = null, odooError = '';
    try { odooAtDate = stmtDate ? await odooAt(odooCall, a.odooPartner.id, stmtDate) : null; odooNow = await odooAt(odooCall, a.odooPartner.id, null); }
    catch (e) { odooError = String(e.message || e).slice(0, 90); }
    // waiting for the ✓: read off WhatsApp, counted here, not yet allowed into the sheet or Odoo
    const after = t => !stmtDate || t.date > stmtDate;
    const pend = txs.filter(t => t.src === 'whatsapp' && !t.waAccepted && after(t) && (!t.excluded || t.review));
    const review = pend.filter(t => t.review);
    const sheet = local && !opts.fast ? await sheetFigures(a) : null;
    out.push({
      id: a.id, name: a.name || a.id, owner: a.owner || '', group: (a.whatsapp && a.whatsapp.name) || '',
      partner: a.odooPartner.name, partnerId: a.odooPartner.id,
      statement: { date: stmtDate, balance: stmtBalance, sentAt: (rec && rec.sentAt) || '', recorded: !!rec },
      sheet, hubAt, hubNow, odooAt: odooAtDate, odooNow, odooError,
      // the three ledgers must say the same thing today; whether that equals the last statement is
      // a separate question — the difference is simply what has been booked since he last saw one
      agree: hubNow != null && odooNow != null && Math.abs(hubNow - odooNow) < 0.005
        && (!sheet || sheet.error || Math.abs(sheet.all - hubNow) < 0.005),
      matchesStatement: stmtBalance != null && odooNow != null && Math.abs(odooNow - stmtBalance) < 0.005,
      bookedSince: stmtBalance != null && hubNow != null ? money(hubNow - stmtBalance) : null,
      // a proposal is "not counted" until it is accepted, so its value has to be read past `excluded`
      pending: { lines: pend.length, value: money(pend.reduce((s, t) => s + amt(t), 0)), review: review.length,
        first: pend.map(t => t.date).sort()[0] || '', last: pend.map(t => t.date).sort().pop() || '' },
      since: hubNow != null && hubAt != null ? money(hubNow - hubAt) : null,
      wa: a.waScan || null,          // what the last Playwright read of his group found
    });
  }
  out.sort((x, y) => (x.statement.date || '').localeCompare(y.statement.date || '') || x.name.localeCompare(y.name));
  return { accounts: out, at: new Date().toISOString(), local: !!local };
}

// The statement he is about to receive, in the words the group is used to.
function draft(row) {
  const f = n => (n < 0 ? '-' : '') + Math.abs(n).toFixed(2);
  const bal = row.hubNow;
  return [
    `${row.name} — statement ${new Date().toISOString().slice(0, 10)}`,
    row.statement.date ? `previous statement ${row.statement.date}: ${f(row.statement.balance)}` : '',
    `balance now: ${f(bal)}`,
    bal < 0 ? `(we owe him ${f(-bal)})` : bal > 0 ? `(he owes us ${f(bal)})` : '(settled)',
  ].filter(Boolean).join('\n');
}


// ── The groups, read live ───────────────────────────────────────────────────
// The local archive is only as fresh as the last phone backup, so each worker's accounting group is
// read through the browser (wa-contacts/range-read.mjs, the Day report's session). We keep what the
// last read found on the account: how far it goes, the messages since his last statement, and which
// of them no line on the hub accounts for yet — so nothing he wrote can go unnoticed.
const { execFile } = require('child_process');
const READER = process.env.WA_RANGE_READER || 'D:/vscode/wa-contacts/range-read.mjs';

const runReader = (chat, since) => new Promise((resolve, reject) => {
  execFile(process.execPath, [READER, '--chat', chat, '--since', since],
    { timeout: 6 * 60e3, maxBuffer: 40e6, cwd: require('path').dirname(READER) },
    (err, stdout) => {
      if (err && !stdout) return reject(new Error(String(err.message || err).slice(0, 140)));
      try { resolve(JSON.parse(String(stdout).slice(String(stdout).indexOf('{')))); }
      catch (e) { reject(new Error('could not read the group: ' + String(stdout).slice(0, 120))); }
    });
});

async function scanGroups(ctx, opts = {}) {
  const { db, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const snap = await ws.collection('accounts').get();
  const accounts = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() })).filter(isWorker)
    .filter(a => !opts.only || opts.only === a.id);
  const out = [];
  for (const a of accounts) {
    const chat = (a.whatsapp && a.whatsapp.name) || '';
    if (!chat) continue;
    // from his last statement, or the last fortnight if he has never had one
    const stmt = (a.statement && a.statement.date) || '';
    const since = stmt || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    let r;
    try { r = await runReader(chat, since); }
    catch (e) { out.push({ id: a.id, chat, error: String(e.message || e).slice(0, 140) }); continue; }
    const msgs = (r.messages || []).filter(m => m.date > since || (m.date === since));
    // which of his messages no line on the hub accounts for yet — matched on the day, loosely
    const rows = (await ws.collection('accounts').doc(a.id).collection('tx')
      .where('date', '>=', since).select('date', 'src', 'waAccepted', 'excluded').get()).docs.map(d => d.data());
    const daysWithRows = new Set(rows.filter(t => t.src === 'whatsapp').map(t => t.date));
    const said = msgs.filter(m => !m.fromMe && (m.text || m.type === 'image'));
    const unseen = said.filter(m => !daysWithRows.has(m.date));
    const scan = {
      at: new Date().toISOString(), chat, since,
      messages: msgs.length, fromHim: said.length,
      newMessages: unseen.length,                 // days he wrote about that no hub line covers
      lastMessage: msgs.length ? msgs[msgs.length - 1].date : '',
      loadedBackTo: r.loadedBackTo || '',
    };
    await a.ref.set({ waScan: scan }, { merge: true });
    out.push({ id: a.id, ...scan });
  }
  return { read: out.filter(x => !x.error).length, groups: out };
}

module.exports = { summary, draft, isWorker, odooAt, scanGroups };
