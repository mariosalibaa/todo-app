// /makhlouf — the power logger on the Maison M Naccache (Makhlouf) generator, 300–600 kVA MTS.
// Logger 3322205001 (3-phase, CS meter + SD card), moved there from Mario's house on 2 Oct 2026, 06:00–07:00.
// Rebuild after reading a new SD card:   node makhlouf-build.js "C:\path\to\folder with DataSheet_3322205001_3P4W.csv"
// → makhlouf-data.json (committed, served by /api/makhlouf). Logger clock = Beirut time.
//
// The card had a recording fault from 29 Jun until it was reinstalled on 3 Oct 18:40 (it wrote a few rows after a
// power-up, then stopped). Mario 2026-10-04: disregard everything from his house — the page starts at the first clean
// Makhlouf row (START); energy = the meter's counters minus their value at START (they keep counting through a card
// gap), peaks = the highest one-minute reading on the card since START.
// Logger off (no rows > 3 min) = the generator was off — the logger sits on the generator only, so the site was most
// likely on EDL. Mario 2026-10-04: estimate those periods — a straight line from the load 10–40 min before the
// shutdown ramp to the load 5–35 min after the restart (OFF[]).
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('usage: node makhlouf-build.js <folder with DataSheet_3322205001_3P4W.csv>'); process.exit(1); }
const file = fs.readdirSync(dir).find(f => /^DataSheet_.*\.csv$/i.test(f));
const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
const head = lines[2].split(',');
const ix = {}; head.forEach((k, i) => { if (!(k in ix)) ix[k] = i; });

const INSTALL = '2026-10-02 06:30';   // Mario: moved on 2 Oct between 06:00 and 07:00
const START = '2026-10-03 18:40';     // first clean Makhlouf row after the card reinstall
const COLS = ['UA', 'UB', 'UC', 'IA', 'IB', 'IC', 'IN', 'PA', 'PB', 'PC', 'PSum', 'PFAvg', 'FAvg', 'UTHAvg', 'ITHAvg', 'EPSum', 'PFA', 'PFB', 'PFC', 'UTHA', 'UTHB', 'UTHC', 'ITHA', 'ITHB', 'ITHC', 'QSum', 'SSum'];

const rows = [], ups = [];   // ups = power-up rows (the logger lost power just before)
let last = null, first = null;
for (const l of lines.slice(3)) {
  const r = l.split(',');
  if (!/^\d{4}-\d\d-\d\d$/.test(r[0])) continue;
  const at = r[0] + ' ' + r[1].slice(0, 5);
  last = r;
  if (at < START) continue;
  if (+r[ix.UA] === 0 && +r[ix.UB] === 0 && +r[ix.UC] === 0) { if (rows.length) ups.push({ at: r[0] + ' ' + r[1], i: rows.length }); continue; }   // the power-up row (all zeros)
  if (!first) first = r;
  rows.push([r[0] + ' ' + r[1], ...COLS.map(k => +r[ix[k]])]);
}
const n = k => +last[ix[k]];
const cnt = r => ({ at: r[0] + ' ' + r[1], epa: +r[ix.EPA], epb: +r[ix.EPB], epc: +r[ix.EPC], epsum: +r[ix.EPSum] });
const top = (k, div = 1000, key = 'kw') => { let m = null; for (const r of rows) if (!m || r[1 + COLS.indexOf(k)] > m[1 + COLS.indexOf(k)]) m = r; return m ? { [key]: m[1 + COLS.indexOf(k)] / div, at: m[0] } : null; };
// logger-off periods since START, with an estimated load across each
const sec = s => Date.parse(s.replace(' ', 'T').slice(0, 19) + '+03:00') / 1000;
const avg = (a, b) => { const v = rows.filter(r => sec(r[0]) >= a && sec(r[0]) < b).map(r => r[1 + COLS.indexOf('PSum')] / 1000); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const OFF = [];
for (let i = 1; i < rows.length; i++) {
  const a = sec(rows[i - 1][0]), b = sec(rows[i][0]);
  if (b - a <= 180) continue;
  const k0 = avg(a - 2400, a - 600), k1 = avg(b + 300, b + 2100);
  const kw0 = k0 ?? k1 ?? 0, kw1 = k1 ?? k0 ?? 0, min = (b - a) / 60 - 1;
  // minute-by-minute estimate (Mario 2026-10-04 "estimate the missing data"): the straight line, plus the minute-to-minute
  // swings of the real load just before the shutdown (detrended, so they add no energy) — it reads like the load it replaces
  const n = Math.max(Math.round(min), 0), src = rows.filter(r => sec(r[0]) >= a - 600 - n * 60 && sec(r[0]) < a - 600).map(r => r[1 + COLS.indexOf('PSum')] / 1000);
  const aft = rows.filter(r => sec(r[0]) > b + 300 && sec(r[0]) <= b + 300 + n * 60).map(r => r[1 + COLS.indexOf('PSum')] / 1000);
  const base = src.length >= 30 ? src : aft, m = base.length;
  let res = [];
  if (m >= 10) { const xm = (m - 1) / 2, ym = base.reduce((x, y) => x + y, 0) / m; let sxy = 0, sxx = 0; base.forEach((y, k) => { sxy += (k - xm) * (y - ym); sxx += (k - xm) ** 2; });
    const sl = sxy / sxx; res = base.map((y, k) => y - (ym + sl * (k - xm))); }
  const est = Array.from({ length: n }, (_, k) => +Math.max(0, kw0 + (kw1 - kw0) * (k + 1) / (n + 1) + (res.length ? res[k % res.length] : 0)).toFixed(1));
  OFF.push({ from: rows[i - 1][0], to: rows[i][0], min: n, kw0: +kw0.toFixed(1), kw1: +kw1.toFixed(1), kwh: +(est.reduce((x, y) => x + y, 0) / 60).toFixed(1), est });
}
// Every logger power cut since START, classified (Mario 2026-10-04): a cut of a few minutes is the manual MTS swapping
// generators; an hour or more is the ATS on EDL. The generator is told apart by its voltage: G1 (350 kVA) runs at
// ≈ 231–238 V, G2 (600 kVA) at ≈ 222–229 V — so a swap shows as a voltage step across the cut.
const G_SPLIT = 229.5, vAvg = r => (r[1 + COLS.indexOf('UA')] + r[1 + COLS.indexOf('UB')] + r[1 + COLS.indexOf('UC')]) / 3;
const genOf = r => vAvg(r) >= G_SPLIT ? 'G1' : 'G2';
const avgV = (from, to) => { const v = rows.slice(Math.max(from, 0), Math.min(to, rows.length)).map(vAvg); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const CUTS = ups.map(u => {
  const before = rows[u.i - 1], after = rows[u.i], min = (sec(after[0]) - sec(before[0])) / 60 - 1;
  const vb = avgV(u.i - 5, u.i), va = avgV(u.i, u.i + 5), gb = vb >= G_SPLIT ? 'G1' : 'G2', ga = va >= G_SPLIT ? 'G1' : 'G2';
  return { from: before[0], to: after[0], min: +Math.max(min, 0).toFixed(1), vBefore: +vb.toFixed(1), vAfter: +va.toFixed(1), genBefore: gb, genAfter: ga,
    kind: min >= 30 ? 'edl' : gb !== ga ? 'swap' : 'blip' };
});
OFF.forEach(o => { const c = CUTS.find(c => c.from === o.from); o.kind = c ? c.kind : (o.min >= 30 ? 'edl' : 'blip');
  if (o.kind !== 'edl') { o.est = []; o.kwh = 0; } });   // a swap or blip: the site had no supply for those minutes — nothing to estimate
const out = {
  built: new Date().toISOString(), file, serial: (lines[0].split(':')[1] || '').trim(), install: INSTALL,
  cols: ['at', ...COLS], rows,
  start: cnt(first), counters: cnt(last),
  peak: { sum: top('PSum'), a: top('PA'), b: top('PB'), c: top('PC') },
  peakA: { a: top('IA', 1, 'amps'), b: top('IB', 1, 'amps'), c: top('IC', 1, 'amps'), n: top('IN', 1, 'amps') },   // highest one-minute amps per phase
  off: OFF, cuts: CUTS, gSplit: G_SPLIT,
};
fs.writeFileSync(path.join(__dirname, 'makhlouf-data.json'), JSON.stringify(out));
CUTS.forEach(c => console.log(`cut ${c.from} → ${c.to} (${c.min} min) ${c.genBefore} ${c.vBefore} V → ${c.genAfter} ${c.vAfter} V = ${c.kind}`));
OFF.forEach(o => console.log(`logger off ${o.from} → ${o.to}: ${o.min} min, ≈ ${o.kw0}→${o.kw1} kW, ≈ ${o.kwh} kWh`));
console.log(`${rows.length} rows since install, ${rows[0] ? rows[0][0] : '-'} → ${rows.length ? rows[rows.length - 1][0] : '-'}; counter ${out.counters.epsum} Wh at ${out.counters.at}`);
