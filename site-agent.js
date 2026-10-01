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

// the worker ledgers the agent may name; `current` when the thread is a worker's chat
async function ledgerFor(ws, thread) {
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived)
    .map(a => ({ id: a.id, name: a.name, owner: a.owner || '', odooPartnerId: a.odooPartner ? a.odooPartner.id : null }));
  return { current: people.find(p => p.id === thread) || null, people };
}

// Render, and only its ack: the turn runs after (a Claude loop can take a minute; Vercel gives us 60 s)
async function render(path, body) {
  const base = String(process.env.SITE_AGENT_URL || '').replace(/\/+$/, '');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25e3);
  try {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.SITE_AGENT_SECRET || '') }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error('Shift answered ' + r.status);
  } finally { clearTimeout(t); }
}
const WAKING = 'Shift is waking up — send it again in a moment';
const fail = (res, e) => json(res, e.name === 'AbortError' ? 504 : 502, { error: e.name === 'AbortError' ? WAKING : e.message });

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const postsOf = thread => ws.collection('site').doc(thread).collection('posts');
  let m;

  // ── Mario's side ─────────────────────────────────────────────────────────────
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/ask$/)) && req.method === 'POST') {
    if (!access.admin || access.agent) return json(res, 403, { error: 'admin only' });
    if (!process.env.SITE_AGENT_URL) return json(res, 503, { error: 'Shift is not connected (SITE_AGENT_URL)' });
    const [thread, id] = [m[1], m[2]];
    const ref = postsOf(thread).doc(id);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    const text = post.kind === 'text' ? stripTrigger(post.text) : (post.parsed && post.parsed.transcript) || '';
    if (!text) return json(res, 400, { error: 'nothing to ask — a voice note needs its transcript first' });
    const snap = await postsOf(thread).orderBy('at', 'desc').limit(25).get();
    const context = contextLines(snap.docs.map(x => x.data()).reverse().filter(p => p.id !== id));
    const ledger = await ledgerFor(ws, thread);
    await ref.set({ agentAsk: true, askedAt: now(), answeredAt: null, digestedAt: post.digestedAt || now(), digesting: false, line: null }, { merge: true });
    try { await render('/site-agent', { thread, postId: id, text, date: post.date, context, ledger }); }
    catch (e) { return fail(res, e); }
    return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/confirm$/)) && req.method === 'POST') {
    if (!access.admin || access.agent) return json(res, 403, { error: 'admin only' });
    if (!process.env.SITE_AGENT_URL) return json(res, 503, { error: 'Shift is not connected (SITE_AGENT_URL)' });
    const [thread, id] = [m[1], m[2]];
    const ref = postsOf(thread).doc(id);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    if (post.kind !== 'action') return json(res, 400, { error: 'not an action card' });
    if (!['pending', 'error'].includes(post.status)) return json(res, 409, { error: `this card is already ${post.status}` });
    const b = await readBody(req);
    const ok = !!b.ok;
    const writes = pendingWrites(post.action);   // after a partial failure: only what has not gone through
    if (ok && !writes.length) { await ref.set({ status: 'done', error: '', settledAt: now() }, { merge: true }); return json(res, 200, (await ref.get()).data()); }
    await ref.set({ status: ok ? 'running' : 'declined', error: '', confirmedAt: now(), confirmedBy: user.email || user.uid }, { merge: true });
    try { await render('/site-agent/confirm', { thread, postId: id, ok, note: String(b.note || '').slice(0, 500), writes, date: post.date, ledger: await ledgerFor(ws, thread) }); }
    catch (e) {
      if (!ok) return json(res, 200, (await ref.get()).data());   // a ✗ needs nothing from Render: the card stays declined
      await ref.set({ status: 'error', error: e.name === 'AbortError' ? WAKING : e.message }, { merge: true });
      return fail(res, e);
    }
    return json(res, 200, (await ref.get()).data());
  }

  // ── Render's side (machine bearer → access.agent, see server.js) ─────────────
  if (url.startsWith('/api/site/agent/')) {
    if (!access.agent) return json(res, 403, { error: 'agent only' });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
    const b = await readBody(req);

    if (url === '/api/site/agent/exec') {
      const w = b.write || {}, input = w.input || {};
      const host = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'hub.shift-group.co');
      if (w.name === 'hub_worker_line') {
        const a = await acc.resolve(ws, String(input.account || ''));
        if (!a || !a.daily) return json(res, 400, { error: 'no such worker ledger: ' + (input.account || '(none)') });
        const amount = Math.round((+input.amount || 0) * 100) / 100;
        if (!(amount > 0)) return json(res, 400, { error: 'an amount above 0 is needed' });
        const analytic = input.analytic ? parse.matchName(String(input.analytic), (await ctx.refs(ctx)).analytics) : null;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : beirutDay();
        // the card's id (+ the write's) becomes the line's id: a re-run ✓ overwrites, never duplicates
        const post = { id: lineIdOf(b.postId || newId(), w.id), thread: a.id, date, at: now(), by: AGENT, byAdmin: true, text: '' };
        const line = await ctx.writeLine(ctx, ws, post, a.id, { amount, side: input.side === 'credit' ? 'credit' : 'debit', description: String(input.description || '').slice(0, 160), analytic, nature: ['labour', 'expense', 'vendor', 'transfer'].includes(input.nature) ? input.nature : undefined, note: '', src: 'agent' });
        return json(res, 200, { ok: true, receipt: `${a.name} ledger · ${input.side === 'credit' ? '-' : '+'}${amount} ${date} · waiting for ✓ on the Day report`, url: host + '/accounting/daily', line });
      }
      if (w.name === 'hub_todo') {
        const users = (await ws.collection('users').get()).docs.map(d => ({ id: d.id, ...d.data() }));
        const t = todoDoc(input, AGENT, users);
        if (!t.title) return json(res, 400, { error: 'a title is needed' });
        await ws.collection('tasks').doc(t.id).set({ ...t, workspaceId: TEAM_ID });
        return json(res, 200, { ok: true, receipt: `to-do "${t.title}"${t.due ? ' due ' + t.due : ''}`, url: host + '/todo', taskId: t.id });
      }
      return json(res, 400, { error: 'unknown hub write ' + w.name });
    }

    const thread = String(b.thread || '');
    if (!/^[\w-]+$/.test(thread)) return json(res, 400, { error: 'thread' });

    if (url === '/api/site/agent/reply') {
      const id = newId();
      const post = { id, thread, by: AGENT, at: now(), date: beirutDay(), kind: b.kind === 'action' ? 'action' : 'text', text: String(b.text || '').slice(0, 4000), byAdmin: false, replyTo: b.replyTo ? String(b.replyTo) : null, digestedAt: now() };
      if (post.kind === 'action') {
        const a = b.action || {};
        post.action = { summary: String(a.summary || '').slice(0, 300), detail: String(a.detail || '').slice(0, 1500), writes: Array.isArray(a.writes) ? a.writes.slice(0, 10) : [], done: [] };
        if (!post.action.writes.length) return json(res, 400, { error: 'an action card needs writes' });
        post.status = 'pending'; post.receipt = ''; post.error = ''; post.text = post.action.summary;
      } else if (!post.text) return json(res, 400, { error: 'nothing to say' });
      await postsOf(thread).doc(id).set(post);
      return json(res, 200, post);
    }
    if (url === '/api/site/agent/done') {
      if (b.postId) { const ref = postsOf(thread).doc(String(b.postId)); if ((await ref.get()).exists) await ref.set({ answeredAt: now() }, { merge: true }); }
      return json(res, 200, { ok: true });
    }
    if (url === '/api/site/agent/settle') {
      if (!b.postId) return json(res, 400, { error: 'postId' });
      const ref = postsOf(thread).doc(String(b.postId));
      const d = await ref.get(); if (!d.exists || d.data().kind !== 'action') return json(res, 404, { error: 'no card' });
      const card = d.data();
      const status = ['done', 'declined', 'error'].includes(b.status) ? b.status : 'error';
      const had = (card.action && card.action.done) || [];
      // a ✓ retry after a partial failure: keep the receipt of what went through the first time
      const receipt = [had.length ? card.receipt : '', String(b.receipt || '')].filter(Boolean).join(' · ').slice(0, 300);
      await ref.set({ status, receipt, error: String(b.error || '').slice(0, 300), settledAt: now(), action: { done: mergeDone(had, b.done) } }, { merge: true });
      return json(res, 200, (await ref.get()).data());
    }
    return json(res, 404, { error: 'no such agent route' });
  }
  return false;
}

module.exports = { AGENT, isTrigger, stripTrigger, contextLines, todoDoc, previewOf, lineIdOf, pendingWrites, mergeDone, handle };
