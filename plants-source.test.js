// node plants-source.test.js — the "source there but not accepted" detector (plants.js sourceHealth).
// Fixture: Bookstop Kaslique (Solarman 2596285), 3 Oct 2026 — the generator at 51–52 Hz was refused from about
// 17:00 to 19:15, the battery went from 47 % to 4 %, F56 DC_VoltLow at 19:04. fixtures/bookstop-2026-10-03.json holds
// that day's master rows (t, v, hz, grid, batt, soc) as /api/plants/detail?rows=1 returned them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sourceHealth } = require('./plants');

const hm = t => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
const iso2t = s => Date.parse(s) / 1000;

// 1. synthetic: EDL accepted all morning, then a refused generator 17:00–19:15 while the battery drains
{
  const day = Date.parse('2026-10-03T00:00:00+03:00') / 1000, rows = [];
  for (let m = 6 * 60; m < 21 * 60; m += 5) {
    const t = day + m * 60;
    if (m < 17 * 60) rows.push({ t, v: 228, hz: 50, grid: 6000, batt: -2000, soc: 47 });            // EDL taken, battery charging
    else if (m <= 19 * 60 + 15) rows.push({ t, v: 231, hz: 51.7, grid: 20, batt: 9000, soc: Math.round(47 - (m - 17 * 60) * 43 / 135) });   // refused
    else rows.push({ t, v: 0, hz: 0, grid: 0, batt: 9000, soc: 4 });                                // no source at all: not this alarm
  }
  const h = sourceHealth(rows, (day + 21 * 3600) * 1000);
  assert.strictEqual(h.episodes.length, 1, 'one episode');
  const e = h.episodes[0];
  assert.strictEqual(hm(iso2t(e.from)), '17:00');
  assert.strictEqual(hm(iso2t(e.to)), '19:15');
  assert.strictEqual(e.socFrom, 47); assert.strictEqual(e.socTo, 4);
  assert.strictEqual(e.active, false);
  assert.ok(h.presentH > 13 && h.presentH < 13.5, 'source present 06:00–19:15');
  // the same day read at 18:00 → the episode is open
  const live = sourceHealth(rows.filter(r => r.t <= day + 18 * 3600), (day + 18 * 3600 + 60) * 1000);
  assert.ok(live.episodes[0] && live.episodes[0].active, 'active while it lasts');
  // 15 minutes only → no alarm
  assert.strictEqual(sourceHealth(rows.filter(r => r.t <= day + 17 * 3600 + 15 * 60)).episodes.length, 0, 'under 20 min is not an episode');
  console.log('✓ synthetic day');
}

// 2. the real day
const fx = path.join(__dirname, 'fixtures', 'bookstop-2026-10-03.json');
if (fs.existsSync(fx)) {
  const rows = JSON.parse(fs.readFileSync(fx, 'utf8'));
  const h = sourceHealth(rows, Date.parse('2026-10-04T00:00:00+03:00'));
  const ev = h.episodes.find(e => iso2t(e.from) <= Date.parse('2026-10-03T17:30:00+03:00') / 1000 && iso2t(e.to) >= Date.parse('2026-10-03T18:45:00+03:00') / 1000);
  assert.ok(ev, 'Bookstop 3 Oct: the 17:00–19:15 episode is found — got ' + JSON.stringify(h.episodes.map(e => [hm(iso2t(e.from)), hm(iso2t(e.to)), e.socFrom, e.socTo])));
  assert.ok(ev.socFrom - ev.socTo >= 30, 'the battery fell by 30+ points');
  console.log(`✓ Bookstop 3 Oct: ${hm(iso2t(ev.from))}–${hm(iso2t(ev.to))}, SOC ${ev.socFrom} → ${ev.socTo} %, ${ev.hzMin}–${ev.hzMax} Hz; all episodes:`,
    h.episodes.map(e => `${hm(iso2t(e.from))}–${hm(iso2t(e.to))}`).join(', '));
} else console.log('· no Bookstop fixture yet (fixtures/bookstop-2026-10-03.json)');
