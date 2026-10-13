// Villa Tohme — what a second battery rack would have done, day by day, from the 5-minute Power Profile.
//
// The case (Mario 2026-10-13): one 60 kWh rack (12 × 5 kWh) fills from solar by early afternoon; from then on the
// inverter throttles the panels down to the load — the DeyeCloud chart shows PV dropping onto Consumption while SOC
// sits at 100 % — and in the evening the generator / EDL carry the house. A second 60 kWh rack (90 % usable = 54 kWh)
// would have taken that thrown solar and replaced that much of the night's generator + grid.
//
// Per day:
//   fullAt     first reading with SOC ≥ 99 % while the panels produce (hh:mm Beirut) — null = the battery never filled
//   clipFrom/To  the window the battery stayed full in daylight (SOC ≥ 99 %, PV > 0)
//   pvPot      what the panels could have given in that window: a clear-sky curve for Beirut on that date
//              (sin of the sun's elevation), scaled to the SAME day's readings in the 90 min before the battery
//              was full — a cloudy day gives a lower curve, nothing is guessed from the weather
//   thrown     Σ max(0, pvPot − pv) × 5 min over the window, kWh
//   store      min(thrown, usable kWh of the extra rack)
//   night      generator + grid import from the end of the window to the next day's first solar, kWh
//   replaced   min(store, night) — what the extra rack would actually have displaced
//   fitN       how many readings the clear-sky curve was fitted on (< 12 = thin, fullAt came very early)

const LAT = 33.95 * Math.PI / 180, LON = 35.55;   // Villa Tohme, Lebanon (sun maths only)
const RACK_KWH = 60, USABLE = 0.9;
const EXTRA_KWH = RACK_KWH * USABLE;   // 54 kWh

// sun elevation (radians) at a UTC epoch second — NOAA's simplified formulas, good to ~1°
function elevation(sec) {
  const d = new Date(sec * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (d - start) / 864e5;
  const g = 2 * Math.PI / 365 * (doy - 1 + (d.getUTCHours() - 12) / 24);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));   // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const solarMin = utcMin + 4 * LON + eot;
  const ha = (solarMin / 4 - 180) * Math.PI / 180;
  return Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(ha));
}
const shape = sec => Math.max(0, Math.sin(elevation(sec)));

// Beirut clock for a UTC epoch second (summer +3, winter +2 — Lebanon's DST rule: last Sunday of March → last Sunday of October)
function beirut(sec) {
  const d = new Date(sec * 1000), y = d.getUTCFullYear();
  const lastSun = m => { const t = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, t.getUTCDate() - t.getUTCDay()); };
  const dst = d >= lastSun(2) && d < lastSun(9);
  const l = new Date(sec * 1000 + (dst ? 3 : 2) * 3600e3);
  return `${String(l.getUTCHours()).padStart(2, '0')}:${String(l.getUTCMinutes()).padStart(2, '0')}`;
}

// recs = the day's 5-min records (deye-calc.dayRecords), next = the following day's (for the night), may be []
function analyze(recs, next) {
  const out = { fullAt: null, clipFrom: null, clipTo: null, pvPot: 0, thrown: 0, store: 0, night: null, replaced: null, fitN: 0, socMax: 0, pvPeak: 0 };
  if (!recs.length) return out;
  const pv = r => Math.max(0, +r.pvPower || 0) / 1000, soc = r => +r.batterySoc || 0, bat = r => (+r.batteryPower || 0) / 1000;
  const inKW = r => Math.max(0, +r.generatorPower || 0) / 1000 + Math.max(0, +r.wirePower || 0) / 1000;
  const dt = 5 / 60;   // h — the series is one reading per 5 min; a gap contributes nothing (same rule as deye-calc)
  out.socMax = Math.max(...recs.map(soc)); out.pvPeak = Math.round(Math.max(...recs.map(pv)) * 10) / 10;
  let iFull = -1;
  for (let i = 0; i < recs.length; i++) if (soc(recs[i]) >= 99 && pv(recs[i]) > 0.2) { iFull = i; break; }
  if (iFull < 0) return out;
  out.fullAt = beirut(recs[iFull].dateTime);
  // the clear-sky curve, scaled to what the panels were giving just before the battery filled: 75th percentile of
  // pv / shape over the 90 min before full (sun ≥ 12°, battery charging), carried along the sun's curve. Earlier
  // morning readings are not used — on this roof the morning is low (orientation / shade) and would understate it.
  // Fewer than 6 such readings → the whole morning's median.
  const ratio = (from, to) => { const r = []; for (let i = from; i < to; i++) { const x = recs[i], s = shape(x.dateTime); if (elevation(x.dateTime) > 12 * Math.PI / 180 && bat(x) < -0.5 && pv(x) > 0.5) r.push(pv(x) / s); } return r.sort((a, b) => a - b); };
  const tFull = recs[iFull].dateTime;
  let iFrom = iFull; while (iFrom > 0 && tFull - recs[iFrom - 1].dateTime <= 90 * 60) iFrom--;
  let ratios = ratio(iFrom, iFull), q = 0.75;
  if (ratios.length < 6) { ratios = ratio(0, iFull); q = 0.5; }
  out.fitN = ratios.length;
  const A = ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * q))] : 0;
  // the window: full, in daylight — ends at the first reading where the battery is clearly discharging or the sun is down
  let iEnd = iFull;
  for (let i = iFull; i < recs.length; i++) { const r = recs[i]; if (soc(r) < 97 || (bat(r) > 0.5 && pv(r) < 0.3) || elevation(r.dateTime) <= 0) break; iEnd = i; }
  out.clipFrom = out.fullAt; out.clipTo = beirut(recs[iEnd].dateTime);
  let pot = 0, thrown = 0;
  for (let i = iFull; i <= iEnd; i++) { const r = recs[i]; if (soc(r) < 97) continue; const p = A * shape(r.dateTime); pot += p * dt; thrown += Math.max(0, p - pv(r)) * dt; }
  out.pvPot = Math.round(pot * 10) / 10; out.thrown = Math.round(thrown * 10) / 10; out.A = Math.round(A * 100) / 100; out.iFull = iFull; out.iEnd = iEnd;
  out.store = Math.round(Math.min(thrown, EXTRA_KWH) * 10) / 10;
  // the night: from the end of the window to the next day's first solar — generator + grid import
  if (next && next.length) {
    let n = 0;
    for (let i = iEnd + 1; i < recs.length; i++) n += inKW(recs[i]) * dt;
    for (const r of next) { if (pv(r) > 0.2) break; n += inKW(r) * dt; }
    out.night = Math.round(n * 10) / 10;
    out.replaced = Math.round(Math.min(out.store, n) * 10) / 10;
    out.nightDone = next.some(r => pv(r) > 0.2);   // false = the next day's series had no sunrise yet → read again tomorrow
  }
  return out;
}

// the clear-sky curve for a day's records, kW per record (for the chart)
const potential = (recs, A) => recs.map(r => Math.round(A * shape(r.dateTime) * 100) / 100);

module.exports = { analyze, potential, elevation, beirut, RACK_KWH, USABLE, EXTRA_KWH };
