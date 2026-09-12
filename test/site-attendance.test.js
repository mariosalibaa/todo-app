// node --test test/site-attendance.test.js — the pure parts of the attendance module
const test = require('node:test');
const assert = require('node:assert');
const { dayOf, distanceM, beirutIso } = require('../site-attendance');

test('distance: 100 m north is ~100 m', () => {
  const d = distanceM({ lat: 33.99, lng: 35.73 }, { lat: 33.99 + 100 / 111320, lng: 35.73 });
  assert.ok(Math.abs(d - 100) < 1, String(d));
});

test('beirutIso: summer is UTC+3, winter UTC+2', () => {
  assert.strictEqual(beirutIso('2026-09-11', '07:30'), '2026-09-11T04:30:00.000Z');
  assert.strictEqual(beirutIso('2026-01-11', '07:30'), '2026-01-11T05:30:00.000Z');
});

test('dayOf: hours, what he did, media, flags', () => {
  const posts = [
    { id: 's', kind: 'start', at: '2026-09-11T04:30:00.000Z', loc: { lat: 1, lng: 1 }, siteId: 'x', manual: false },
    { id: 't1', kind: 'text', at: '2026-09-11T06:00:00.000Z', text: 'poured the slab', line: null },
    { id: 't2', kind: 'text', at: '2026-09-11T06:10:00.000Z', text: 'benzine 20', line: { txId: 'site-t2' } },
    { id: 'p', kind: 'photo', at: '2026-09-11T07:00:00.000Z', file: { id: 'f' }, line: null },
    { id: 'f', kind: 'finish', at: '2026-09-11T13:15:00.000Z', loc: null, manual: true },
  ];
  const d = dayOf(posts, {});
  assert.strictEqual(d.arrived, '07:30'); assert.strictEqual(d.finished, '16:15'); assert.strictEqual(d.hours, 8.8);
  assert.deepStrictEqual(d.did, ['poured the slab']);           // the amount line is not "what he did"
  assert.strictEqual(d.media.length, 1);
  assert.strictEqual(d.manual, true); assert.strictEqual(d.noLocation, true); assert.strictEqual(d.noStart, false);
});

test('dayOf: a Finish with no Start is flagged', () => {
  const d = dayOf([{ id: 'f', kind: 'finish', at: '2026-09-11T13:15:00.000Z', loc: { lat: 1, lng: 1 } }], {});
  assert.strictEqual(d.noStart, true); assert.strictEqual(d.hours, 0);
});
