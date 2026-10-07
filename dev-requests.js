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
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const readBody = (req, max = 2e5) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});
const STATUS = ['open', 'doing', 'done', 'dropped'];

async function handle(req, res, url, ctx) {
  const [p, qs] = url.split('?');
  if (!p.startsWith('/api/dev-requests')) return false;
  const { access } = ctx;
  if (!access.admin || access.readOnly) return json(res, 403, { error: 'Mario only' });
  const col = ctx.ws.collection('devRequests');
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

module.exports = { handle };
