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

const { findTasks, todoPatch, todoDeletePatch, patchReceipt } = require('../site-agent');

test('findTasks: open tasks only, scored by query words, id + title + due back', () => {
  const tasks = [
    { id: 'a1', title: 'Quote Phoenix Group — 4 electrical items', project: 'General Tasks', createdAt: '2026-10-10', notes: 'breaker, SPD' },
    { id: 'a2', title: 'Write Airbnb guest review', project: 'General Tasks', createdAt: '2026-10-12' },
    { id: 'a3', title: 'Phoenix done', done: true },
    { id: 'a4', title: 'Phoenix gone', deleted: true },
    { id: 'a5', title: 'Phoenix old', archived: true },
  ];
  const r = findTasks(tasks, 'phoenix quote');
  assert.deepStrictEqual(r.map(t => t.id), ['a1']);
  assert.deepStrictEqual(Object.keys(r[0]), ['id', 'title', 'due', 'project', 'priority', 'notes']);
  assert.deepStrictEqual(findTasks(tasks, '').map(t => t.id), ['a2', 'a1'], 'no query = every open task, newest first');
  assert.deepStrictEqual(findTasks(tasks, 'zzz'), []);
});

test('todoPatch: only the named fields move, blanks clear, unchanged = null', () => {
  const cur = { title: 'Call Roger', due: '2026-10-20', priority: 'high', notes: '', assignees: [], done: false };
  const users = [{ id: 'u1', name: 'Christa' }];
  assert.strictEqual(todoPatch({}, cur, users, 'shift'), null);
  assert.strictEqual(todoPatch({ due: '2026-10-20' }, cur, users, 'shift'), null, 'same value = no change');
  const p = todoPatch({ due: '2026-10-25', priority: '', assignee: 'chris', title: '  Call Roger about VAT ' }, cur, users, 'shift');
  assert.strictEqual(p.due, '2026-10-25'); assert.strictEqual(p.priority, ''); assert.deepStrictEqual(p.assignees, ['u1']);
  assert.strictEqual(p.title, 'Call Roger about VAT'); assert.strictEqual(p.updatedBy, 'shift'); assert.ok(p.updatedAt);
  assert.strictEqual(todoPatch({ due: 'next week' }, cur, users, 'shift'), null, 'a bad date is ignored');
  const d = todoPatch({ done: true }, cur, users, 'shift'); assert.strictEqual(d.done, true); assert.ok(d.doneAt);
  const unk = todoPatch({ assignee: 'Walid' }, cur, users, 'shift'); assert.strictEqual(unk.notes, 'for Walid'); assert.strictEqual(unk.assignees, undefined);
  assert.strictEqual(patchReceipt(p), 'title → Call Roger about VAT, due → 2026-10-25, priority → (cleared)');
  assert.strictEqual(patchReceipt(d), 'ticked done');
  const del = todoDeletePatch('shift'); assert.strictEqual(del.deleted, true); assert.strictEqual(del.deletedBy, 'shift');
});
