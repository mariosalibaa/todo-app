// The battery study of a plant — Tohme's second-rack method (tohme-batt.js) for any DeyeCloud station (Mario
// 2026-10-22, McKinsey: "same as we did for tohme — check the solar thrown, and what additional battery bring; here we
// have 100 kW with 120 kWh batt instead of 50 kW with 60 kWh, the idea is to check what adding 120 kWh batt bring").
//
// One Firestore doc per day, plantStudy/<key>_<day>, from the station's 5-min Power Profile (deye-calc.dayRecords):
//   pv, gen, use, n         kWh and readings, like the Tohme page
//   kwp                     installed kWp DeyeCloud had that day (pvPower ÷ generationCapacity) — the plant grew
//   socMin, socMax          %
//   fullAt, clipTo, thrown  the window the battery sat full in daylight and the solar the inverters held back in it
//                           (clear-sky curve fitted on the same day's readings before the battery filled — tohme-batt)
//   genBefore, genAfter     generator + grid kWh in before that window and after it (whole day = genBefore when the
//                           battery never filled)
// The page runs the extra battery through the days in order (it carries charge from one day to the next): it takes
// the solar thrown, up to its usable kWh, and gives it back in place of the generator. Size and prices are set on the page.
// A future plant = one line in STUDIES. Read-only: nothing here writes to an inverter.

const D = require('./deye-calc');
const deye = require('./deye');
const B = require('./tohme-batt');

const STUDIES = {
  mckinsey: { station: 61438093, from: '2025-08-01', battKwh: 120, invKw: 100, extraKwh: 120, usable: 0.9 },   // pvPower is logged from Aug 2025
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('plantStudy');
const r1 = x => Math.round(x * 10) / 10;

async function recs(ctx, station, ymd) {
  try { return await D.dayRecords(await deye.token(ctx), ymd, station); }
  catch (e) {
    if (!/401|500/.test(e.message) || !(process.env.DEYE_USER && process.env.DEYE_PASS)) throw e;
    return D.dayRecords(await deye.token(ctx, true), ymd, station);
  }
}

function dayOf(r) {
  const v = D.integrate(r);
  const out = { pv: r1(v.pv), gen: r1(v.gen + v.gridIn), use: r1(v.use), n: v.n, kwp: null, socMin: null, socMax: null, fullAt: null, clipTo: null, thrown: 0, genBefore: 0, genAfter: 0 };
  if (!r.length) return out;
  const caps = r.filter(x => +x.generationCapacity > 0.05 && +x.pvPower > 0).map(x => +x.pvPower / +x.generationCapacity / 1000).sort((a, b) => a - b);
  if (caps.length) out.kwp = Math.round(caps[caps.length >> 1]);
  const soc = r.map(x => +x.batterySoc || 0).filter(x => x > 0);
  if (soc.length) { out.socMin = Math.min(...soc); out.socMax = Math.max(...soc); }
  const a = B.analyze(r, []);
  out.fullAt = a.fullAt; out.clipTo = a.clipTo; out.thrown = a.thrown || 0;
  const iFull = a.fullAt ? a.iFull : r.length, iEnd = a.fullAt ? a.iEnd : r.length;
  r.forEach((x, i) => {
    const dt = Math.min(600, (r[i + 1] ? r[i + 1].dateTime : x.dateTime + 300) - x.dateTime) / 3600;
    const kin = (Math.max(0, +x.generatorPower || 0) + Math.max(0, +x.wirePower || 0)) / 1000 * dt;
    if (i < iFull) out.genBefore += kin; else if (i > iEnd) out.genAfter += kin;
  });
  out.genBefore = r1(out.genBefore); out.genAfter = r1(out.genAfter);
  return out;
}

// finished days not stored yet (or stored before noon of the day after — Deye uploads late), at most `max` per call
async function fill(ctx, key, max) {
  const cfg = STUDIES[key], have = {}, yesterday = addDays(beirutToday(), -1);
  (await col(ctx).where('key', '==', key).get()).forEach(x => { have[x.data().day] = x.data(); });
  const todo = [];
  for (let d = cfg.from; d <= yesterday; d = addDays(d, 1)) {
    const h = have[d];
    if (!h) todo.push(d);
    else if (!(h.at >= addDays(d, 1) + 'T09:00:00Z') && !(Date.now() - Date.parse(h.at) < 3600e3)) todo.push(d);
  }
  const done = [];
  let error = null;
  for (const d of todo.slice(0, max)) {
    let r; try { r = await recs(ctx, cfg.station, d); } catch (e) { error = d + ': ' + e.message; console.error('plant-study', key, error); break; }   // the rest on the next call
    const v = dayOf(r);
    have[d] = { key, day: d, ...v, at: new Date().toISOString() };
    await col(ctx).doc(`${key}_${d}`).set(have[d]);
    done.push(d);
    await sleep(1100);
  }
  return { have, done, left: Math.max(0, todo.length - done.length), error };
}

// the page: every stored day (no cloud read unless `live`, then a few missing days)
async function study(ctx, key, { live = false } = {}) {
  const cfg = STUDIES[key]; if (!cfg) throw new Error('unknown plant');
  const f = await fill(ctx, key, live ? 4 : 0);
  const days = Object.values(f.have).filter(x => x.day >= cfg.from).sort((a, b) => a.day < b.day ? -1 : 1)
    .map(({ key: _k, at: _a, ...x }) => x);
  return { key, ...cfg, days, left: f.left };
}

module.exports = { STUDIES, fill, study, dayOf };
