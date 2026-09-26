// Energy — kWh per building per day from cumulative meter counters (Metrel ME437 "EPImp" / "EPSum").
// Shared by energy.js (the hub route, live from openHAB Cloud) and energy-history-build.js (the one-off
// history built from openHAB + the meters' own SD-card logs in D:\cpr loggers meatrol).
//
// A building is a list of SEGMENTS. A segment is one physical counter over a period: consumption is only
// ever the rise of one counter inside its own segment, so a meter swap (a new counter with another base)
// never shows up as consumption. Between two readings the counter is interpolated linearly, so a logger
// outage spreads what the meter counted meanwhile over the days it was offline — those days are flagged
// "estimated" (two readings around or inside the day are more than GAP_MS apart).

const GAP_MS = 6 * 3600e3;
const TZ = 'Asia/Beirut';

// Beirut's offset from UTC at instant t (ms) — +2 h in winter, +3 h in summer
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function tzOffset(t) {
  const p = {}; for (const x of _fmt.formatToParts(new Date(t))) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
// UTC ms of Beirut midnight starting yyyy-mm-dd
function dayStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d);
  return naive - tzOffset(naive - tzOffset(naive - 3 * 3600e3));
}
const nextDay = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
// Beirut calendar day of instant t
const dayOf = t => new Date(t + tzOffset(t)).toISOString().slice(0, 10);

// points: [[utcMs, kWh], …] from any number of sources for ONE counter → sorted, de-duplicated, never falling
// (a reading below the running maximum is a read error or a stale value and is dropped)
function cleanPoints(points, from, to) {
  const s = points.filter(p => p[0] >= from && p[0] <= to && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of s) {
    if (out.length && p[1] < out[out.length - 1][1]) continue;
    if (out.length && p[0] - out[out.length - 1][0] < 60e3) { out[out.length - 1] = p; continue; }
    out.push(p);
  }
  return out;
}

// counter at instant t (linear between the two readings around it); null = outside the data
function valueAt(pts, t) {
  if (!pts.length || t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  return b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
}
// any two consecutive readings spanning part of [a, b] more than GAP_MS apart, with the counter moving between
// them? (across a gap where it did not move, the interpolation is exact: nothing was counted)
function gapIn(pts, a, b) {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= a) continue;
    if (pts[i - 1][0] >= b) break;
    if (pts[i][0] - pts[i - 1][0] > GAP_MS && pts[i][1] > pts[i - 1][1]) return true;
  }
  return false;
}

// segments: [{ pts (cleaned), from, to }] → { 'yyyy-mm-dd': [kWh, est] | null } for every Beirut day in
// [firstDay, lastDay]. A day only partly inside the data counts the part it has (a meter's first day, today).
function daily(segments, firstDay, lastDay) {
  const out = {};
  for (let d = firstDay; d <= lastDay; d = nextDay(d)) {
    const t0 = dayStart(d), t1 = dayStart(nextDay(d));
    let kwh = null, est = false;
    for (const sg of segments) {
      if (!sg.pts.length) continue;
      const a = Math.max(t0, sg.from, sg.pts[0][0]), b = Math.min(t1, sg.to, sg.pts[sg.pts.length - 1][0]);
      if (b <= a) continue;
      kwh = (kwh || 0) + Math.max(0, valueAt(sg.pts, b) - valueAt(sg.pts, a));
      if (gapIn(sg.pts, a, b)) est = true;
    }
    out[d] = kwh == null ? null : [Math.round(kwh * 10) / 10, est ? 1 : 0];
  }
  return out;
}

// logger outages: stretches ≥ 12 h where School, Liqaa and Hotel (never idle) all repeat one value, ≥ 6 h in
// common. openHAB keeps writing the last value while the Pi is offline — those repeats are not readings.
const flatRuns = s => { const r = []; for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][1] === s[i][1]) j++; if (s[j][0] - s[i][0] >= 12 * 3600e3) r.push([s[i][0], s[j][0]]); i = j + 1; } return r; };
const overlap = (X, Y) => { const o = []; for (const a of X) for (const b of Y) { const s = Math.max(a[0], b[0]), e = Math.min(a[1], b[1]); if (e - s >= 6 * 3600e3) o.push([s, e]); } return o; };
const outages = (m1, m3, m4) => overlap(overlap(flatRuns(m1 || []), flatRuns(m3 || [])), flatRuns(m4 || []));
// a series without the stale repeats (the first reading of a run is real, the rest is not). openHAB keeps hourly
// AVERAGES, so the first hour or two back online still mixes the stale value in (15 Jul 2026 03:00 read 19,583 on a
// counter at 26,941) — those go too, else the whole outage lands in that one hour instead of across its days.
const STALE_TAIL = 2 * 3600e3;
const dropStale = (s, outs) => (s || []).filter(([t]) => !outs.some(([a, e]) => t > a && t <= e + STALE_TAIL));

// The eight meters as openHAB names them (Mario's pages "M1 School" … "M8 EDL") — order = table order.
// group: 'load' = a building, 'source' = where the power comes from (the generators, EDL).
const BUILDINGS = [
  { key: 'school', name: 'School', item: 'Meter1_EPImp', group: 'load' },
  { key: 'church', name: 'Church', item: 'Meter2_EPImp', group: 'load' },
  { key: 'liqaa', name: 'Liqaa', item: 'Meter3_EPImp', group: 'load' },
  { key: 'hotel', name: 'Hotel', item: 'Meter4_EPImp', group: 'load' },
  { key: 'genChurch', name: 'Generator church', item: 'Meter5_EPImp', group: 'source' },
  { key: 'genSmall', name: 'Generator small', item: 'Meter6_EPImp', group: 'source' },
  { key: 'genBig', name: 'Generator big', item: 'Meter7_EPImp', group: 'source' },
  { key: 'edl', name: 'EDL', item: 'Meter8_EPImp', group: 'source' },
];

module.exports = { GAP_MS, tzOffset, dayStart, nextDay, dayOf, cleanPoints, valueAt, gapIn, daily, outages, dropStale, BUILDINGS };
