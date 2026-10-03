// /mahab — the Taan / Machmouchi plant (Dr Nazih Taan & Dr Mahab Machmouchi, 25 kWp, DeyeCloud station 62112463)
// in kWh per day: solar, the grid port (EDL), the generator port, load, battery. Same recipe as the CPR plant
// (deye-calc.integrate over the 5-min Power Profile), same DeyeCloud account and token (deye.token).
//
// Days come from three places, first match wins:
//   mahab-history.json   built once (tmp/energy-hub/mahab-history-build.js) — first reading 2026-04-29 → its `last`
//   Firestore energyMahab/<day>   later days, written by the nightly cron (/api/cron/deye) or a page load
//   today                read live, kept 10 min in memory
//
// Wiring (site sketch "20260704 mahab gen control.pdf"): from 2 Jul 2026 EDL and the two generators reach the
// inverter through ATSs on ONE input, the generator port — so from then on the generator figure is EDL + generators
// together; DeyeCloud cannot tell them apart. Before that, EDL was on the grid port and there was no generator.

const D = require('./deye-calc');
const deye = require('./deye');
const HISTORY = require('./mahab-history.json');

const STATION = 62112463;
const FIELDS = HISTORY.fields;   // ['pv', 'gen', 'genOut', 'gridIn', 'gridOut', 'use', 'charge', 'discharge', 'n']
const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('energyMahab');

let todayCache = { at: 0, day: null, v: null };

async function fetchDay(ctx, ymd) {
  try { return D.integrate(await D.dayRecords(await deye.token(ctx), ymd, STATION)); }
  catch (e) {
    if (!/401|500/.test(e.message) || !(process.env.DEYE_USER && process.env.DEYE_PASS)) throw e;
    return D.integrate(await D.dayRecords(await deye.token(ctx, true), ymd, STATION));
  }
}

// missing days after the history (or short ones from the last 3 days — Deye uploads late), at most `max` per call
async function fill(ctx, max) {
  const yesterday = addDays(beirutToday(), -1);
  const have = {};
  (await col(ctx).where('day', '>', HISTORY.last).get()).forEach(d => { have[d.id] = d.data(); });
  const todo = [];
  for (let d = addDays(HISTORY.last, 1); d <= yesterday; d = addDays(d, 1)) {
    const h = have[d];
    if (!h || (h.n < 280 && d >= addDays(yesterday, -3))) todo.push(d);
  }
  const done = [];
  for (const d of todo.slice(0, max)) {
    const v = await fetchDay(ctx, d);
    await col(ctx).doc(d).set({ day: d, ...v, at: new Date().toISOString() });
    have[d] = v; done.push(d);
    await sleep(1100);
  }
  return { have, done, left: Math.max(0, todo.length - done.length) };
}

async function days(ctx) {
  const out = { station: STATION, atsFrom: '2026-07-02', fields: FIELDS, days: HISTORY.days.slice(), data: HISTORY.data.slice(), error: null, left: 0 };
  try {
    const f = await fill(ctx, 8);
    out.left = f.left;
    const today = beirutToday();
    for (let d = addDays(HISTORY.last, 1); d < today; d = addDays(d, 1)) { const v = f.have[d]; out.days.push(d); out.data.push(v ? FIELDS.map(k => v[k]) : null); }
    if (!(todayCache.day === today && Date.now() - todayCache.at < 10 * 60000)) todayCache = { at: Date.now(), day: today, v: await fetchDay(ctx, today) };
    out.days.push(today); out.data.push(FIELDS.map(k => todayCache.v[k]));
    out.today = today;
  } catch (e) {
    out.error = String(e.message || e);
    console.error('mahab:', out.error);
  }
  // site meter readings (Mario 2026-10-03: "record the meters reading … gen1, gen2, EDL, sum of all 3") — Firestore
  // mahabMeters/<yyyy-mm-dd_hhmm>, Beirut time, photos in Dropbox "00. PARTNER\mahab machmouche\meter readings"
  try { out.meters = await meters(ctx); }
  catch (e) { out.meters = []; console.error('mahab meters:', e.message); }
  return out;
}

// Mario's check (2026-10-03): what the three site meters (Gen 1 + Gen 2 + EDL) advance between two readings must
// equal DeyeCloud's grid import + export over exactly that time (2 Oct 09:31 → 14:15: meters 41, Deye 41.7).
// Each reading after the first gets that window integrated from the 5-min series and kept on its doc (`deye`), so
// it is read from DeyeCloud once. Windows over 31 days are skipped (too many day reads for one page load).
const toSec = at => new Date(at.replace(' ', 'T') + ':00+03:00').getTime() / 1000;
async function meters(ctx) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabMeters');
  const docs = (await ref.get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.at < b.at ? -1 : 1);
  for (let i = 1; i < docs.length; i++) {
    const p = docs[i - 1], m = docs[i];
    if (m.deye && m.deye.from === p.at) continue;
    const a = toSec(p.at), b = toSec(m.at);
    if (b > Date.now() / 1000 - 600 || b - a > 31 * 86400) continue;   // Deye uploads late: wait 10 min after the reading
    const recs = [];
    for (let d = p.at.slice(0, 10); d <= m.at.slice(0, 10); d = addDays(d, 1)) {
      recs.push(...await D.dayRecords(await deye.token(ctx), d, STATION));
      await sleep(1100);
    }
    const v = D.integrate(recs.filter(r => r.dateTime >= a && r.dateTime < b));
    m.deye = { from: p.at, gridIn: v.gridIn, gridOut: v.gridOut, gen: v.gen, genOut: v.genOut, n: v.n };
    await ref.doc(m.id).set({ deye: m.deye }, { merge: true });
  }
  return docs;
}

module.exports = { days, fill, STATION };
