// /makhlouf — the power logger on the Maison M Naccache (Makhlouf) generator, 300–600 kVA MTS.
// Logger 3322205001 (3-phase, CS meter + SD card), moved there from Mario's house on 2 Oct 2026, 06:00–07:00.
// Rebuild after reading a new SD card:   node makhlouf-build.js "C:\path\to\folder with DataSheet_3322205001_3P4W.csv"
// → makhlouf-data.json (committed, served by /api/makhlouf). Logger clock = Beirut time.
//
// The card has a recording fault since 29 Jun (it writes a few rows after a power-up, then stops), so the meter's
// own counters carry the energy too: EPA/EPB/EPC keep counting whatever the card does. At the house the logger was
// on phase A only, so B and C since the last house row (23 Aug) are Makhlouf alone; phase A still holds the house's
// use until 2 Oct (≈ 37 kWh a day, from the 1 → 23 Aug counter rise) — taken off as an estimate.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('usage: node makhlouf-build.js <folder with DataSheet_3322205001_3P4W.csv>'); process.exit(1); }
const file = fs.readdirSync(dir).find(f => /^DataSheet_.*\.csv$/i.test(f));
const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
const head = lines[2].split(',');
const ix = {}; head.forEach((k, i) => { if (!(k in ix)) ix[k] = i; });

const INSTALL = '2026-10-02 06:30';   // Mario: moved on 2 Oct between 06:00 and 07:00
const HOUSE = { at: '2026-08-23 16:58', epa: 8352000, epb: 4151812, epc: 4975910, aPerDay: 37 };   // last house row (Wh)
const COLS = ['UA', 'UB', 'UC', 'IA', 'IB', 'IC', 'IN', 'PA', 'PB', 'PC', 'PSum', 'PFAvg', 'FAvg', 'UTHAvg', 'ITHAvg', 'EPSum'];

const rows = [];
let last = null;
for (const l of lines.slice(3)) {
  const r = l.split(',');
  if (!/^\d{4}-\d\d-\d\d$/.test(r[0])) continue;
  const at = r[0] + ' ' + r[1].slice(0, 5);
  last = r;
  if (at < '2026-10-02 06:00') continue;
  if (+r[ix.UA] === 0 && +r[ix.UB] === 0 && +r[ix.UC] === 0) continue;   // the power-up row (all zeros)
  rows.push([r[0] + ' ' + r[1], ...COLS.map(k => +r[ix[k]])]);
}
const n = k => +last[ix[k]];
const out = {
  built: new Date().toISOString(), file, serial: (lines[0].split(':')[1] || '').trim(), install: INSTALL, house: HOUSE,
  cols: ['at', ...COLS], rows,
  counters: { at: last[0] + ' ' + last[1], epa: n('EPA'), epb: n('EPB'), epc: n('EPC'), epsum: n('EPSum') },
  peak: { kw: n('PDmP') / 1000, at: last[ix['PDmP_D/T']], amps: n('PDmIAVG'), ampsAt: last[ix['PDmIAVG_D/T']] },
};
fs.writeFileSync(path.join(__dirname, 'makhlouf-data.json'), JSON.stringify(out));
console.log(`${rows.length} rows since install, ${rows[0] ? rows[0][0] : '-'} → ${rows.length ? rows[rows.length - 1][0] : '-'}; counter ${out.counters.epsum} Wh at ${out.counters.at}`);
