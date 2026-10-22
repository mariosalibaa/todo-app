// /tohme — Villa Tohme, "The House of Christmas (Tohme)" (DeyeCloud station 61475496, 40.7 kWp, installed by Shift,
// first reading Apr 2025) in kWh per day: solar, the grid port (EDL), the generator port, load, battery.
// Same recipe as the Taan plant (mahab.js) and CPR: deye-calc.integrate over the 5-min Power Profile, same DeyeCloud
// account and token (deye.token).
//
// Days come from three places, first match wins:
//   tohme-history.json   built once (tmp/energy-hub/tohme-history-build.js) — first reading → its `last`
//   Firestore energyTohme/<day>   later days, written by the nightly cron (/api/cron/deye) or a page load
//   today                read live, kept 10 min in memory

const D = require('./deye-calc');
const deye = require('./deye');
const HISTORY = require('./tohme-history.json');
const B = require('./tohme-batt');   // the second-rack case: battery full at, solar thrown, what a 60 kWh rack would have replaced
const MP = require('./tohme-mppt');   // the three panel series (PV1-3) in kWh/kWp — DeyeCloud keeps them ~90 days, so each day is kept here
const MPPT_SEED = require('./tohme-mppt.json').days;

const STATION = 61475496;
const FIELDS = HISTORY.fields;   // ['pv', 'gen', 'genOut', 'gridIn', 'gridOut', 'use', 'charge', 'discharge', 'n']
const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('energyTohme');

const T = require('./plant-today');

async function fetchRecs(ctx, ymd) {
  try { return await D.dayRecords(await deye.token(ctx), ymd, STATION); }
  catch (e) {
    if (!/401|500/.test(e.message) || !(process.env.DEYE_USER && process.env.DEYE_PASS)) throw e;
    return D.dayRecords(await deye.token(ctx, true), ymd, STATION);
  }
}
const fetchDay = async (ctx, ymd) => D.integrate(await fetchRecs(ctx, ymd));

// the 5-min series of one day, kept 10 min (the chart on the page, and the night of the day before)
const recsCache = new Map();
async function recs(ctx, ymd) {
  const c = recsCache.get(ymd);
  if (c && Date.now() - c.at < 10 * 60000) return c.recs;
  const r = await fetchRecs(ctx, ymd);
  recsCache.set(ymd, { at: Date.now(), recs: r });
  return r;
}

// missing days after the history (or short ones from the last 3 days — Deye uploads late), at most `max` per call
async function fill(ctx, max) {
  const yesterday = addDays(beirutToday(), -1);
  const have = {};
  (await col(ctx).where('day', '>', HISTORY.last).get()).forEach(d => { have[d.id] = d.data(); });
  const todo = [];
  for (let d = addDays(HISTORY.last, 1); d <= yesterday; d = addDays(d, 1)) {
    const h = have[d];
    // a stored day is final once it was written after noon of the day after (Deye's late uploads are in, the night
    // after has had its sunrise); before that it is read again, at most once an hour. (Was: n < 280 or no nightDone —
    // a day the battery never filled has no nightDone, so every page load re-read the last 3 days: ~10 s a load.)
    if (!h) todo.push(d);
    else if (!(h.at >= addDays(d, 1) + 'T09:00:00Z') && !(Date.now() - Date.parse(h.at) < 3600e3)) todo.push(d);
  }
  const done = [];
  for (const d of todo.slice(0, max)) {
    const r = await recs(ctx, d);
    await sleep(1100);
    const v = D.integrate(r);
    const next = await recs(ctx, addDays(d, 1));   // the night after: generator + grid until the next sunrise
    v.batt = B.analyze(r, next);
    try { const m = await MP.day(await deye.token(ctx), d); if (m) v.mppt = m; } catch (e) { console.error('tohme mppt', d, e.message); }
    await col(ctx).doc(d).set({ day: d, ...v, at: new Date().toISOString() });
    have[d] = v; done.push(d);
    await sleep(1100);
  }
  return { have, done, left: Math.max(0, todo.length - done.length) };
}

// live = false: Firestore only, today as last kept (plant-today.js); live = true: the page's second call (2026-10-22)
async function days(ctx, { live = false } = {}) {
  const out = { station: STATION, kwp: 40.71, fields: FIELDS, days: HISTORY.days.slice(), data: HISTORY.data.slice(), error: null, left: 0,
    batt: { ...(HISTORY.batt || {}) }, mppt: { ...MPPT_SEED }, series: { panels: MP.PANELS, panelW: MP.PANEL_W, kwp: MP.KWP }, rack: { kwh: B.RACK_KWH, usable: B.USABLE, extra: B.EXTRA_KWH, from: HISTORY.battFrom || null } };
  try {
    const today = beirutToday();
    const [f, td] = await Promise.all([fill(ctx, live ? 8 : 0), T.today(ctx, 'tohme', today, async () => { const r = await recs(ctx, today); return { v: D.integrate(r), batt: B.analyze(r, []) }; }, { live })]);
    out.left = f.left; out.stale = td.stale || f.left > 0; out.todayAt = new Date(td.at).toISOString();
    for (let d = addDays(HISTORY.last, 1); d < today; d = addDays(d, 1)) { const v = f.have[d]; out.days.push(d); out.data.push(v ? FIELDS.map(k => v[k]) : null); if (v && v.batt) out.batt[d] = v.batt; if (v && v.mppt) out.mppt[d] = v.mppt; }
    out.days.push(today); out.data.push(FIELDS.map(k => td.v.v[k])); out.batt[today] = td.v.batt;
    out.today = today;
  } catch (e) {
    out.error = String(e.message || e);
    console.error('tohme:', out.error);
  }
  return out;
}

// one day for the chart: the 5-min series (kW, %), the analysis and the clear-sky curve
async function day(ctx, ymd) {
  const r = await recs(ctx, ymd);
  const a = B.analyze(r, []);
  return { day: ymd, batt: a, pot: a.A ? B.potential(r, a.A) : null,
    t: r.map(x => x.dateTime), hhmm: r.map(x => B.beirut(x.dateTime)),
    pv: r.map(x => (+x.pvPower || 0) / 1000), use: r.map(x => (+x.usePower || 0) / 1000), bat: r.map(x => (+x.batteryPower || 0) / 1000),
    soc: r.map(x => +x.batterySoc || 0), gen: r.map(x => (+x.generatorPower || 0) / 1000), grid: r.map(x => (+x.wirePower || 0) / 1000) };
}

module.exports = { days, fill, day, STATION };
