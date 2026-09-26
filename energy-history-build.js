// Builds energy-history.json — kWh per building per Beirut day from the start of the CPR meters (Feb 2025)
// to yesterday, from two sources of the SAME counters:
//   • openHAB Cloud persistence (hourly, Meter1..8_EPImp) — dumped to OH_DUMP from a signed-in browser
//   • the ME437s' own SD-card logs (D:\cpr loggers meatrol\<building>\DataSheet_<serial>_3P4W.csv), reduced
//     to hourly EPSum by tmp/cpr/parse.mjs into SD_DIR/<folder prefix>.json
// Run once (node energy-history-build.js); energy.js then adds the days after it live from openHAB.
//
// What the data showed (2026-09-26):
//   • the SD clocks run 7.8 h ahead of UTC (same counter values, shifted) → SD_SHIFT
//   • the openHAB logger went dark 9 times (19 h … 72 days: 4 May → 15 Jul 2026) and repeated its last value;
//     those stale readings are dropped, the SD log fills most of the gaps, the rest is interpolated (estimated)
//   • 14 Aug 2025: Gen Small's counter jumped 10,812 → 111,169 in one hour = a meter change, not consumption
//   • 4 May 2026: meter 3323341004 (Hotel since the start) stopped; meter 3322261001 (Gen Small's since Aug 2025,
//     idle at 111,255 since Oct 2025) carries on in the Hotel — its SD card is in the "M4 Hotel" folder and
//     openHAB Meter4 reads its counter since 15 Jul (125,448). Gen Small has had no working meter since.
const fs = require('fs');
const path = require('path');
const C = require('./energy-calc');

const OH_DUMP = process.env.OH_DUMP || 'd:/vscode/.playwright-mcp/energy-daily.json';
const SD_DIR = process.env.SD_DIR || 'd:/vscode/tmp/cpr';
const OUT = process.env.OUT || path.join(__dirname, 'energy-history.json');
const SD_SHIFT = 7.8 * 3600e3;
const T = s => Date.parse(s);
const END = Date.now();

let oh = JSON.parse(fs.readFileSync(OH_DUMP, 'utf8')); if (typeof oh === 'string') oh = JSON.parse(oh);
const sd = k => JSON.parse(fs.readFileSync(path.join(SD_DIR, k + '.json'), 'utf8')).rows
  .filter(r => r[0] >= '2025-01-01').map(r => [Date.parse(r[0] + 'Z') - SD_SHIFT, r[1]]);

const OUTAGES = C.outages(oh.Meter1_EPImp, oh.Meter3_EPImp, oh.Meter4_EPImp);
const ohLive = item => C.dropStale(oh[item], OUTAGES);

const START = T('2025-02-18T00:00:00Z');   // openHAB's first days were resets and test values; the SD logs cover them
const SWAP_GENSMALL = [T('2025-08-14T08:00:00Z'), T('2025-08-14T10:00:00Z')];
const SWAP_HOTEL = T('2026-05-04T07:00:00Z');   // 3322261001 starts counting at 14:59 meter-time = 07:11 UTC; from then on it is the Hotel

const seg = (from, to, ...sources) => ({ from, to, pts: C.cleanPoints(sources.flat(), from, to) });
const SEGMENTS = {
  school: [seg(0, END, ohLive('Meter1_EPImp').filter(p => p[0] >= START), sd('M1'))],
  church: [seg(0, END, ohLive('Meter2_EPImp').filter(p => p[0] >= START), sd('M2'))],
  liqaa: [seg(0, END, ohLive('Meter3_EPImp').filter(p => p[0] >= START), sd('M3'))],
  hotel: [
    seg(0, SWAP_HOTEL, ohLive('Meter4_EPImp').filter(p => p[0] >= START), sd('M6')),            // meter 3323341004
    seg(SWAP_HOTEL, END, sd('M4'), ohLive('Meter4_EPImp').filter(p => p[1] >= 111000)),        // meter 3322261001
  ],
  genChurch: [seg(0, END, ohLive('Meter5_EPImp'), sd('M5'))],
  genSmall: [
    seg(0, SWAP_GENSMALL[0], ohLive('Meter6_EPImp')),
    seg(SWAP_GENSMALL[1], SWAP_HOTEL, ohLive('Meter6_EPImp'), sd('M4')),
  ],
  genBig: [seg(T('2025-09-01T00:00:00Z'), END, ohLive('Meter7_EPImp'), sd('M7'))],   // their SD cards logged one line at installation (30 Jul) then nothing until September
  edl: [seg(T('2025-09-01T00:00:00Z'), END, ohLive('Meter8_EPImp'), sd('M8'))],
};

const first = C.dayOf(Math.min(...Object.values(SEGMENTS).flat().filter(s => s.pts.length).map(s => s.pts[0][0])));
const lastDay = (() => { const d = C.dayOf(END); const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10); })();   // yesterday, Beirut
const days = []; for (let d = first; d <= lastDay; d = C.nextDay(d)) days.push(d);
const data = {};
for (const b of C.BUILDINGS) { const dl = C.daily(SEGMENTS[b.key], first, lastDay); data[b.key] = days.map(d => dl[d]); }

const out = {
  builtAt: new Date().toISOString(), first, last: lastDay, days, data,
  // no meter from that day on; Mario 2026-09-26: the generator is not running — the page shows 0 · off
  noMeter: { genSmall: '2026-05-04' },
  // the counter each building's live days continue from (energy.js): openHAB item + the value floor that proves it is the right counter
  live: { hotel: { item: 'Meter4_EPImp', min: 111000 } },
  outages: OUTAGES.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]),
  notes: [
    'Clean figures start in Feb 2025 (meters installed; openHAB reset them until 17 Feb — those days come from the SD logs).',
    'openHAB was offline 9 times, longest 4 May → 15 Jul 2026. The meters kept counting: the SD-card logs fill the gaps up to 24 Jun 2026; what is left is spread evenly over the days offline (marked ≈ estimated).',
    'Gen Small, 14 Aug 2025: its counter jumped by 97,000 kWh in one hour — a meter change, not consumption; left out.',
    'Hotel, 4 May 2026: its meter (3323341004) stopped and meter 3322261001 took over (its SD card is in the "M4 Hotel" folder). The 68,000 kWh step openHAB shows on 15 Jul 2026 is that change of counter, not consumption.',
    'Gen Small is not running: its counter stood still from Oct 2025, and since 4 May 2026 it has no meter at all (the meter went to the Hotel; openHAB still repeats 111,255 kWh) — shown as 0 · off.',
  ],
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', OUT, days.length, 'days', first, '→', lastDay, 'outages', OUTAGES.length);
// monthly check
const months = {};
days.forEach((d, i) => { const m = d.slice(0, 7); months[m] = months[m] || {}; for (const b of C.BUILDINGS) { const v = data[b.key][i]; if (v) { months[m][b.key] = (months[m][b.key] || 0) + v[0]; if (v[1]) months[m][b.key + '_e'] = 1; } } });
console.log('month   ' + C.BUILDINGS.map(b => b.key.padStart(9)).join(''));
for (const [m, o] of Object.entries(months)) console.log(m + ' ' + C.BUILDINGS.map(b => ((o[b.key] != null ? Math.round(o[b.key]) : '-') + (o[b.key + '_e'] ? '≈' : ' ')).padStart(9)).join(''));
