// Decisions — one page per question Mario puts to a partner ("confirm the machine at $25,000?"), opened from a
// link, answered with Approve / Hold + a note, and Mario gets a Telegram the moment it is answered (2026-09-13).
//
//   GET  /api/decisions            admin: all · others: the ones addressed to them
//   POST /api/decisions            admin: { title, amount, currency, lines: [], approvers: [emails], note }
//   GET  /api/decisions/<id>       the decision (approver or admin)
//   POST /api/decisions/<id>/decide  { ok: true|false, note }   approver (email match) or admin
//
// Firestore: workspaces/<team>/decisions/<id> { title, amount, currency, lines, note, approvers, createdBy, createdAt,
//   status: 'open' | 'approved' | 'held', decision: { by, email, ok, note, at } | null }
const crypto = require('crypto');
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', d => s += d).on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }).on('error', no); });
const SITE = 'https://hub.shift-group.co';

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || process.env.ACCOUNTING_CHAT_ID;
  if (!token || !chat) { console.warn('decisions: telegram not configured'); return false; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }) });
    if (!r.ok) console.error('decisions: telegram failed', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('decisions: telegram', e.message); return false; }
}

async function handle(req, res, url, user, ctx) {
  const path = url.split('?')[0];
  if (!path.startsWith('/api/decisions')) return false;
  const col = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('decisions');
  const me = (ctx.access && ctx.access.email || '').toLowerCase(), admin = !!(ctx.access && ctx.access.admin);
  const mine = d => admin || (d.approvers || []).map(x => x.toLowerCase()).includes(me);

  if (path === '/api/decisions' && req.method === 'GET') {
    const snap = await col.orderBy('createdAt', 'desc').limit(100).get();
    return json(res, 200, snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(mine));
  }
  if (path === '/api/decisions' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    const id = (String(b.id || '').replace(/[^\w-]/g, '') || crypto.randomBytes(5).toString('hex'));
    const doc = { title: String(b.title || '').slice(0, 200), amount: +b.amount || 0, currency: String(b.currency || 'USD').slice(0, 5),
      lines: Array.isArray(b.lines) ? b.lines.map(x => String(x).slice(0, 300)).slice(0, 30) : [], note: String(b.note || '').slice(0, 2000),
      approvers: Array.isArray(b.approvers) ? b.approvers.map(x => String(x).toLowerCase()) : [], approverName: String(b.approverName || '').slice(0, 80),
      createdBy: me, createdAt: new Date().toISOString(), status: 'open', decision: null };
    await col.doc(id).set(doc);
    return json(res, 200, { id, url: `${SITE}/decide/${id}`, ...doc });
  }
  const m = path.match(/^\/api\/decisions\/([\w-]+)(\/decide)?$/);
  if (!m) return false;
  const ref = col.doc(m[1]), snap = await ref.get();
  if (!snap.exists) return json(res, 404, { error: 'no such decision' });
  const d = { id: snap.id, ...snap.data() };
  if (!mine(d)) return json(res, 403, { error: 'not addressed to you' });
  if (!m[2] && req.method === 'GET') return json(res, 200, d);
  if (!m[2] && req.method === 'DELETE') { if (!admin) return json(res, 403, { error: 'admin only' }); await ref.delete(); return json(res, 200, { ok: true }); }
  if (m[2] && req.method === 'POST') {
    const b = await readBody(req);
    const ok = !!b.ok, note = String(b.note || '').slice(0, 1000);
    const decision = { by: user.name || user.displayName || me, email: me, ok, note, at: new Date().toISOString() };
    await ref.set({ status: ok ? 'approved' : 'held', decision }, { merge: true });
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    await telegram(`${ok ? '✅ APPROVED' : '⏸ ON HOLD'} — ${d.title}\n${d.amount ? `${d.currency} ${d.amount.toLocaleString('en-US')}\n` : ''}by ${decision.by} (${me}) · ${when}${note ? `\nnote: ${note}` : ''}\n${SITE}/decide/${d.id}`);
    return json(res, 200, { ok: true, status: ok ? 'approved' : 'held', decision });
  }
  return false;
}
module.exports = { handle };
