// /site — the conversation that replaces the WhatsApp groups. Mounted by server.js under
// /api/site/*; ctx = { db, admin, TEAM_ID, odooCall, access }.
// A post is saved first and answered at once; the parse runs after and hangs a SUGGESTION line
// on the right ledger (review + excluded, exactly like a WhatsApp proposal) — Mario's ✓ on the
// Day report / Accounts / Statements is the only way a line becomes real (Mario, 2026-09-12).
const acc = require('./accounts');
const files = require('./hub-files');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const money = n => Math.round((+n || 0) * 100) / 100;
const beirutDay = d => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const MARIO_CASH = 'mario-cash';   // the default payer (see Global Constraints)
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
// Mario, 2026-09-12: whitelist by kind — an SVG (or anything else) never gets posted
const MIME_OK = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  voice: ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-m4a'],
};
const readBody = (req, max = 35e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});

// same bytes streamFile would send, without a real response — used by /flip to re-read a file
async function readBytes(ctx, doc) {
  const { admin, db, TEAM_ID } = ctx;
  if (doc.store === 'firestore') {
    const d = await db.collection('workspaces').doc(TEAM_ID).collection('txDocs').doc(doc.id).get();
    return d.exists ? Buffer.from(d.data().b64 || '', 'base64') : null;
  }
  try { const [buf] = await admin.storage().bucket().file(doc.key).download(); return buf; } catch { return null; }
}

// which threads this caller may open
async function threadsFor(ctx) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived);
  const all = [{ id: 'general', name: 'General', kind: 'general' }, ...people.map(p => ({ id: p.id, name: p.name, kind: 'worker' }))];
  return ctx.access.admin ? all : all.filter(t => t.kind === 'worker' && t.id === ctx.access.account);
}

let refCache = { at: 0, analytics: [], partners: [] };
async function refs(ctx) {
  if (Date.now() - refCache.at < 600e3) return refCache;
  const [analytics, partners] = await Promise.all([
    ctx.odooCall('account.analytic.account', 'search_read', [[['active', '=', true]]], { fields: ['name'], context: CTX, limit: 500 }),
    ctx.odooCall('res.partner', 'search_read', [[['supplier_rank', '>', 0]]], { fields: ['name'], context: CTX, limit: 2000 }),
  ]);
  refCache = { at: Date.now(), analytics, partners };
  return refCache;
}

// the suggestion line for a post; `target` = the ledger account id
async function writeLine(ctx, ws, post, target, fields) {
  const a = await acc.resolve(ws, target);
  if (!a) throw new Error('no ledger ' + target);
  const id = 'site-' + post.id;
  const t = { id, src: 'site', postId: post.id, thread: post.thread, date: post.date, ref: '', service: 'Shift WhatsApp', phone: '',
    description: String(fields.description || post.text || '').slice(0, 160),
    debit: fields.side === 'debit' ? money(fields.amount) : 0, credit: fields.side === 'credit' ? money(fields.amount) : 0,
    analyticId: fields.analytic ? fields.analytic.id : null, analyticName: fields.analytic ? fields.analytic.name : '', analyticSrc: fields.analytic ? 'site' : '',
    partnerId: fields.partner ? fields.partner.id : (a.odooPartner ? a.odooPartner.id : null), partnerName: fields.partner ? fields.partner.name : (a.odooPartner ? a.odooPartner.name : ''), partnerSrc: fields.partner ? 'site' : (a.odooPartner ? 'auto' : ''),
    note: String(fields.note || ''), noteSrc: fields.note ? 'site' : '',
    review: true, excluded: true, waAccepted: false, waFrom: post.byAdmin ? 'mario' : 'them', waAt: post.at,
    docs: post.file ? [post.file] : [], createdAt: now(), createdBy: post.by, updatedAt: now(), updatedBy: post.by };
  // Mario, 2026-09-12: only stamp nature when the caller named one — otherwise leave it out so
  // the booking's own natureOf decides (dropped the 'labour' default that used to hide here)
  if (fields.nature) { t.nature = fields.nature; t.natureSrc = 'site'; }
  if (!t.debit && !t.credit) { t.noBook = true; t.ask = 'no amount yet — price this before booking'; }
  await acc.txCol(a).doc(id).set(t);
  return { accountId: a.id, txId: id, state: 'waiting' };
}

// after the post is stored: read it, decide, write the line, record the outcome on the post
async function digest(ctx, ws, ref, post, buf) {
  const isGeneral = post.thread === 'general';
  const fromMe = !!post.byAdmin;   // the poster decides the side, not whoever happens to call digest (Mario, 2026-09-12)
  try {
    let text = post.text || '', parsed = {}, line = null;
    if (post.kind === 'voice') { text = await parse.whisper(buf, post.file.mime); parsed.transcript = text; }
    if (post.kind === 'photo' || post.kind === 'video') {
      if (post.kind === 'photo') Object.assign(parsed, await parse.visionRead(buf, post.file.mime));
      else parsed.receipt = false;
      if (post.receiptOverride != null) parsed.receipt = !!post.receiptOverride;
      if (parsed.receipt && (parsed.amount || post.receiptOverride === true)) {
        const { partners, analytics } = await refs(ctx);
        const partner = parsed.vendor ? parse.matchName(parsed.vendor, partners) : null;
        // a caption on a receipt photo rides along on the same line instead of spawning a second one (see below)
        line = await writeLine(ctx, ws, post, isGeneral ? MARIO_CASH : post.thread,
          { amount: parsed.amount, side: isGeneral ? 'credit' : 'debit', description: [parsed.vendor, parsed.note, text].filter(Boolean).join(' · '), partner, analytic: null, nature: 'expense' });   // a receipt is always an expense — bookable right after ✓
      }
      // a site photo/video = progress; it is kept on the post and the Day report shows it under the day (part 2 hangs it on the attendance line)
    }
    if (text && !line) {
      const { partners, analytics } = await refs(ctx);
      if (isGeneral) {
        const c = await parse.claudeParse(text, { analytics, partners, accounts: (await acc.listAccounts(ws)).filter(a => !a.daily && !a.archived) });
        Object.assign(parsed, c);
        if (c.amount) {
          const partner = c.partner ? parse.matchName(c.partner, partners) : null;
          const analytic = c.project ? parse.matchName(c.project, analytics) : null;
          const paidFrom = c.paidFrom ? parse.matchName(c.paidFrom, (await acc.listAccounts(ws)).map(a => ({ id: a.id, name: a.name }))) : null;
          line = await writeLine(ctx, ws, post, paidFrom ? paidFrom.id : MARIO_CASH,
            { amount: c.amount, side: 'credit', description: [partner ? partner.name : c.partner, c.note].filter(Boolean).join(' · '), partner, analytic, note: '' });
        }
      } else {
        const a = await acc.resolve(ws, post.thread);
        const q = parse.quickParse(text, { fromMe, owner: (a && a.owner) || '', lbpRate: a && a.whatsapp && a.whatsapp.lbpRate });
        Object.assign(parsed, q || {});
        if (q && q.amount && q.side) {
          const analytic = parse.matchName(text, analytics);
          line = await writeLine(ctx, ws, post, post.thread, { amount: q.amount, side: q.side, description: text, analytic });
        }
      }
    }
    if (!line) {   // the picture/caption decided against a line — make sure a stale one doesn't survive (e.g. a re-run after /flip)
      try {
        const target = isGeneral ? MARIO_CASH : post.thread;
        const a = await acc.resolve(ws, target);
        if (a) await acc.txCol(a).doc('site-' + post.id).delete();
      } catch (e) { console.error('site digest stale-line delete', post.id, e.message); }
    }
    await ref.set({ parsed, line, error: null, digestedAt: now(), digesting: false }, { merge: true });
  } catch (e) {
    console.error('site digest', post.id, e.message);
    await ref.set({ error: String(e.message || e).slice(0, 200), digestedAt: now(), digesting: false }, { merge: true });
  }
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  let m;

  if (url === '/api/site/threads' && req.method === 'GET') {
    const ts = await threadsFor(ctx);
    await Promise.all(ts.map(async t => {   // one round trip for all threads, not one each
      const last = await ws.collection('site').doc(t.id).collection('posts').orderBy('at', 'desc').limit(1).get();
      t.last = last.empty ? '' : last.docs[0].data().at;
    }));
    return json(res, 200, ts);
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts$/)) && req.method === 'GET') {
    const thread = m[1];
    if (!(await threadsFor(ctx)).some(t => t.id === thread)) return json(res, 403, { error: 'not your thread' });
    const q = new URL(req.url, 'http://x').searchParams;
    let qry = ws.collection('site').doc(thread).collection('posts').orderBy('at', 'desc').limit(Math.min(200, +(q.get('limit') || 50)));
    if (q.get('before')) qry = qry.where('at', '<', q.get('before'));
    const snap = await qry.get();
    const out = snap.docs.map(d => d.data()).reverse();
    // the line's fate is decided on the ledger (✓ / ✕ on the Day report or the grid), so the
    // post reads it from there: waiting → accepted / dismissed
    await Promise.all(out.filter(p => p.line).map(async p => {
      const a = await acc.resolve(ws, p.line.accountId); if (!a) return;
      const t = (await acc.txCol(a).doc(p.line.txId).get()).data();
      p.line.state = !t ? 'dismissed' : t.waAccepted ? 'accepted' : t.excluded && !t.review ? 'dismissed' : 'waiting';
    }));
    return json(res, 200, { posts: out });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts$/)) && req.method === 'POST') {
    const thread = m[1];
    if (!(await threadsFor(ctx)).some(t => t.id === thread)) return json(res, 403, { error: 'not your thread' });
    const b = await readBody(req);
    const kind = ['text', 'photo', 'video', 'voice'].includes(b.kind) ? b.kind : 'text';
    const text = String(b.text || '').trim().slice(0, 2000);
    const id = newId();
    const post = { id, thread, by: who, at: now(), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : beirutDay(), kind, text, byAdmin: !!access.admin };
    let buf = null;
    if (kind !== 'text') {
      const raw = String(b.dataBase64 || '').replace(/^data:[^,]*,/, '');
      buf = Buffer.from(raw, 'base64');
      if (!buf.length) return json(res, 400, { error: 'no file' });
      if (buf.length > 25e6) return json(res, 400, { error: 'the file is larger than 25 MB' });
      const mime = String(b.mime || 'application/octet-stream').slice(0, 80);
      const bareMime = mime.split(';')[0].trim();
      if (!(MIME_OK[kind] || []).includes(bareMime)) return json(res, 400, { error: 'that file type cannot be posted' });
      const ext = (String(b.name || '').match(/\.([a-z0-9]{1,5})$/i) || [, mime.split('/')[1] || 'bin'])[1].toLowerCase();
      try {
        post.file = await files.saveFile(ctx, { buf, mime, name: b.name || (kind + '.' + ext), key: `site/${thread}/${id}.${ext}`, who, meta: { thread, post: id } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    } else if (!text) return json(res, 400, { error: 'nothing to post' });
    const ref = ws.collection('site').doc(thread).collection('posts').doc(id);
    await ref.set(post);
    return json(res, 200, post);   // the caller drives the parse via POST .../digest — Vercel can freeze a function right after the reply (Mario, 2026-09-12)
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/file$/)) && req.method === 'GET') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const d = await ws.collection('site').doc(m[1]).collection('posts').doc(m[2]).get();
    if (!d.exists || !d.data().file) return json(res, 404, { error: 'no file' });
    await files.streamFile(ctx, d.data().file, res, req);
    return true;
  }

  // delete a message the WhatsApp way (Mario, 2026-09-12): the post stays as "This message was deleted" — text, file
  // and parse are wiped, the file is removed from storage, and a suggested ledger line that was never accepted goes
  // with it. An accepted line is real accounting: the post is refused until Mario undoes it on the ledger.
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)$/)) && req.method === 'DELETE') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    if (post.by !== who && !ctx.access.admin) return json(res, 403, { error: 'only your own messages' });
    if (post.line) {
      const a = await acc.resolve(ws, post.line.accountId);
      const t = a ? (await acc.txCol(a).doc(post.line.txId).get()).data() : null;
      if (t && t.waAccepted) return json(res, 409, { error: 'this message became an accepted ledger line — undo it on the ledger first' });
      if (t) await acc.txCol(a).doc(post.line.txId).delete().catch(() => {});
    }
    if (post.file) await files.deleteFile(ctx, post.file).catch(() => {});
    const gone = { id: post.id, thread: post.thread, by: post.by, at: post.at, date: post.date, kind: 'deleted', deleted: true, deletedAt: now(), deletedBy: who };
    await ref.set(gone);
    return json(res, 200, gone);
  }

  // read the fresh Claude parse for a post again, synchronously — the caller waits for the answer
  // instead of the fire-and-forget the /posts route used to do (Vercel can freeze a function right after the reply)
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/digest$/)) && req.method === 'POST') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    const b = await readBody(req);
    if (post.digestedAt && !b.force) return json(res, 200, post);
    // one read at a time (a double tap, a retry) — unless the last one died mid-way (a stale flag, > 2 min)
    if (post.digesting && !b.force && post.digestingAt && Date.now() - Date.parse(post.digestingAt) < 120e3) return json(res, 409, { error: 'still reading — try again in a moment' });
    // a forced re-read starts clean: the line it wrote before may sit on another ledger (paidFrom)
    if (b.force && post.line) { const a = await acc.resolve(ws, post.line.accountId); if (a) await acc.txCol(a).doc(post.line.txId).delete().catch(() => {}); }
    let buf = null;
    if (post.file) { try { buf = await readBytes(ctx, post.file); } catch { buf = null; } }
    await ref.set({ digesting: true, digestingAt: now() }, { merge: true });
    await digest(ctx, ws, ref, { ...post, line: null }, buf);
    return json(res, 200, (await ref.get()).data());
  }

  // receipt ↔ progress: the worker (or Mario) says what the picture is; the line follows
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/flip$/)) && req.method === 'POST') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    if (post.kind !== 'photo' && post.kind !== 'video') return json(res, 400, { error: 'not a picture' });
    if (post.digesting && post.digestingAt && Date.now() - Date.parse(post.digestingAt) < 120e3) return json(res, 409, { error: 'still reading the picture — try again in a moment' });
    if (post.line) { const a = await acc.resolve(ws, post.line.accountId); if (a) await acc.txCol(a).doc('site-' + post.id).delete(); }
    const receiptOverride = !(post.receiptOverride != null ? post.receiptOverride : (post.parsed && post.parsed.receipt));
    await ref.set({ receiptOverride, line: null, parsed: {}, error: null, digestedAt: null }, { merge: true });
    const fresh = { ...post, receiptOverride, line: null, parsed: {}, error: null, digestedAt: null };
    let buf = null;
    if (post.file) { try { buf = await readBytes(ctx, post.file); } catch { buf = null; } }
    await ref.set({ digesting: true, digestingAt: now() }, { merge: true });
    await digest(ctx, ws, ref, fresh, buf);
    return json(res, 200, (await ref.get()).data());
  }

  return false;
}
module.exports = { handle };
