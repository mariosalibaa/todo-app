// One file, stored once: the Storage bucket when it exists, else a Firestore document of its
// own (never on a line — the grids read lines by the thousand). Lifted from the tx docs route
// (accounts.js) for the site page; both keep the same { key, store } record.
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();

async function saveFile(ctx, { buf, mime, name, key, who, meta }) {
  const { admin, db, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const id = newId();
  let store = 'bucket';
  try {
    const bk = admin.storage().bucket();
    const [live] = await bk.exists();
    if (!live) throw new Error('bucket not created');
    await bk.file(key).save(buf, { contentType: mime, resumable: false, metadata: { metadata: { ...(meta || {}), by: who } } });
  } catch (e) {
    if (buf.length > 700e3) throw new Error('Firebase Storage is not enabled for this project, so a file must stay under 700 KB. Enable Storage in the Firebase console and any size will work.');
    await ws.collection('txDocs').doc(id).set({ ...(meta || {}), mime, name: String(name || '').slice(0, 120), b64: buf.toString('base64'), at: now(), by: who });
    store = 'firestore';
    console.warn('file kept in Firestore (Storage not enabled):', e.message);
  }
  return { id, name: String(name || '').slice(0, 120), mime, size: buf.length, key, store, at: now(), by: who };
}

// req is optional: with it, byte ranges are honoured — iOS Safari refuses to play <audio>/<video> from a server
// that answers a Range request with a plain 200 (the site's voice notes spun forever on the iPhone, 2026-09-12)
async function streamFile(ctx, doc, res, req) {
  const { admin, db, TEAM_ID } = ctx;
  let buf;
  if (doc.store === 'firestore') {
    const d = await db.collection('workspaces').doc(TEAM_ID).collection('txDocs').doc(doc.id).get();
    if (d.exists) buf = Buffer.from(d.data().b64 || '', 'base64');
  } else {
    try { [buf] = await admin.storage().bucket().file(doc.key).download(); } catch (e) { buf = null; }
  }
  if (!buf) { res.writeHead(404); res.end('file gone'); return; }
  const safeName = (doc.name || 'file').replace(/[^\w.-]/g, '_');
  const head = { 'Content-Type': doc.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="' + safeName + '"' };
  const range = req && req.headers && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : Math.max(0, buf.length - +range[2]);
    let end = range[1] && range[2] ? Math.min(+range[2], buf.length - 1) : buf.length - 1;
    if (start > end || start >= buf.length) { res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length }); res.end(); return; }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
    res.end(buf.subarray(start, end + 1)); return;
  }
  res.writeHead(200, { ...head, 'Content-Length': buf.length });
  res.end(buf);
}
async function deleteFile(ctx, doc) {
  const { admin, db, TEAM_ID } = ctx;
  if (doc.store === 'firestore') await db.collection('workspaces').doc(TEAM_ID).collection('txDocs').doc(doc.id).delete();
  else await admin.storage().bucket().file(doc.key).delete({ ignoreNotFound: true });
}
module.exports = { saveFile, streamFile, deleteFile };
