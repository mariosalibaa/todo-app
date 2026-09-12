const test = require('node:test');
const assert = require('node:assert');
const { quickParse, matchName } = require('../site-parse');

test('a bare amount from the worker is what he is owed', () => {
  const r = quickParse('750$', { fromMe: false, owner: 'Khodr' });
  assert.strictEqual(r.amount, 750); assert.strictEqual(r.currency, 'USD'); assert.strictEqual(r.side, 'debit');
});
test('paid from Mario is money he received', () => {
  const r = quickParse('paid 200$', { fromMe: true, owner: 'Khodr' });
  assert.strictEqual(r.side, 'credit');
});
test('no amount → null', () => {
  assert.strictEqual(quickParse('excavation D1 today', { fromMe: false, owner: 'Khodr' }), null);
});
test('the longest name in the text wins', () => {
  const list = [{ id: 1, name: 'Bilal' }, { id: 2, name: 'Bilal Aluminum' }, { id: 3, name: 'Ajaltoun 4193' }];
  assert.strictEqual(matchName('paid bilal aluminum 200 ajaltoun', list).id, 2);
  assert.strictEqual(matchName('nothing here', list), null);
});
