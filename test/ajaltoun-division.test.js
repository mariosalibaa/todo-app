const test = require('node:test');
const assert = require('node:assert');
const { _withDivision: withDivision } = require('../ajaltoun');

const DIVS = new Set([161, 174, 179]);   // waterproofing, prefab, solar

test('a plain Ajaltoun tag gains the division', () => {
  assert.deepStrictEqual(withDivision({ 69: 100 }, 174, DIVS), { '69,174': 100 });
});
test('an old division is replaced, not added', () => {
  assert.deepStrictEqual(withDivision({ '69,161': 100 }, 179, DIVS), { '69,179': 100 });
});
test('a villa tag keeps its villa', () => {
  assert.deepStrictEqual(withDivision({ 62: 100 }, 174, DIVS), { '62,174': 100 });
});
test('another project on the same line is left alone', () => {
  assert.deepStrictEqual(withDivision({ 69: 40, 144: 60 }, 174, DIVS), { '69,174': 40, 144: 60 });
});
test('a line with no Ajaltoun tag is not touched', () => {
  assert.strictEqual(withDivision({ 144: 100 }, 174, DIVS), null);
  assert.strictEqual(withDivision(false, 174, DIVS), null);
});
test('a tag of another plan on the key stays', () => {
  assert.deepStrictEqual(withDivision({ '69,155': 100 }, 174, DIVS), { '69,155,174': 100 });
});
