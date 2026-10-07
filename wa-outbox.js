// WhatsApp outbox (Mario 2026-10-07: "push data while the laptop is offline … and when we are online complete the mission").
// The WhatsApp windows live on the laptop; when it is off, the hub keeps what Mario wants sent and the laptop sends it
// when it is back (wa-contacts/outbox.mjs, every minute), one at a time through the ban-safety guard.
//
//   Firestore workspaces/<team>/waOutbox/<id>  { id, line '03165168'|'70165168', jid, name, text, sendAt, status, createdAt, createdBy,
//                                                claimedAt, sentAt, keyId, error }
//     status: queued → sending → sent | failed | check (sent but not confirmed — never retried) | held (older than HOLD_H,
//             waits for Mario's "send anyway") | cancelled
//   Firestore workspaces/<team>/meta/waChats-<line>  { at, chats: [{ jid, name, lastTs, lastText }] } — the laptop's chat list mirror
//
//   GET  /api/wa-outbox?line=           Mario: the queue + the mirrored chats + when the laptop was last seen
//   POST /api/wa-outbox                 Mario: { line, jid, name, text, sendAt? } → queued
//   POST /api/wa-outbox/<id>/cancel     Mario
//   POST /api/wa-outbox/<id>/release    Mario: a held one goes out anyway
//   GET  /api/wa-outbox/pending         laptop: what is due now (and marks stale ones held)
//   POST /api/wa-outbox/<id>/claim      laptop: queued → sending (only one sender wins)
//   POST /api/wa-outbox/<id>/result     laptop: { status: sent|failed|check, keyId?, error? }
//   POST /api/wa-outbox/chats           laptop: { line, chats }
const HOLD_H = 12;   // a message queued longer ago than this waits for "send anyway" instead of going out on its own

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const readBody = (req, max = 1e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});
const LINES = ['03165168', '70165168'];

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access, machine } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID), col = ws.collection('waOutbox');
  const path = url.split('?')[0], q = new URL(req.url, 'http://x').searchParams;
  const admin = !!(access && access.admin);
  let m;

  // ── the laptop ──
  if (path === '/api/wa-outbox/pending' && req.method === 'GET') {
    if (!machine) return json(res, 403, { error: 'laptop only' });
    const snap = await col.where('status', '==', 'queued').get();
    const due = [], t = Date.now();
    for (const d of snap.docs) {
      const x = d.data();
      if (Date.parse(x.sendAt || x.createdAt) > t) continue;                       // a scheduled one, not yet
      if (!x.released && t - Date.parse(x.sendAt || x.createdAt) > HOLD_H * 3600e3) { await d.ref.set({ status: 'held', heldAt: now() }, { merge: true }); continue; }
      due.push(x);
    }
    due.sort((a, b) => String(a.sendAt || a.createdAt).localeCompare(String(b.sendAt || b.createdAt)));
    return json(res, 200, { items: due });
  }
  if ((m = path.match(/^\/api\/wa-outbox\/([\w-]+)\/claim$/)) && req.method === 'POST') {
    if (!machine) return json(res, 403, { error: 'laptop only' });
    const ref = col.doc(m[1]);
    const ok = await db.runTransaction(async tx => { const d = await tx.get(ref); if (!d.exists || d.data().status !== 'queued') return false; tx.update(ref, { status: 'sending', claimedAt: now() }); return true; });
    return json(res, ok ? 200 : 409, { ok });
  }
  if ((m = path.match(/^\/api\/wa-outbox\/([\w-]+)\/result$/)) && req.method === 'POST') {
    if (!machine) return json(res, 403, { error: 'laptop only' });
    const b = await readBody(req);
    const status = ['sent', 'failed', 'check'].includes(b.status) ? b.status : 'failed';
    await col.doc(m[1]).set({ status, sentAt: status === 'sent' ? now() : null, keyId: b.keyId || null, error: b.error ? String(b.error).slice(0, 300) : null, doneAt: now() }, { merge: true });
    return json(res, 200, { ok: true });
  }
  if (path === '/api/wa-outbox/chats' && req.method === 'POST') {
    if (!machine) return json(res, 403, { error: 'laptop only' });
    const b = await readBody(req, 2e6);
    if (!LINES.includes(b.line)) return json(res, 400, { error: 'line' });
    const chats = (Array.isArray(b.chats) ? b.chats : []).slice(0, 400).map(c => ({ jid: String(c.jid || ''), name: String(c.name || '').slice(0, 80), lastTs: +c.lastTs || 0, lastText: String(c.lastText || '').slice(0, 80), group: !!c.group })).filter(c => c.jid);
    await ws.collection('meta').doc('waChats-' + b.line).set({ at: now(), chats });
    return json(res, 200, { ok: true, n: chats.length });
  }

  // ── Mario ──
  if (!admin) return json(res, 403, { error: 'Mario only' });
  if (path === '/api/wa-outbox' && req.method === 'GET') {
    const line = LINES.includes(q.get('line')) ? q.get('line') : '03165168';
    const [items, chats, beat] = await Promise.all([
      col.where('line', '==', line).get().then(s => s.docs.map(d => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60)),
      ws.collection('meta').doc('waChats-' + line).get().then(d => d.data() || { chats: [] }),
      ws.collection('meta').doc('whatsappArchive').get().then(d => d.data() || {}),
    ]);
    return json(res, 200, { line, items, chats: chats.chats || [], chatsAt: chats.at || null, laptopAt: beat.at || null, holdHours: HOLD_H });
  }
  if (path === '/api/wa-outbox' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!LINES.includes(b.line) || !b.jid || !text) return json(res, 400, { error: 'line, chat and text are needed' });
    if (text.length > 4000) return json(res, 400, { error: 'too long' });
    const id = newId();
    const sendAt = b.sendAt && !isNaN(Date.parse(b.sendAt)) ? new Date(b.sendAt).toISOString() : now();
    const doc = { id, line: b.line, jid: String(b.jid), name: String(b.name || '').slice(0, 80), text, sendAt, status: 'queued', createdAt: now(), createdBy: user.email || '' };
    await col.doc(id).set(doc);
    return json(res, 200, doc);
  }
  if ((m = path.match(/^\/api\/wa-outbox\/([\w-]+)\/(cancel|release)$/)) && req.method === 'POST') {
    const ref = col.doc(m[1]); const d = await ref.get();
    if (!d.exists) return json(res, 404, { error: 'no such message' });
    const st = d.data().status;
    if (m[2] === 'cancel') { if (!['queued', 'held'].includes(st)) return json(res, 409, { error: 'already ' + st }); await ref.set({ status: 'cancelled', cancelledAt: now() }, { merge: true }); }
    else { if (st !== 'held') return json(res, 409, { error: 'not held' }); await ref.set({ status: 'queued', released: true, releasedAt: now() }, { merge: true }); }
    return json(res, 200, { ok: true });
  }
  return false;
}

module.exports = { handle, HOLD_H };
