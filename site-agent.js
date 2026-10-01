// D:\vscode\todo\site-agent.js — "Shift", the agent member of the site chat.
// Spec: docs/superpowers/specs/2026-09-20-site-agent-design.md. Mario writes in the `shift` thread, or
// starts a message with @shift / @s in any thread; the post is forwarded to Render (shift-hub,
// bots/agent-site) which answers back through the machine routes below (/api/site/agent/*).
// The agent writes nothing without Mario's ✓ on an action card (POST …/confirm).
const acc = require('./accounts');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const beirutDay = d => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const readBody = (req, max = 2e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});

const AGENT = 'shift';                       // the thread id and the `by` of every agent post
const TRIGGER = /^@(shift|s)\b[:,]?\s*/i;
const PRIORITIES = ['high', 'medium', 'low'];

const isTrigger = (thread, text, admin) => !!admin && (thread === AGENT || TRIGGER.test(String(text || '')));
const stripTrigger = text => String(text || '').replace(TRIGGER, '').trim();

// what the agent gets to read: the last posts of the thread, oldest first, one line each
function contextLines(posts) {
  return posts.filter(p => !p.deleted && p.kind !== 'start' && p.kind !== 'finish').slice(-20).map(p => {
    const who = p.by === AGENT ? 'Shift' : p.byAdmin ? 'Mario' : String(p.by || '').split('@')[0];
    const body = p.kind === 'action' ? `[action card ${p.status || 'pending'}] ${(p.action && p.action.summary) || ''}`
      : p.kind === 'text' ? p.text
      : p.parsed && p.parsed.transcript ? `(voice) ${p.parsed.transcript}` : `(${p.kind})`;
    return `${p.date} ${who}: ${body}`;
  });
}

// the To-Do app's task shape (todo.html kanbanAddCommit), filled from the agent's input.
// origin:'api' — the board's full-list save never hard-deletes it (server.js tasks route), so a tab
// open with a stale list cannot drop a task the agent just added.
function todoDoc(input, who, users) {
  const name = String(input.assignee || '').trim().toLowerCase();
  const user = name ? (users || []).find(u => String(u.name || '').toLowerCase().startsWith(name)) : null;
  const notes = [name && !user ? `for ${input.assignee}` : '', String(input.notes || '').trim()].filter(Boolean).join(' · ');
  return { id: 'ag-' + newId(), title: String(input.title || '').trim().slice(0, 200), done: false, doneAt: null, createdAt: now(),
    project: '', taskStatus: '', department: null, priority: PRIORITIES.includes(input.priority) ? input.priority : '',
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(input.due || '')) ? input.due : '', partner: '', notes, taskType: 'task',
    clientName: '', clientId: null, subtasks: [], assignees: user ? [user.id] : [], createdBy: who, origin: 'api' };
}

const previewOf = p => p.kind === 'action' ? `${p.status === 'done' ? '✓' : p.status === 'declined' ? '✗' : '✓?'} ${(p.action && p.action.summary) || ''}` : String(p.text || '');

// the ledger line a card's write becomes: site-<card>-<tail of the tool_use id>. One card, one line per
// write — a re-run ✓ overwrites the same line, two writes on one card never collide.
const lineIdOf = (cardId, writeId) => { const tail = String(writeId || '').replace(/[^\w]/g, '').slice(-8); return String(cardId) + (tail ? '-' + tail : ''); };
// the card keeps the ids of the writes that went through (Render's settle `done`); a ✓ retry after a
// partial failure sends only the rest
const pendingWrites = action => { const done = new Set((action && action.done) || []); return ((action && action.writes) || []).filter(w => !done.has(w.id)); };
const mergeDone = (had, more) => [...new Set([...(had || []), ...(Array.isArray(more) ? more : []).filter(x => typeof x === 'string')])];

module.exports = { AGENT, isTrigger, stripTrigger, contextLines, todoDoc, previewOf, lineIdOf, pendingWrites, mergeDone };
