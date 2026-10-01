// D:\vscode\todo\test\site-agent.test.js — node --test test/site-agent.test.js
const test = require('node:test');
const assert = require('node:assert');
const { AGENT, isTrigger, stripTrigger, contextLines, todoDoc, previewOf, lineIdOf, pendingWrites, mergeDone } = require('../site-agent');

test('trigger: the shift thread, or @shift / @s at the start — admin only', () => {
  assert.ok(isTrigger('shift', 'hello', true));
  assert.ok(isTrigger('georges', '@shift how much does he owe', true));
  assert.ok(isTrigger('georges', '@S add 40$ diesel', true));
  assert.ok(!isTrigger('georges', 'he @shift owes', true), 'only at the start');
  assert.ok(!isTrigger('georges', '@shifted', true));
  assert.ok(!isTrigger('shift', 'hello', false), 'a worker never wakes it');
  assert.strictEqual(AGENT, 'shift');
});

test('stripTrigger removes the prefix only', () => {
  assert.strictEqual(stripTrigger('@shift: how much'), 'how much');
  assert.strictEqual(stripTrigger('@s add 40$'), 'add 40$');
  assert.strictEqual(stripTrigger('plain text'), 'plain text');
});

test('contextLines: last 20, oldest first, one line each, taps and deleted skipped', () => {
  const posts = [
    { date: '2026-09-19', by: 'georges@x', kind: 'text', text: '40$ diesel' },
    { date: '2026-09-19', by: 'mario@x', byAdmin: true, kind: 'voice', parsed: { transcript: 'ok noted' } },
    { date: '2026-09-19', by: 'georges@x', kind: 'start' },
    { date: '2026-09-19', by: 'georges@x', kind: 'photo', parsed: {} },
    { date: '2026-09-20', by: 'shift', kind: 'action', status: 'done', action: { summary: 'Georges ledger: +$40 diesel' } },
    { date: '2026-09-20', by: 'georges@x', kind: 'text', text: 'gone', deleted: true },
  ];
  assert.deepStrictEqual(contextLines(posts), [
    '2026-09-19 georges: 40$ diesel',
    '2026-09-19 Mario: (voice) ok noted',
    '2026-09-19 georges: (photo)',
    '2026-09-20 Shift: [action card done] Georges ledger: +$40 diesel',
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ date: '2026-09-20', by: 'a@x', kind: 'text', text: 't' + i }));
  const c = contextLines(many); assert.strictEqual(c.length, 20); assert.strictEqual(c[0], '2026-09-20 a: t10');
});

test('todoDoc: the To-Do app shape, assignee matched by name, priority whitelisted', () => {
  const users = [{ id: 'u1', name: 'Christa Saliba' }, { id: 'u2', name: 'Mario' }];
  const t = todoDoc({ title: '  send D3 drawings ', assignee: 'christa', due: '2026-09-22', priority: 'high', notes: 'for Antoine' }, 'shift', users);
  assert.match(t.id, /^ag-/);
  assert.strictEqual(t.title, 'send D3 drawings'); assert.strictEqual(t.done, false); assert.strictEqual(t.doneAt, null);
  assert.deepStrictEqual(t.assignees, ['u1']); assert.strictEqual(t.due, '2026-09-22'); assert.strictEqual(t.priority, 'high');
  assert.strictEqual(t.notes, 'for Antoine'); assert.strictEqual(t.taskType, 'task'); assert.strictEqual(t.createdBy, 'shift');
  assert.strictEqual(t.origin, 'api', 'the board\'s full-list save never hard-deletes it');
  const u = todoDoc({ title: 'x', assignee: 'nobody', due: 'Monday', priority: 'urgent' }, 'shift', users);
  assert.deepStrictEqual(u.assignees, []); assert.strictEqual(u.due, ''); assert.strictEqual(u.priority, ''); assert.strictEqual(u.notes, 'for nobody');
  assert.strictEqual(todoDoc({ title: '   ' }, 'shift', users).title, '');
});

test('previewOf: an action card previews as its summary', () => {
  assert.strictEqual(previewOf({ kind: 'action', action: { summary: 'Pay Khoder $150' }, status: 'pending' }), '✓? Pay Khoder $150');
  assert.strictEqual(previewOf({ kind: 'action', action: { summary: 'Pay Khoder $150' }, status: 'done' }), '✓ Pay Khoder $150');
  assert.strictEqual(previewOf({ kind: 'text', text: 'hello' }), 'hello');
});

test('lineIdOf: one card, one line per write — the write id tail keeps two writes apart', () => {
  assert.strictEqual(lineIdOf('card1', 'toolu_01ABCDEFGHJK'), 'card1-CDEFGHJK');
  assert.strictEqual(lineIdOf('card1', ''), 'card1');
  assert.notStrictEqual(lineIdOf('c', 'toolu_aaaaaaaa1'), lineIdOf('c', 'toolu_aaaaaaaa2'));
});

test('pendingWrites / mergeDone: a ✓ retry runs only what has not gone through', () => {
  const action = { writes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], done: ['a'] };
  assert.deepStrictEqual(pendingWrites(action).map(w => w.id), ['b', 'c']);
  assert.deepStrictEqual(mergeDone(['a'], ['c', 'a', 7]), ['a', 'c']);
  assert.deepStrictEqual(pendingWrites({ writes: [{ id: 'x' }] }).map(w => w.id), ['x']);
});
