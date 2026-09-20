// CRM — every client conversation in one place (Mario, 2026-09-14): WhatsApp on the Shift Development line
// (70 165 168, read by wa-contacts/crm-read.mjs off the second daemon), Instagram DMs and Messenger through
// Meta's webhook, the website form (already an Odoo lead). One card per lead: stage, owner, next action, the
// whole conversation under it, and a button that opens / creates the Odoo crm.lead.
//
//   POST  /api/crm/ingest                 machine key: { source, leads: [{ id, phone, name, pushname, labels, messages: [{ id, at, from, text, type }] }] }
//   GET   /api/crm/leads                  app crm: the list (newest activity first)
//   GET   /api/crm/leads/<id>             one lead + its messages
//   POST  /api/crm/leads                  add a client by hand: { name, phone, channel, interest, … } (a call, a visit, a referral)
//   GET   /api/crm/options                Odoo partners + projects (analytic accounts) + companies, for the pickers
//   PATCH /api/crm/leads/<id>             { stage, owner, next, nextAt, interest, notes, name, partnerId, partnerName, projectId, projectName, company, source, budget, location }
//   POST  /api/crm/leads/<id>/odoo        create the Odoo crm.lead (or link the one whose phone matches)
//   GET/POST /api/meta/webhook            Meta (Instagram + Messenger) — verify + receive
//
// Firestore: workspaces/<team>/crm/<id> { channel, phone, name, pushname, labels, stage, owner, next, nextAt, interest,
//   notes, odooLeadId, firstAt, lastAt, lastText, lastFrom, unread, msgCount } · messages/<msgId> { at, from, text, type }
const crypto = require('crypto');
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', d => s += d).on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }).on('error', no); });
const readRaw = req => new Promise((ok, no) => { let s = ''; req.on('data', d => s += d).on('end', () => ok(s)).on('error', no); });
const STAGES = ['new', 'contacted', 'visit', 'offer', 'won', 'lost'];
const SITE = 'https://hub.shift-group.co';
// Odoo CRM the website form already writes to (ajaltoun-landing/config.mjs): SARL, team 5, stage New, Mario
const ODOO_CRM = { companyId: 10, teamId: 5, stageId: 1, userId: 2 };

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || process.env.ACCOUNTING_CHAT_ID;
  if (!token || !chat) return false;
  try { const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }) }); return r.ok; }
  catch (e) { return false; }
}
const now = () => new Date().toISOString();
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// one batch of messages for one lead: upsert the card, add the messages, count what is new from them
async function ingestLead(col, lead, source) {
  const id = String(lead.id || lead.phone || '').replace(/[^\w+-]/g, '');
  if (!id) return null;
  const ref = col.doc(id); const snap = await ref.get(); const cur = snap.exists ? snap.data() : null;
  const msgs = (lead.messages || []).filter(m => m && m.id && m.at).sort((a, b) => a.at < b.at ? -1 : 1);
  let added = 0, fromThem = 0, lastIn = null;
  for (const m of msgs) {
    const mref = ref.collection('messages').doc(String(m.id).replace(/[^\w-]/g, '_').slice(0, 120));
    if ((await mref.get()).exists) continue;
    // mid = the message's id in the laptop's live archive (crm-push.mjs): /api/crm/media/<acc>/<mid> shows the file
    await mref.set({ at: m.at, from: m.from === 'us' ? 'us' : 'them', text: String(m.text || '').slice(0, 4000), type: m.type || 'chat', media: !!m.media, source,
      ...(m.mid ? { mid: Number(m.mid), acc: m.acc || 'dev', mime: String(m.mime || ''), fileName: String(m.fileName || ''), duration: Number(m.duration) || 0 } : {}) });
    added++; if (m.from !== 'us') { fromThem++; lastIn = m; }
  }
  const last = msgs[msgs.length - 1];
  const card = {
    channel: lead.channel || (source === 'wa-dev' ? 'whatsapp' : source), phone: lead.phone || (cur && cur.phone) || '',
    name: (cur && cur.nameSrc === 'manual' ? cur.name : (lead.name || lead.pushname || (cur && cur.name) || lead.phone || id)),
    pushname: lead.pushname || (cur && cur.pushname) || '', labels: Array.isArray(lead.labels) ? lead.labels : (cur && cur.labels) || [],
    updatedAt: now(),
  };
  if (!cur) Object.assign(card, { stage: 'new', owner: '', next: '', nextAt: '', interest: '', notes: '', odooLeadId: null, firstAt: (msgs[0] && msgs[0].at) || now(), createdAt: now(), unread: 0, msgCount: 0 });
  if (cur && !cur.firstAt && msgs[0]) card.firstAt = msgs[0].at;
  if (last && (!cur || !cur.lastAt || last.at > cur.lastAt)) Object.assign(card, { lastAt: last.at, lastText: String(last.text || ('[' + (last.type || 'media') + ']')).slice(0, 200), lastFrom: last.from === 'us' ? 'us' : 'them' });
  // unread = messages from them since we last answered (a reply from us resets it)
  const usReplied = msgs.some(m => m.from === 'us');
  card.unread = usReplied && last && last.from === 'us' ? 0 : ((cur && cur.unread) || 0) + fromThem;
  card.msgCount = ((cur && cur.msgCount) || 0) + added;
  await ref.set(card, { merge: true });
  return { id, isNew: !cur, added, fromThem, lastIn, name: card.name, phone: card.phone, channel: card.channel };
}

async function handle(req, res, url, user, ctx) {
  const path = url.split('?')[0];
  const col = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('crm');

  // ── Meta webhook (Instagram DMs + Messenger). No hub auth: Meta signs the body with the app secret. ──
  if (path === '/api/meta/webhook') {
    if (req.method === 'GET') {
      const q = new URL(req.url, SITE).searchParams;   // the server hands over the path without its query
      if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === (process.env.META_VERIFY_TOKEN || 'shift-hub-crm')) { res.writeHead(200); res.end(q.get('hub.challenge') || ''); return true; }
      res.writeHead(403); res.end('bad token'); return true;
    }
    const raw = await readRaw(req);
    const secret = process.env.META_APP_SECRET;
    if (secret) {
      const sig = String(req.headers['x-hub-signature-256'] || '').replace(/^sha256=/, '');
      const mine = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (!sig || sig.length !== mine.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) { res.writeHead(403); res.end('bad signature'); return true; }
    }
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return true; }
    const results = [];
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_echo && !ev.sender) continue;
        const channel = body.object === 'instagram' ? 'instagram' : 'facebook';
        const them = ev.message.is_echo ? ev.recipient.id : ev.sender.id;
        const m = ev.message;
        results.push(await ingestLead(col, { id: (channel === 'instagram' ? 'ig-' : 'fb-') + them, channel, name: '', messages: [{ id: m.mid, at: new Date(ev.timestamp || Date.now()).toISOString(), from: m.is_echo ? 'us' : 'them', text: m.text || '', type: m.attachments ? m.attachments[0].type : 'chat', media: !!m.attachments }] }, channel));
      }
    }
    for (const r of results.filter(Boolean)) if (r.isNew || r.fromThem) await telegram(`${r.isNew ? '🆕 New lead' : '💬 Lead'} on ${r.channel}: ${r.name || r.id}\n${(r.lastIn && r.lastIn.text || '').slice(0, 300)}\n${SITE}/crm/${r.id}`);
    return json(res, 200, { ok: true, n: results.length });
  }

  if (!path.startsWith('/api/crm')) return false;

  // ── machine: the WhatsApp reader posts what it saw ──
  if (path === '/api/crm/ingest' && req.method === 'POST') {
    if (!ctx.machine && !ctx.local) return json(res, 403, { error: 'machine key only' });
    const b = await readBody(req);
    const out = [];
    for (const lead of b.leads || []) { const r = await ingestLead(col, lead, b.source || 'wa-dev'); if (r) out.push(r); }
    // the first import of a line (the history WhatsApp Web holds) is not news — no Telegram for it
    if (!b.initial) for (const r of out) if (r.isNew || r.fromThem) await telegram(`${r.isNew ? '🆕 New lead' : '💬 Lead'} on WhatsApp (Shift Development): ${r.name || r.phone}\n${(r.lastIn && r.lastIn.text || '').slice(0, 300)}\n${SITE}/crm/${r.id}`);
    return json(res, 200, { ok: true, leads: out.length, added: out.reduce((s, r) => s + r.added, 0) });
  }

  if (!(ctx.access.apps || []).includes('crm') && !ctx.access.admin) return json(res, 403, { error: 'no_app', app: 'crm' });

  // a photo / voice note of a conversation: it lives in the laptop's WhatsApp archive, reached through the
  // tunnel that archive-daemon.mjs reports (meta/whatsappArchive: url = Mario's line, urlDev = 70 165 168),
  // with a 10-minute token signed by the shared machine key — an <img src="/api/crm/media/dev/…"> just works
  let mm;
  if ((mm = path.match(/^\/api\/crm\/media\/(dev|main)\/(\d+)$/)) && req.method === 'GET') {
    const key = process.env.ACCOUNTING_API_KEY || '';
    let meta = null;
    try { meta = (await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('whatsappArchive').get()).data(); } catch {}
    const url = meta && (mm[1] === 'dev' ? meta.urlDev : meta.url);
    const fresh = meta && url && Date.now() - Date.parse(meta.at || 0) < 15 * 60000;
    if (!fresh || !key) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('the laptop holding the WhatsApp archive is offline'); return true; }
    const exp = Date.now() + 10 * 60000;
    const sig = crypto.createHmac('sha256', key).update('open:' + exp).digest('hex');
    res.writeHead(302, { Location: `${url}/api/media/${mm[2]}?t=${exp}.${sig}`, 'Cache-Control': 'private, max-age=300' }); res.end();
    return true;
  }

  // pickers: every Odoo partner (name + phone), every analytic account (= project), the companies
  if (path === '/api/crm/options' && req.method === 'GET') {
    const octx = { allowed_company_ids: [2, 7, 10] };
    const [partners, projects] = await Promise.all([
      ctx.odooCall('res.partner', 'search_read', [[['active', '=', true], ['is_company', 'in', [true, false]]]], { fields: ['name', 'phone', 'email'], context: octx, limit: 3000, order: 'name' }),
      ctx.odooCall('account.analytic.account', 'search_read', [[['active', '=', true]]], { fields: ['name', 'company_id'], context: octx, limit: 500, order: 'name' }),
    ]);
    return json(res, 200, { partners: partners.map(p => ({ id: p.id, name: p.name, phone: p.phone || '', email: p.email || '' })),
      projects: projects.map(p => ({ id: p.id, name: p.name, company: p.company_id ? p.company_id[1] : '' })),
      companies: ['Shift Development', 'Shift Group', 'SHIFT GROUP SARL'], sources: ['whatsapp', 'instagram', 'facebook', 'website', 'call', 'visit', 'referral', 'other'] });
  }
  // a client added by hand — someone who called, walked in, or was referred
  if (path === '/api/crm/leads' && req.method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').replace(/[^\d+]/g, ''); const digits = phone.replace(/\D/g, '');
    const id = digits ? digits : 'm-' + crypto.randomBytes(5).toString('hex');
    if ((await col.doc(id).get()).exists) return json(res, 409, { error: 'this number is already a client', id });
    const card = { channel: b.channel || b.source || 'other', source: b.source || b.channel || 'other', phone: digits ? '+' + digits : '', name: String(b.name || '').slice(0, 120) || (digits ? '+' + digits : 'Client'), nameSrc: 'manual',
      stage: STAGES.includes(b.stage) ? b.stage : 'new', owner: String(b.owner || user.name || user.email || '').slice(0, 120), next: String(b.next || '').slice(0, 200), nextAt: String(b.nextAt || '').slice(0, 10),
      interest: String(b.interest || '').slice(0, 200), notes: String(b.notes || '').slice(0, 4000), company: String(b.company || '').slice(0, 60), budget: String(b.budget || '').slice(0, 60), location: String(b.location || '').slice(0, 120),
      partnerId: +b.partnerId || null, partnerName: String(b.partnerName || '').slice(0, 120), projectId: +b.projectId || null, projectName: String(b.projectName || '').slice(0, 120),
      labels: [], odooLeadId: null, firstAt: now(), lastAt: now(), lastText: b.notes ? String(b.notes).slice(0, 200) : 'added by hand', lastFrom: 'us', unread: 0, msgCount: 0, createdAt: now(), createdBy: user.email || '', updatedAt: now() };
    await col.doc(id).set(card);
    return json(res, 200, { ok: true, id });
  }
  if (path === '/api/crm/leads' && req.method === 'GET') {
    const snap = await col.orderBy('lastAt', 'desc').limit(500).get();
    return json(res, 200, snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }
  const m1 = /^\/api\/crm\/leads\/([\w+-]+)$/.exec(path);
  if (m1 && req.method === 'GET') {
    const d = await col.doc(m1[1]).get(); if (!d.exists) return json(res, 404, { error: 'no such lead' });
    const ms = await col.doc(m1[1]).collection('messages').orderBy('at').limit(2000).get();
    return json(res, 200, { id: d.id, ...d.data(), messages: ms.docs.map(x => ({ id: x.id, ...x.data() })) });
  }
  if (m1 && req.method === 'PATCH') {
    const b = await readBody(req); const data = { updatedAt: now(), updatedBy: user.email || '' };
    if (b.stage && STAGES.includes(b.stage)) data.stage = b.stage;
    for (const k of ['owner', 'next', 'nextAt', 'interest', 'notes', 'partnerName', 'projectName', 'company', 'source', 'budget', 'location']) if (k in b) data[k] = String(b[k] || '').slice(0, k === 'notes' ? 4000 : 200);
    for (const k of ['partnerId', 'projectId']) if (k in b) data[k] = +b[k] || null;
    if ('name' in b) { data.name = String(b.name || '').slice(0, 120); data.nameSrc = 'manual'; }
    if ('unread' in b) data.unread = +b.unread || 0;
    await col.doc(m1[1]).set(data, { merge: true });
    return json(res, 200, { ok: true });
  }
  const m2 = /^\/api\/crm\/leads\/([\w+-]+)\/odoo$/.exec(path);
  if (m2 && req.method === 'POST') {
    const d = await col.doc(m2[1]).get(); if (!d.exists) return json(res, 404, { error: 'no such lead' });
    const L = d.data(); const octx = { allowed_company_ids: [ODOO_CRM.companyId] };
    let leadId = L.odooLeadId;
    if (!leadId && L.phone) {
      const digits = L.phone.replace(/\D/g, '').slice(-8);
      const found = await ctx.odooCall('crm.lead', 'search_read', [[['phone', 'ilike', digits]]], { fields: ['id', 'name'], context: octx, limit: 1 });
      if (found.length) leadId = found[0].id;
    }
    if (!leadId) {
      const ms = await col.doc(m2[1]).collection('messages').orderBy('at').limit(30).get();
      const html = `<p>From ${esc(L.channel)} (${esc(L.phone || L.id)}) — first messages:</p><ul>${ms.docs.map(x => x.data()).map(m => `<li><b>${m.from === 'us' ? 'Shift' : esc(L.name)}</b> ${esc(m.at.slice(0, 16).replace('T', ' '))}: ${esc(m.text)}</li>`).join('')}</ul><p>${esc(SITE + '/crm/' + d.id)}</p>`;
      leadId = await ctx.odooCall('crm.lead', 'create', [{ name: `${L.channel === 'whatsapp' ? 'WhatsApp' : L.channel} — ${L.name || L.phone}${L.projectName ? ' · ' + L.projectName : ''}`, contact_name: L.name || '', phone: L.phone || false, partner_id: L.partnerId || false, description: html, type: 'opportunity',
        stage_id: ODOO_CRM.stageId, team_id: ODOO_CRM.teamId, company_id: ODOO_CRM.companyId, user_id: ODOO_CRM.userId }], { context: octx });
    }
    await col.doc(m2[1]).set({ odooLeadId: leadId, updatedAt: now() }, { merge: true });
    return json(res, 200, { ok: true, odooLeadId: leadId });
  }
  return json(res, 404, { error: 'not found' });
}
module.exports = { handle, STAGES };
