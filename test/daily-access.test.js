const test = require('node:test');
const assert = require('node:assert');
const { filterForPartner, readOnlyFor, isSuggestion } = require('../daily-access');

test('a partner sees only accepted lines on his projects', () => {
  const lines = [
    { id: 'a', analyticId: 69, src: 'manual' },
    { id: 'b', analyticId: 2, src: 'manual' },
    { id: 'c', analyticSplit: [{ id: 62, pct: 50 }, { id: 2, pct: 50 }], src: 'manual' },
    { id: 'd', analyticId: 69, src: 'whatsapp', waAccepted: false },
    { id: 'e', analyticId: 69, src: 'site', waAccepted: true },
    { id: 'f', src: 'manual' },
  ];
  assert.deepStrictEqual(filterForPartner(lines, [69, 62]).map(l => l.id), ['a', 'c', 'e']);
  assert.deepStrictEqual(filterForPartner(lines, []), []);
});

test('read-only is daily without accounting', () => {
  assert.strictEqual(readOnlyFor({ apps: ['daily'], admin: false }), true);
  assert.strictEqual(readOnlyFor({ apps: ['daily', 'accounting'], admin: false }), false);
  assert.strictEqual(readOnlyFor({ apps: [], admin: true }), false);
});

test('a suggestion is an unaccepted whatsapp or site line', () => {
  assert.strictEqual(isSuggestion({ src: 'site' }), true);
  assert.strictEqual(isSuggestion({ src: 'whatsapp', waAccepted: true }), false);
  assert.strictEqual(isSuggestion({ src: 'manual' }), false);
});
