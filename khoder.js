// /khoder — Khoder's days shared with Walid Hibri (Mario 2026-10-06: "put data here to share with Walid — on each day the
// money paid by each one, the total amount paid and the total transportation"). Khoder works for Shift and for Walid
// the same days; this page puts the two timelines side by side so neither pays the same hour twice.
//   Shift: his day lines on the hub (khodr-cash, nature labour — "08:49–13:13 · 4.4 h"), hours × 25/9 $ + transport
//          ($5 a full day, prorated under 9 h — what the hub's day line already holds).
//   Walid: his "Work Hours Summary" messages on WhatsApp, kept in Firestore meta/khoderWalid { days: { date: {from,to,min} },
//          rate, transport } by the laptop (whatsapp-local) — hours × $2.78 + $5 a day.
// Read-only. A hub admin sees it signed in; Walid opens it with the share link (?k=, an HMAC of the machine key).
const crypto = require('crypto');
const ACC = 'khodr-cash';
const RATE = 25 / 9;
const money = n => Math.round(n * 100) / 100;
const shareKey = () => crypto.createHmac('sha256', process.env.ACCOUNTING_API_KEY || 'x').update('khoder-walid').digest('hex').slice(0, 20);

async function data(ctx) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const meta = (await ws.collection('meta').doc('khoderWalid').get()).data() || {};
  const from = meta.from || '2026-09-28', to = meta.to || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const tx = (await ws.collection('accounts').doc(ACC).collection('tx').where('date', '>=', from).where('date', '<=', to).get()).docs.map(d => d.data())
    .filter(t => !t.excluded && t.nature === 'labour' && t.debit > 0);
  const days = {};
  const day = d => (days[d] = days[d] || { date: d, shift: null, walid: null });
  for (const t of tx) {
    const m = /(\d{1,2}:\d{2})\s*[–→-]+\s*(\d{1,2}:\d{2})/.exec(t.description || '');
    const hours = +t.hours || +((/([\d.]+)\s*h\b/.exec(t.description || '') || [])[1]) || 0;
    const labour = money(hours * RATE), total = money(t.debit);
    const d = day(t.date);
    d.shift = { from: m ? m[1] : '', to: m ? m[2] : '', hours: money(hours), labour, transport: money(Math.max(0, total - labour)), total, project: t.analyticName || '' };
  }
  const wRate = +meta.rate || 2.78, wTr = meta.transport != null ? +meta.transport : 5;
  for (const [date, w] of Object.entries(meta.days || {})) {
    if (date < from || date > to) continue;
    const hours = (+w.min || 0) / 60;
    day(date).walid = { from: w.from || '', to: w.to || '', hours: money(hours), labour: money(hours * wRate), transport: wTr, total: money(hours * wRate + wTr) };
  }
  const list = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  const sum = (k, f) => money(list.reduce((s, d) => s + (d[k] ? d[k][f] : 0), 0));
  const totals = {};
  for (const k of ['shift', 'walid']) totals[k] = { days: list.filter(d => d[k]).length, hours: sum(k, 'hours'), labour: sum(k, 'labour'), transport: sum(k, 'transport'), total: sum(k, 'total') };
  // Walid's own way: the total minutes × his rate (26 h 10 × 2.78 = 72.74), not the sum of rounded days
  const wMin = Object.entries(meta.days || {}).filter(([d]) => d >= from && d <= to).reduce((n, [, w]) => n + (+w.min || 0), 0);
  totals.walid.labour = money(wMin / 60 * wRate); totals.walid.total = money(totals.walid.labour + totals.walid.transport);
  return { from, to, rate: { shift: money(RATE), walid: wRate, walidTransport: wTr }, days: list, totals, note: meta.note || '' };
}

module.exports = { data, shareKey };
