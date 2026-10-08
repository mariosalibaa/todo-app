// /site — the conversation that replaces the WhatsApp groups. Mounted by server.js under
// /api/site/*; ctx = { db, admin, TEAM_ID, odooCall, access }.
// A post is saved first and answered at once; the parse runs after and hangs a SUGGESTION line
// on the right ledger (review + excluded, exactly like a WhatsApp proposal) — Mario's ✓ on the
// Day report / Accounts / Statements is the only way a line becomes real (Mario, 2026-09-12).
const acc = require('./accounts');
const files = require('./hub-files');
const parse = require('./site-parse');
const attendance = require('./site-attendance');   // part 2: sites, Start/Finish, the self-written day
const siteAgent = require('./site-agent');          // "Shift", the agent member of the chat

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
  doc: ['application/pdf'],
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

// What Odoo says about a booked bill: its own reference and the entries that settled it (the payment).
// Read once — the answer is written back on the line, so the chat does not call Odoo on every load.
async function settlement(ctx, txRef, bm) {
  const ctxAll = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
  const [mv] = await ctx.odooCall('account.move', 'read', [[bm.id], ['name', 'ref', 'move_type', 'payment_state', 'amount_residual', 'invoice_payments_widget']], { context: ctxAll });
  if (!mv) return bm;
  const w = (mv.invoice_payments_widget && mv.invoice_payments_widget.content) || [];
  const ids = [...new Set(w.map(c => c.move_id).filter(Boolean))];
  const names = ids.length ? Object.fromEntries((await ctx.odooCall('account.move', 'read', [ids, ['name', 'ref']], { context: ctxAll })).map(x => [x.id, x])) : {};
  const out = { ...bm, name: mv.name || bm.name, ref: mv.ref || bm.ref || '', paymentState: mv.payment_state || '', residual: mv.amount_residual,
    paidBy: w.map(c => { const sm = names[c.move_id] || {}; return { name: sm.name || c.name || '', ref: sm.ref || '', moveId: c.move_id || null, amount: c.amount, date: c.date || '' }; }) };
  await txRef.set({ bookedMove: out }, { merge: true });
  return out;
}

// which threads this caller may open
async function threadsFor(ctx) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived);
  // "Shift" (the agent) is a thread of its own, pinned under Mario — admin only (site-agent.js)
  const all = [{ id: 'general', name: 'Mario', kind: 'general' }, { id: siteAgent.AGENT, name: 'Shift', kind: 'agent' }, ...people.map(p => ({ id: p.id, name: p.name, kind: 'worker' }))];
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
  const id = 'site-' + post.id + (fields.idSuffix || '');
  const t = { id, src: fields.src || 'site', postId: post.id, thread: post.thread, date: fields.date || post.date, ref: String(fields.ref || ''), service: 'Shift WhatsApp', phone: '',
    description: String(fields.description || post.text || '').slice(0, 160),
    debit: fields.side === 'debit' ? money(fields.amount) : 0, credit: fields.side === 'credit' ? money(fields.amount) : 0,
    analyticId: fields.analytic ? fields.analytic.id : null, analyticName: fields.analytic ? fields.analytic.name : '', analyticSrc: fields.analytic ? 'site' : '',
    partnerId: fields.partner ? fields.partner.id : (a.odooPartner ? a.odooPartner.id : null), partnerName: fields.partner ? fields.partner.name : (a.odooPartner ? a.odooPartner.name : ''), partnerSrc: fields.partner ? 'site' : (a.odooPartner ? 'auto' : ''),
    note: String(fields.note || ''), noteSrc: fields.note ? 'site' : '',
    company: fields.company || '', companySrc: fields.company ? 'site' : '',
    // an official paper (SARL + VAT): the booking reads these two and makes the bill in the SARL
    vat: !!fields.vat, official: !!fields.official,
    review: true, excluded: true, waAccepted: false, waFrom: post.byAdmin ? 'mario' : 'them', waAt: post.at,
    docs: post.file ? [post.file] : [], createdAt: now(), createdBy: post.by, updatedAt: now(), updatedBy: post.by };
  // Mario, 2026-09-12: only stamp nature when the caller named one — otherwise leave it out so
  // the booking's own natureOf decides (dropped the 'labour' default that used to hide here)
  if (fields.nature) { t.nature = fields.nature; t.natureSrc = 'site'; }
  if (!t.debit && !t.credit) { t.noBook = true; t.ask = 'no amount yet — price this before booking'; }
  await acc.txCol(a).doc(id).set(t);
  // the card shows the suggestion straight away, not only after a reload (Mario 2026-10-08: the Attal receipt
  // came back "— set" on partner / company / project although the line carried all three)
  return { accountId: a.id, txId: id, state: 'waiting', debit: t.debit, credit: t.credit, section: '', partnerName: t.partnerName,
    company: t.company, analyticName: t.analyticName, official: !!t.official && !!t.vat, billRef: t.ref };
}

// AI auto-suggest for a receipt (Mario 2026-10-07: "use AI to auto suggest"): who, which project, which company.
// 1. history — the last accepted line on the same ledger whose words share the vendor's name: same partner, project, company
// 2. else Claude picks from Odoo's own partner and project lists, reading the vendor, who it is billed to and the note
// Every pick stays a SUGGESTION (the line waits for ✓, src 'ai'); an exact name match still wins for the partner.
async function suggestFor(ctx, ws, parsed, text, target, partners) {
  const out = { partner: parsed.vendor ? parse.matchName(parsed.vendor, partners) : null, analytic: null, company: '' };
  const words = String(parsed.vendor || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3 && !/^(company|sarl|s\.?a\.?l|ste|group|center|shop|store|station)$/.test(w));
  try {
    const a = await acc.resolve(ws, target);
    if (a && words.length) {
      const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
      const rows = (await acc.txCol(a).where('date', '>=', since).get()).docs.map(d => d.data())
        .filter(t => !t.excluded && (t.analyticId || t.partnerId) && words.some(w => String(t.description || '').toLowerCase().includes(w)))
        .sort((x, y) => String(y.date).localeCompare(String(x.date)));
      const h = rows[0];
      if (h) {
        if (!out.partner && h.partnerId && h.partnerName) out.partner = { id: h.partnerId, name: h.partnerName };
        if (h.analyticId) out.analytic = { id: h.analyticId, name: h.analyticName };
        if (h.company) out.company = h.company;
        if (out.partner && out.analytic) return out;
      }
    }
  } catch (e) { console.error('suggest history:', e.message); }
  // 1b. the vendor is known but this ledger never bought from him: his latest bills in Odoo, any ledger,
  //     say which project the purchases usually go to (Mario 2026-10-08: "based on previous behaviour and entries")
  if (out.partner && out.partner.id && !out.analytic) {
    try {
      const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      const ls = await ctx.odooCall('account.move.line', 'search_read', [[['partner_id', '=', out.partner.id], ['move_id.move_type', '=', 'in_invoice'],
        ['parent_state', '=', 'posted'], ['date', '>=', since], ['display_type', '=', 'product'], ['analytic_distribution', '!=', false]]],
        { fields: ['analytic_distribution', 'date', 'company_id'], order: 'date desc', limit: 12, context: CTX });
      const { analytics } = await refs(ctx), tally = {};
      for (const l of ls) for (const k of Object.keys(l.analytic_distribution || {})) for (const id of String(k).split(',')) tally[id] = (tally[id] || 0) + 1;
      const best = Object.entries(tally).sort((x, y) => y[1] - x[1]).map(([id]) => (analytics || []).find(x => String(x.id) === id)).find(Boolean);
      if (best) out.analytic = { id: best.id, name: best.name };
    } catch (e) { console.error('suggest odoo history:', e.message); }
  }
  // a paper with no VAT is a black ticket: those live in S LB (the official ones get the SARL from officialCompany)
  if (!out.company && parsed.receipt && !parsed.vat) out.company = 'S LB';
  try {
    const { analytics } = await refs(ctx);
    const pick = await parse.anthropic({ model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      system: `You complete one receipt line for Shift (Lebanon). Return JSON only: {"partner":string|null,"project":string|null}.
partner = the supplier, EXACTLY one of PARTNERS when one clearly matches the vendor, else null. project = EXACTLY one of PROJECTS when the receipt says where it was for (an address, a building, a site, a person's home), else null. Never guess wildly.
PARTNERS: ${(partners || []).map(x => x.name).slice(0, 400).join(' | ')}
PROJECTS: ${(analytics || []).map(x => x.name).join(' | ')}`,
      messages: [{ role: 'user', content: `Vendor: ${parsed.vendor || ''}\nBilled to: ${parsed.billedTo || ''}\nWhat: ${parsed.note || ''}\nCaption: ${text || ''}\nNumber: ${parsed.invoiceNo || ''}` }] });
    if (!out.partner && pick.partner) out.partner = (partners || []).find(x => x.name === pick.partner) || null;
    if (!out.analytic && pick.project) { const an = (analytics || []).find(x => x.name === pick.project); if (an) out.analytic = { id: an.id, name: an.name }; }
  } catch (e) { console.error('suggest ai:', e.message); }
  return out;
}

// Fill a waiting line's blank partner / company / project from suggestFor (history → Odoo → Claude); never touches a
// field that already has a value, never an accepted line. Stamps autoSugAt so the chat does not ask again.
async function autoFill(ctx, ws, L, parsed, text, partners) {
  const a = await acc.resolve(ws, L.accountId); if (!a) return {};
  const tref = acc.txCol(a).doc(L.txId), t = (await tref.get()).data();
  if (!t || t.waAccepted || t.bookedMove) return {};
  const sug = await suggestFor(ctx, ws, parsed, text || '', L.accountId, partners || (await refs(ctx)).partners);
  const patch = { autoSugAt: now() };
  // no supplier found anywhere → Misc, so the line is never left without a partner (Mario 2026-10-08: "if not, choose Misc")
  if (!t.partnerId && !sug.partner) { const misc = (partners || (await refs(ctx)).partners).find(x => /^misc\b/i.test(x.name)); if (misc) { sug.partner = { id: misc.id, name: misc.name }; if (parsed && parsed.vendor) patch.vendorRead = String(parsed.vendor).slice(0, 80); } }
  if (!t.partnerId && sug.partner) Object.assign(patch, { partnerId: sug.partner.id, partnerName: sug.partner.name, partnerSrc: 'site' });
  if (!t.analyticId && sug.analytic) Object.assign(patch, { analyticId: sug.analytic.id, analyticName: sug.analytic.name, analyticSrc: 'site' });
  const co = parse.officialCompany(parsed) || sug.company || '';
  if (!t.company && co) Object.assign(patch, { company: co, companySrc: 'site' });
  await tref.set(patch, { merge: true });
  return { patch, sug: { partner: sug.partner && sug.partner.name, project: sug.analytic && sug.analytic.name, company: co } };
}

// the day printed on the paper, when believable — a receipt photographed on 7 Oct for a delivery of 30 Sep is a 30 Sep
// expense (Mario 2026-10-08, Moulin d'Or); else the message's day
function paperDate(parsed, post) {
  const d = parsed && parsed.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return post.date;
  const gap = (Date.parse(post.date) - Date.parse(d)) / 864e5;
  return gap >= 0 && gap <= 90 ? d : post.date;
}

// after the post is stored: read it, decide, write the line, record the outcome on the post
async function digest(ctx, ws, ref, post, buf) {
  const isGeneral = post.thread === 'general';
  const fromMe = !!post.byAdmin;   // the poster decides the side, not whoever happens to call digest (Mario, 2026-09-12)
  try {
    let text = post.text || '', parsed = {}, line = null;
    if (post.kind === 'voice') { text = await parse.whisper(buf, post.file.mime); parsed.transcript = text; }
    if (post.kind === 'doc') {
      // a PDF: the supplier sent the invoice itself, no camera involved
      Object.assign(parsed, parse.toUsd(await parse.pdfRead(buf)));
      if (post.receiptOverride != null) parsed.receipt = !!post.receiptOverride;
      if (parsed.receipt && (parsed.amount || post.receiptOverride === true)) {
        const { partners } = await refs(ctx);
        const { partner, analytic, company: sugCo } = await suggestFor(ctx, ws, parsed, text, isGeneral ? MARIO_CASH : post.thread, partners);
        line = await writeLine(ctx, ws, post, isGeneral ? MARIO_CASH : post.thread,
          { amount: parsed.amount, side: 'debit', date: paperDate(parsed, post), description: [parsed.vendor, parsed.note, parsed.lbpNote, text].filter(Boolean).join(' · '), partner, analytic, nature: 'expense', note: String(text || '').slice(0, 300),
            company: parse.officialCompany(parsed) || sugCo || '', official: !!parse.officialCompany(parsed), vat: !!parsed.vat, ref: parsed.invoiceNo || '' });
      }
    }
    if (post.kind === 'photo' || post.kind === 'video') {
      if (post.kind === 'photo') Object.assign(parsed, parse.toUsd(await parse.visionRead(buf, post.file.mime)));
      else parsed.receipt = false;
      if (post.receiptOverride != null) parsed.receipt = !!post.receiptOverride;
      if (parsed.receipt && (parsed.amount || post.receiptOverride === true)) {
        const { partners, analytics } = await refs(ctx);
        const { partner, analytic, company: sugCo } = await suggestFor(ctx, ws, parsed, text, isGeneral ? MARIO_CASH : post.thread, partners);
        // a caption on a receipt photo rides along on the same line instead of spawning a second one (see below)
        line = await writeLine(ctx, ws, post, isGeneral ? MARIO_CASH : post.thread,
          { amount: parsed.amount, side: 'debit', date: paperDate(parsed, post), description: [parsed.vendor, parsed.note, parsed.lbpNote, text].filter(Boolean).join(' · '), partner, analytic, nature: 'expense', note: String(text || '').slice(0, 300),
            // an official paper (SHIFT GROUP SARL + VAT) belongs to the SARL and carries it by itself
            company: parse.officialCompany(parsed) || sugCo || '', official: !!parse.officialCompany(parsed), vat: !!parsed.vat, ref: parsed.invoiceNo || '' });   // a receipt is always an expense — bookable right after ✓
      }
      // a site photo/video = progress; it is kept on the post and the Day report shows it under the day (part 2 hangs it on the attendance line)
    }
    if (text && !line) {
      const { partners, analytics } = await refs(ctx);
      if (isGeneral) {
        const accts = (await acc.listAccounts(ws)).filter(a => !a.daily && !a.archived), accRefs = accts.map(a => ({ id: a.id, name: a.name }));
        const items = (await parse.claudeParseMany(text, { analytics, partners, accounts: accts, companies: ['S LB', 'SHIFT GROUP SARL (USD)', 'SHIFT DEVELOPMENT', 'Personal'], today: post.date })).map(x => parse.toUsd(x));
        parsed.items = items; if (items[0]) Object.assign(parsed, { amount: items[0].amount, currency: items[0].currency, partner: items[0].partner, project: items[0].project, note: items[0].note });
        const written = [];
        for (let i = 0; i < items.length; i++) {
          const c = items[i];
          const partner = c.partner ? (parse.matchName(c.partner, partners) || partners.find(x => x.name === c.partner) || null) : null;
          const analytic = c.project ? (parse.matchName(c.project, analytics) || analytics.find(x => x.name === c.project) || null) : null;
          const paidFrom = c.paidFrom ? (parse.matchName(c.paidFrom, accRefs) || accRefs.find(a => a.name === c.paidFrom) || null) : null;
          const L = await writeLine(ctx, ws, post, paidFrom ? paidFrom.id : MARIO_CASH, { amount: c.amount, side: c.side, date: c.date, idSuffix: i ? '-' + i : '', company: c.company || '',
            description: [partner ? partner.name : c.partner, c.note, c.lbpNote].filter(Boolean).join(' · '), partner, analytic, note: String(text).slice(0, 300), nature: c.side === 'debit' ? 'expense' : undefined });
          // fill what the note left blank from history / Odoo / Claude — no "suggest" press (Mario 2026-10-08: "auto suggest, I will approve or edit")
          try { await autoFill(ctx, ws, L, { vendor: (partner && partner.name) || c.partner || '', note: c.note, receipt: true, vat: false }, text, partners); } catch (e) { console.error('autofill', post.id, e.message); }
          written.push({ ...L, currency: c.currency });
        }
        line = written[0] || null; if (written.length > 1) parsed.more = written.slice(1);
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
    await ref.set({ parsed, line, more: (parsed.more || []), error: null, digestedAt: now(), digesting: false }, { merge: true });
    if (!isGeneral) { try { await attendance.writeDay(ctx, ws, post.thread, post.date, { who: post.by }); } catch (e) { console.error('site day refresh', post.id, e.message); } }
  } catch (e) {
    console.error('site digest', post.id, e.message);
    await ref.set({ error: String(e.message || e).slice(0, 200), digestedAt: now(), digesting: false }, { merge: true });
  }
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  // the agent's routes first: /api/site/agent/* is machine-only and must not fall into the attendance matcher
  const ag = await siteAgent.handle(req, res, url, user, { ...ctx, threadsFor, writeLine, refs });
  if (ag !== false) return ag;
  const att = await attendance.handle(req, res, url, user, { ...ctx, threadsFor });
  if (att !== false) return att;
  const who = user.email || user.uid;
  let m;

  // the analytic accounts (projects) for the Sites sheet — admin
  if (url === '/api/site/analytics' && req.method === 'GET') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    const { analytics } = await refs(ctx);
    return json(res, 200, analytics.map(a => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)));
  }

  if (url === '/api/site/threads' && req.method === 'GET') {
    const ts = await threadsFor(ctx);
    await Promise.all(ts.map(async t => {   // one round trip for all threads, not one each
      const last = await ws.collection('site').doc(t.id).collection('posts').orderBy('at', 'desc').limit(1).get();
      t.last = last.empty ? '' : last.docs[0].data().at;
      // the chat-list preview, WhatsApp style
      if (!last.empty) { const p = last.docs[0].data(); t.preview = { kind: p.kind, by: p.by, text: p.deleted ? '' : (p.kind === 'text' || p.kind === 'action') ? siteAgent.previewOf(p).slice(0, 90) : (p.parsed && p.parsed.transcript ? String(p.parsed.transcript).slice(0, 90) : '') }; }
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
    // every ledger line behind a message: the first (p.line) and, for a several-payment note, the others (p.more)
    const jobs = []; for (const p of out) { if (p.line) jobs.push({ p, L: p.line }); for (const x of (p.more || [])) jobs.push({ p, L: x }); }
    await Promise.all(jobs.map(async ({ p: post, L }) => {
      const p = { line: L };
      const a = await acc.resolve(ws, p.line.accountId); if (!a) return;
      const t = (await acc.txCol(a).doc(p.line.txId).get()).data();
      p.line.state = !t ? 'dismissed' : t.bookedMove ? 'booked' : t.waAccepted ? 'accepted' : t.excluded && !t.review ? 'dismissed' : 'waiting';
      // the extra expenses added on this receipt (transport 25$…), so the chat shows them under it
      try {
        const ex = await acc.txCol(a).where('fromTxId', '==', p.line.txId).get();
        if (!ex.empty) p.line.extras = ex.docs.map(d => d.data()).map(x => ({ id: x.id, description: x.description || '', amount: (x.debit || 0) - (x.credit || 0), booked: !!x.bookedMove }));
      } catch (e) { console.error('site extras', p.line.txId, e.message); }
      if (t) {
        let bm = t.bookedMove || null;
        if (bm && bm.id && !bm.paidBy) { try { bm = await settlement(ctx, acc.txCol(a).doc(p.line.txId), bm); } catch (e) { console.error('site settlement', p.line.txId, e.message); } }
        p.line.debit = t.debit || 0; p.line.credit = t.credit || 0; p.line.section = t.section || ''; p.line.partnerName = t.partnerName || ''; p.line.company = t.company || ''; p.line.analyticName = t.analyticName || '';
        p.line.move = bm && bm.name || ''; p.line.billRef = (bm && bm.ref) || t.ref || '';
        p.line.paidBy = (bm && bm.paidBy || []).map(x => ({ name: x.name || '', ref: x.ref || '', amount: x.amount, date: x.date || '' }));
        p.line.paymentState = bm && bm.paymentState || '';
        p.line.note = t.note || '';
        p.line.autoSugAt = t.autoSugAt || ''; p.line.date = t.date || ''; p.line.vendorRead = t.vendorRead || '';   // a cancelled line says why (Mario 2026-10-08: "indicate the reason of the cancel")
        p.line.bookedKind = bm && bm.kind || '';   // 'payment' = the entry is the payment itself; onBill = the bill it was applied to
        p.line.onBill = bm && bm.bill && bm.bill.name || '';
        p.line.official = !!t.official && !!t.vat;
      }
    }));
    return json(res, 200, { posts: out });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts$/)) && req.method === 'POST') {
    const thread = m[1];
    if (!(await threadsFor(ctx)).some(t => t.id === thread)) return json(res, 403, { error: 'not your thread' });
    const b = await readBody(req);
    const kind = ['text', 'photo', 'video', 'voice', 'doc'].includes(b.kind) ? b.kind : 'text';
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
    // push to the others in the thread before answering — Vercel may freeze the function right after the reply
    if (ctx.notify) { try { await ctx.notify(post, who); } catch (e) { console.error('site push', e.message); } }
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
  // ✓ checked (Mario 2026-10-08: "allow me to hide after my check, so I only see what still needs me"): the message and its
  // ledger lines stay exactly as they are — on the ledger and in Odoo — the chat just folds it away. { checked: false } shows it again.
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/check$/)) && req.method === 'POST') {
    if (!ctx.access || !ctx.access.admin) return json(res, 403, { error: 'admin' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const b = await readBody(req);
    const on = b.checked !== false;
    await ref.set({ checkedAt: on ? now() : null, checkedBy: on ? ((user && user.email) || 'hub') : null }, { merge: true });
    return json(res, 200, { id: m[2], checkedAt: on ? now() : null });
  }
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
  // ✦ suggest again (Mario 2026-10-08: "recheck all entries… to suggest partner, company, project"): re-run the receipt
  // suggestion on a WAITING line and fill only what is still empty — never touches an accepted or booked line
  // auto-suggest (Mario 2026-10-08: "no need to press suggest — auto suggest, I will approve or edit"): the chat calls this
  // once for every waiting line that still has a blank; ?i= picks a line of a several-payment note (0 = the first)
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/resuggest$/)) && req.method === 'POST') {
    if (!ctx.access || !ctx.access.admin) return json(res, 403, { error: 'admin' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data(), i = +(new URL(req.url, 'http://x').searchParams.get('i') || 0);
    const L = i ? (post.more || [])[i - 1] : post.line;
    if (!L) return json(res, 400, { error: 'no ledger line on this message' });
    const pp = post.parsed || {}, item = (pp.items || [])[i] || null;
    const parsed = pp.receipt ? pp : { vendor: (item && item.partner) || pp.partner || '', note: (item && item.note) || pp.note || post.text || '', receipt: true, vat: false };
    const r = await autoFill(ctx, ws, L, parsed, post.text || '', null);
    return json(res, 200, { patched: r.patch || {}, suggestion: r.sug || {} });
  }
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/digest$/)) && req.method === 'POST') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    const b = await readBody(req);
    if (post.digestedAt && !b.force) return json(res, 200, post);
    // a message meant for the agent is a question, not a ledger proposal: read a voice note, never write a line
    if (post.by === siteAgent.AGENT || post.agentAsk || siteAgent.isTrigger(m[1], post.text, post.byAdmin)) {
      const parsed = post.parsed || {};
      if (post.kind === 'voice' && !parsed.transcript && post.file) { const buf = await readBytes(ctx, post.file); if (buf) parsed.transcript = await parse.whisper(buf, post.file.mime); }
      await ref.set({ parsed, line: null, error: null, digestedAt: now(), digesting: false, agentAsk: !!post.byAdmin }, { merge: true });
      return json(res, 200, (await ref.get()).data());
    }
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
    if (!['photo', 'video', 'doc'].includes(post.kind)) return json(res, 400, { error: 'not a picture or a document' });
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
module.exports = { handle, sweep: attendance.sweep, writeLine };
