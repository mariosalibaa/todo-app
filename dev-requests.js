// Dev requests (Mario 2026-10-07: "AI everywhere in the hub … for the issues that need coding, group them
// and give me a prompt so we launch it from VS Code when the laptop is online").
// The hub assistant (assistant.js, dev_request tool) and the /dev page put requests here; Claude Code pulls
// them from VS Code with `node dev-queue.mjs` (skill hub-dev-queue) and marks them done with the commit.
//
//   Firestore workspaces/<team>/devRequests/<id>  { id, title, prompt, page, asked, status, createdAt, createdBy,
//                                                   updatedAt, doneAt, commit, notes }
//     status: open → doing → done | dropped
//
//   GET   /api/dev-requests?status=open|all     Mario, or the laptop (ACCOUNTING_API_KEY)
//   POST  /api/dev-requests                      Mario: { title, prompt, page? } → open
//   PATCH /api/dev-requests/<id>                 Mario or the laptop: { title?, prompt?, page?, notes?, status?, commit? }
//   DELETE /api/dev-requests/<id>                Mario
//
// The laptop runner (dev-runner.mjs, 2026-10-18 — Mario: "a conversation that acts like Claude: no coding when the
// laptop is off, coding when it is on"): the Shift chat's hub_dev_request card (✓ = go) writes a request with
// auto:true + the thread to answer in; the runner beats every 30 s and runs the auto ones with Claude Code.
//   POST  /api/dev-requests/laptop               the laptop: { host, busy, job } → meta/laptop
//   GET   /api/dev-requests/laptop               { online, at, busy, job } — online = a beat in the last 2 min
//   extra fields: thread, postId, repo (todo | shift-hub | odoo | …), kind (code | deploy), auto, result, startedAt
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const readBody = (req, max = 2e5) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});
const STATUS = ['open', 'doing', 'done', 'dropped'];
const REPOS = ['todo', 'shift-hub', 'odoo', 'wa-contacts', 'website', 'other'];
const ONLINE_MS = 2 * 60e3;

async function laptopState(ws) {
  const d = (await ws.collection('meta').doc('laptop').get()).data() || {};
  const online = !!d.at && Date.now() - Date.parse(d.at) < ONLINE_MS;
  return { online, at: d.at || null, busy: online && !!d.busy, job: online ? (d.job || '') : '', host: d.host || '' };
}
// a request from the Shift chat's card (site-agent.js exec): auto = the laptop runs it without anyone opening VS Code
async function createAuto(ws, input, { thread, postId, who }) {
  const id = newId();
  const item = { id, title: String(input.title || '').trim().slice(0, 140), prompt: String(input.prompt || '').trim().slice(0, 6000), page: String(input.page || '').slice(0, 80),
    asked: '', status: 'open', auto: true, kind: input.kind === 'deploy' ? 'deploy' : 'code', repo: REPOS.includes(input.repo) ? input.repo : 'todo',
    thread: String(thread || 'shift'), postId: String(postId || ''), createdAt: now(), createdBy: who || 'shift', updatedAt: now() };
  if (!item.title) throw new Error('a title is needed');
  await ws.collection('devRequests').doc(id).set(item);
  return item;
}

async function handle(req, res, url, ctx) {
  const [p, qs] = url.split('?');
  if (!p.startsWith('/api/dev-requests')) return false;
  const { access } = ctx;
  if (!access.admin || access.readOnly) return json(res, 403, { error: 'Mario only' });
  const col = ctx.ws.collection('devRequests');
  if (p === '/api/dev-requests/laptop') {
    if (req.method === 'GET') return json(res, 200, await laptopState(ctx.ws));
    if (req.method === 'POST') {
      const b = await readBody(req);
      await ctx.ws.collection('meta').doc('laptop').set({ at: now(), host: String(b.host || '').slice(0, 60), busy: !!b.busy, job: String(b.job || '').slice(0, 140) });
      return json(res, 200, { ok: true });
    }
  }
  const m = p.match(/^\/api\/dev-requests\/([a-z0-9]+)$/);

  if (p === '/api/dev-requests' && req.method === 'GET') {
    const want = new URLSearchParams(qs || '').get('status') || 'open';
    const snap = await col.get();
    let items = snap.docs.map(d => d.data());
    if (want !== 'all') items = items.filter(x => want === 'open' ? (x.status === 'open' || x.status === 'doing') : x.status === want);
    items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return json(res, 200, { items, counts: Object.fromEntries(STATUS.map(s => [s, snap.docs.filter(d => d.data().status === s).length])) });
  }
  if (p === '/api/dev-requests' && req.method === 'POST') {
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 140), prompt = String(b.prompt || '').trim().slice(0, 6000);
    if (!title) return json(res, 400, { error: 'title needed' });
    const id = newId();
    const item = { id, title, prompt, page: String(b.page || '').slice(0, 80), asked: '', status: 'open', createdAt: now(), createdBy: access.email || 'mario', updatedAt: now() };
    await col.doc(id).set(item);
    return json(res, 200, item);
  }
  if (m && req.method === 'PATCH') {
    const ref = col.doc(m[1]);
    const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'no such request' });
    const b = await readBody(req);
    const d = { updatedAt: now() };
    if ('title' in b) d.title = String(b.title || '').trim().slice(0, 140) || cur.title;
    if ('prompt' in b) d.prompt = String(b.prompt || '').slice(0, 6000);
    if ('page' in b) d.page = String(b.page || '').slice(0, 80);
    if ('notes' in b) d.notes = String(b.notes || '').slice(0, 4000);
    if ('commit' in b) d.commit = String(b.commit || '').slice(0, 60);
    if ('result' in b) d.result = String(b.result || '').slice(0, 6000);
    if (b.status === 'doing') d.startedAt = now();
    if ('status' in b) {
      if (!STATUS.includes(b.status)) return json(res, 400, { error: 'status must be ' + STATUS.join(' | ') });
      d.status = b.status;
      d.doneAt = b.status === 'done' || b.status === 'dropped' ? now() : null;
    }
    await ref.set(d, { merge: true });
    return json(res, 200, { ...cur, ...d });
  }
  if (m && req.method === 'DELETE') {
    await col.doc(m[1]).delete();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'no such route' });
}

module.exports = { handle, laptopState, createAuto };
