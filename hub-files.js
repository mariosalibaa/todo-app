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

async function streamFile(ctx, doc, res) {
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
  res.writeHead(200, { 'Content-Type': doc.mime || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="' + safeName + '"' });
  res.end(buf);
}
module.exports = { saveFile, streamFile };
