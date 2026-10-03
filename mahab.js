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
  try { out.meters = (await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabMeters').get()).docs.map(d => d.data()).sort((a, b) => a.at < b.at ? -1 : 1); }
  catch (e) { out.meters = []; console.error('mahab meters:', e.message); }
  return out;
}

module.exports = { days, fill, STATION };
