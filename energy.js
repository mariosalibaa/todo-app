// Energy — kWh per building per month for the CPR site (School, Church, Liqaa, Hotel, the three generators, EDL).
// Mario, 2026-09-26: "a page on the hub showing me the consumption in kWh for each building, per month, table and chart".
// Mounted by server.js under /api/energy; admin only (gated in server.js).
//
//   GET /api/energy[?fresh=1]   { buildings, days, data: { key: [[kWh, est] | null, …] }, noMeter, notes, live… }
//
// Two halves glued at energy-history.json's last day:
//   • history — built once from openHAB + the meters' SD-card logs (energy-history-build.js, see the notes there:
//     meter swaps, logger outages, SD clocks 7.8 h fast). Never recomputed here.
//   • live — every day after it, read from openHAB Cloud (myopenhab.org REST, basic auth with Mario's openHAB
//     Cloud account: OPENHAB_USER / OPENHAB_PASS) and turned into days with the same rules (energy-calc.js).
// No credentials or openHAB down → the history alone, with the reason (liveError) for the page to show.
//
// deye: the inverter plant (DeyeCloud) per day — solar, generator input, EDL in / out, UPS load, battery (deye.js).
// Mario, 2026-09-26: "add the solar production … compare DeyeCloud EDL and generator with the meters".

const C = require('./energy-calc');
const deye = require('./deye');
const HISTORY = require('./energy-history.json');   // a static require, so Vercel bundles it

const OH_URL = (process.env.OPENHAB_URL || 'https://myopenhab.org').replace(/\/$/, '');
const CACHE_MS = 10 * 60000;
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
let cache = { at: 0, data: null, pending: null };

async function ohSeries(item, from, to = Date.now() + 3600e3) {
  const auth = 'Basic ' + Buffer.from(`${process.env.OPENHAB_USER}:${process.env.OPENHAB_PASS}`).toString('base64');
  const r = await fetch(`${OH_URL}/rest/persistence/items/${item}?starttime=${new Date(from).toISOString()}&endtime=${new Date(to).toISOString()}`,
    { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`openHAB ${r.status}${r.status === 401 ? ' (OPENHAB_USER / OPENHAB_PASS refused)' : ''}`);
  const j = await r.json();
  return (j.data || []).map(x => [+x.time, +x.state]).filter(p => Number.isFinite(p[1]));
}

async function liveDays() {
  if (!process.env.OPENHAB_USER || !process.env.OPENHAB_PASS) throw new Error('OPENHAB_USER / OPENHAB_PASS not set');
  const firstLive = C.nextDay(HISTORY.last), today = C.dayOf(Date.now());
  if (firstLive > today) return { days: [], data: {} };
  const from = C.dayStart(HISTORY.last) - 24 * 3600e3;   // a day of readings before, for the counter at the first midnight and the outage test
  const series = {};
  await Promise.all(C.BUILDINGS.map(async b => { series[b.item] = await ohSeries(b.item, from); }));
  const outs = C.outages(series.Meter1_EPImp, series.Meter3_EPImp, series.Meter4_EPImp);
  const days = []; for (let d = firstLive; d <= today; d = C.nextDay(d)) days.push(d);
  const data = {}, latest = {};
  for (const b of C.BUILDINGS) {
    const nm = HISTORY.noMeter && HISTORY.noMeter[b.key];
    const min = (HISTORY.live && HISTORY.live[b.key] && HISTORY.live[b.key].min) || -Infinity;
    const pts = C.cleanPoints(C.dropStale(series[b.item], outs).filter(p => p[1] >= min), from, Infinity);
    const dl = C.daily([{ from, to: Infinity, pts }], firstLive, today);
    data[b.key] = days.map(d => (nm && d >= nm ? null : dl[d]));
    const last = series[b.item][series[b.item].length - 1];
    if (last) latest[b.key] = { kwh: last[1], at: new Date(last[0]).toISOString() };
  }
  return { days, data, latest, outages: outs.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]) };
}

async function build(ctx) {
  const out = {
    buildings: C.BUILDINGS.map(({ key, name, group }) => ({ key, name, group })),
    days: HISTORY.days.slice(), data: {}, noMeter: HISTORY.noMeter, notes: HISTORY.notes,
    historyTo: HISTORY.last, historyBuiltAt: HISTORY.builtAt, bySource: HISTORY.bySource, histOutages: HISTORY.outages,   // the history days from the SD cards alone / openHAB alone (admin comparison)
     live: false, liveError: null, latest: {}, pulledAt: new Date().toISOString(),
  };
  for (const b of C.BUILDINGS) out.data[b.key] = HISTORY.data[b.key].slice();
  const deyeP = deye.days(ctx);   // alongside openHAB, not after it
  try {
    const lv = await liveDays();
    out.days.push(...lv.days);
    for (const b of C.BUILDINGS) out.data[b.key].push(...(lv.data[b.key] || []));
    out.latest = lv.latest || {}; out.live = true; out.liveOutages = lv.outages;
  } catch (e) {
    out.liveError = String(e.message || e);
    console.error('energy live:', out.liveError);
  }
  out.deye = { fields: deye.FIELDS, ...(await deyeP) };
  try { out.deye.racks = await deye.racks(ctx); } catch (e) { out.deye.racksError = String(e.message || e); }
  try { out.deye.live = await deye.live(ctx); } catch (e) { out.deye.liveError = String(e.message || e); }
  return out;
}

// The Charts tab's "one day" chart (Mario 2026-10-01: "develop the hub" instead of Grafana) — each meter's average kW
// per hour of one Beirut day = the rise of its kWh counter over that hour. openHAB only, the same cleaning as the
// days (stale repeats while the Pi was offline dropped); an hour the counter has no reading on both sides = null.
const dayCache = new Map();
async function meterDay(day) {
  if (!process.env.OPENHAB_USER || !process.env.OPENHAB_PASS) throw new Error('OPENHAB_USER / OPENHAB_PASS not set');
  const today = C.dayOf(Date.now()), hit = dayCache.get(day);
  if (hit && Date.now() - hit.at < (day < today ? 6 * 3600e3 : 5 * 60000)) return hit.data;
  const t0 = C.dayStart(day), t1 = Math.min(C.dayStart(C.nextDay(day)), Date.now());
  const from = t0 - 24 * 3600e3, to = C.dayStart(C.nextDay(day)) + 3 * 3600e3;   // a day before for the outage test, a little after for the last hour
  const series = {};
  await Promise.all(C.BUILDINGS.map(async b => { series[b.item] = await ohSeries(b.item, from, to); }));
  const outs = C.outages(series.Meter1_EPImp, series.Meter3_EPImp, series.Meter4_EPImp);
  const hours = []; for (let t = t0; t < t1; t += 3600e3) hours.push(t);
  const data = {};
  for (const b of C.BUILDINGS) {
    const pts = C.cleanPoints(C.dropStale(series[b.item], outs), from, to);
    data[b.key] = hours.map(t => { const a = C.valueAt(pts, t), z = C.valueAt(pts, Math.min(t + 3600e3, t1));
      return a == null || z == null ? null : Math.round(Math.max(0, z - a) * 3600e3 / (Math.min(t + 3600e3, t1) - t) * 100) / 100; });
  }
  const out = { day, hours: hours.map(t => new Date(t).toISOString()), data,
    outages: outs.filter(([s, e]) => e > t0 && s < t1).map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]) };
  dayCache.set(day, { at: Date.now(), data: out });
  if (dayCache.size > 60) dayCache.delete(dayCache.keys().next().value);
  return out;
}

async function handle(req, res, url, user, ctx) {
  const [p, qs] = url.split('?');
  if (p === '/api/energy' && req.method === 'GET') {
    const fresh = new URLSearchParams(qs || '').get('fresh') === '1' && Date.now() - cache.at > 60000;   // public page: a refresh at most once a minute
    if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return json(res, 200, { ...cache.data, cached: true });
    if (!cache.pending) cache.pending = build(ctx).then(d => { cache = { at: d.live ? Date.now() : Date.now() - CACHE_MS + 60000, data: d, pending: null }; return d; }, e => { cache.pending = null; throw e; });
    return json(res, 200, { ...(await cache.pending), cached: false });
  }
  return false;
}

module.exports = { handle, meterDay };
