// Partners app — the agreements a partner may read on the hub.
// Mounted by server.js under /api/partners/*; needs ctx = { db, TEAM_ID, access }.
//
// Firestore layout (under workspaces/<team>):
//   partnersFiles/<id>   { id, name, group, order, mime, size, sha1, b64, mtime, updatedAt, updatedBy }
//
// The bytes live in Firestore, never in the repo or the Vercel bundle: these are signed
// agreements, and the project's Storage bucket is not switched on. Firestore caps a
// document at 1 MiB, so a file must stay under ~700 KB — the whole folder is 1.4 MB today.
// The laptop keeps the files current with partners-sync.mjs (Dropbox folder → here);
// the page only ever reads. Every route sits behind the 'partners' app gate in server.js;
// uploads and deletes additionally need an admin.

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const MAX_B64 = 950e3;   // leaves room for the other fields under Firestore's 1 MiB

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const strip = d => { const { b64, ...rest } = d; return rest; };

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const col = db.collection('workspaces').doc(TEAM_ID).collection('partnersFiles');
  const who = (user && user.email) || 'unknown';
  let m;

  // The list the page shows: everything but the bytes, grouped and ordered by the page
  if (url === '/api/partners/files' && req.method === 'GET') {
    const snap = await col.get();
    const list = snap.docs.map(d => strip(d.data()));
    list.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
    return json(res, 200, list);
  }

  // The key figures shown above the documents (written by partners-sync.mjs)
  if (url === '/api/partners/terms' && req.method === 'GET') {
    const d = (await db.collection('workspaces').doc(TEAM_ID).collection('partnersMeta').doc('terms').get()).data();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end((d && d.json) || 'null'); return true;
  }

  // One file, streamed inline so a PDF opens in the tab (the cookie authenticates a GET)
  if ((m = url.match(/^\/api\/partners\/files\/([\w-]+)$/)) && req.method === 'GET') {
    const d = (await col.doc(m[1]).get()).data();
    if (!d) return json(res, 404, { error: 'no such file' });
    const dl = /[?&]dl=1/.test(req.url || '');
    res.writeHead(200, { 'Content-Type': d.mime || 'application/octet-stream',
      'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable' });   // the URL carries the checksum
    res.end(Buffer.from(d.b64, 'base64'));
    return true;
  }

  // Writes: the sync script (Mario's laptop, admin session) only
  if (!access || !access.admin) return json(res, 403, { error: 'admin only' });

  if (url === '/api/partners/files' && req.method === 'POST') {
    const b = await readBody(req, 3e6);
    const raw = String(b.dataBase64 || '').replace(/^data:[^,]*,/, '');
    if (!raw || !b.name) return json(res, 400, { error: 'name and dataBase64 required' });
    if (raw.length > MAX_B64) return json(res, 400, { error: `${b.name} is too large for Firestore (${Math.round(raw.length * 3 / 4 / 1024)} KB > ~700 KB)` });
    const id = String(b.id || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const doc = { id, name: String(b.name).slice(0, 160), group: String(b.group || 'Documents').slice(0, 80), order: +b.order || 0,
      mime: String(b.mime || 'application/octet-stream').slice(0, 80), size: Math.round(raw.length * 3 / 4), sha1: String(b.sha1 || ''),
      mtime: String(b.mtime || ''), b64: raw, updatedAt: now(), updatedBy: who };
    await col.doc(id).set(doc);
    return json(res, 200, strip(doc));
  }

  if ((m = url.match(/^\/api\/partners\/files\/([\w-]+)$/)) && req.method === 'DELETE') {
    await col.doc(m[1]).delete();
    return json(res, 200, { ok: true, id: m[1] });
  }

  return false;
}

module.exports = { handle };
