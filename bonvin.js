// Bonvin — the family shop at Sin El Fil 2292 / A5: the dossier page (/bonvin) and its files.
// Mounted by server.js under /api/bonvin/*; hub admins only (owners' IDs, title deed, leases).
//
// Firestore (under workspaces/<team>):
//   bonvinFiles/<id>   { id, name, path, group, order, mime, size, sha1, mtime, key, previewKey }
//   bonvinMeta/data    { json }   the dossier (facts, owners, tenancies, statement) as one JSON string
// The bytes live in the Storage bucket under bonvin/<id>/… — never in the repo or the Vercel bundle.
// bonvin-sync.mjs on the laptop keeps both equal to the Dropbox folder; the page only reads.

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const STREAM_MAX = 4e6;   // Vercel refuses a function response over 4.5 MB: bigger files go by a short-lived signed link

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, admin } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  let m;

  if (url === '/api/bonvin/files' && req.method === 'GET') {
    const list = (await ws.collection('bonvinFiles').get()).docs.map(d => d.data());
    list.sort((a, b) => (a.order || 0) - (b.order || 0) || a.path.localeCompare(b.path));
    return json(res, 200, list);
  }

  if (url === '/api/bonvin/meta' && req.method === 'GET') {
    const d = (await ws.collection('bonvinMeta').doc('data').get()).data();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end((d && d.json) || 'null'); return true;
  }

  // One file (?p=1 = its web-size preview), inline; the cookie authenticates a GET (img src, new tab)
  if ((m = url.match(/^\/api\/bonvin\/files\/([\w-]+)$/)) && req.method === 'GET') {
    const d = (await ws.collection('bonvinFiles').doc(m[1]).get()).data();
    if (!d) return json(res, 404, { error: 'no such file' });
    const q = new URL(req.url, 'http://x').searchParams;
    const preview = q.get('p') === '1' && d.previewKey;
    const dl = q.get('dl') === '1';
    const disp = `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.name)}`;
    const file = admin.storage().bucket().file(preview ? d.previewKey : d.key);
    if (!preview && d.size > STREAM_MAX) {
      const [link] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60e3, responseDisposition: disp, responseType: d.mime });
      res.writeHead(302, { Location: link, 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    let buf;
    try { [buf] = await file.download(); } catch (e) { return json(res, 404, { error: 'file gone from storage' }); }
    res.writeHead(200, { 'Content-Type': preview ? 'image/jpeg' : (d.mime || 'application/octet-stream'),
      'Content-Disposition': disp, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable' });   // the URL carries the checksum
    res.end(buf);
    return true;
  }
  return false;
}

// The renter's share page (/bonvin/shop) — PUBLIC, no sign-in. Only files the sync flagged public
// (plans, 2021 photos, office drawings) and only the dossier's "shop" block; never owners, deeds, leases or rents.
async function handlePublic(req, res, url, ctx) {
  const { db, TEAM_ID, admin } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  let m;
  if (url === '/api/bonvin/public' && req.method === 'GET') {
    const files = (await ws.collection('bonvinFiles').where('public', '==', true).get()).docs.map(d => d.data())
      .map(({ id, name, path, group, order, mime, size, sha1, previewKey }) => ({ id, name, path, group, order, mime, size, sha1, previewKey: !!previewKey }))
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.path.localeCompare(b.path));
    const d = (await ws.collection('bonvinMeta').doc('data').get()).data();
    let shop = null; try { shop = JSON.parse(d.json).shop || null; } catch {}
    return json(res, 200, { shop, files });
  }
  if ((m = url.match(/^\/api\/bonvin\/public\/([\w-]+)$/)) && req.method === 'GET') {
    const d = (await ws.collection('bonvinFiles').doc(m[1]).get()).data();
    if (!d || d.public !== true) return json(res, 404, { error: 'no such file' });
    req.url = req.url.replace('/api/bonvin/public/', '/api/bonvin/files/');
    return handle(req, res, '/api/bonvin/files/' + m[1], null, ctx);
  }
  return false;
}

module.exports = { handle, handlePublic };
