// Shift WhatsApp, part 2 — attendance: sites with a radius, Start / Finish taps with the phone's location,
// taps entered by hand, and the day that writes itself as a SUGGESTION on the worker's ledger.
// Mounted by site.js under /api/site/*; ctx = { db, admin, TEAM_ID, odooCall, access }.
//
//   GET    /api/site/sites                 the sites (everyone with the app)
//   POST   /api/site/sites                 admin: { id?, name, analyticId, analyticName, lat, lng, radiusM } upsert
//   DELETE /api/site/sites/<id>            admin
//   POST   /api/site/<thread>/tap          { kind: 'start'|'finish', loc?: {lat,lng,acc}, siteId?, manual?: { date, time } }
//                                          → the tap post; 409 { pick: true, sites } when a Start is outside every site
//   GET    /api/site/<thread>/day?date=    the day as the hub sees it (taps, hours, line state)
//   sweep(ctx)                             23:55 Beirut cron: a Start with no Finish gets its line with a `no finish` tag
//
// Rules (design 2026-09-12): a duplicate Start is refused; a Finish before a Start is stored and flagged; a live tap is
// never edited, a hand-entered one carries manual + enteredAt; location can be refused (the tap still counts, "no
// location"). The line: date, project from the Start's site, "what he did" from his text posts without an amount,
// Due to employee = defaultRate (hourly people: hours on the line, amount left to the month's costing), progress
// photos/videos of the day as media. Same gate as everything else: nothing is real until Mario's ✓.
const acc = require('./accounts');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const money = n => Math.round((+n || 0) * 100) / 100;
const beirutDay = d => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const beirutHHMM = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Beirut' });
const mins = t => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
const readBody = (req, max = 1e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});

// metres between two points
function distanceM(a, b) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const sitesCol = ws => ws.collection('site').doc('meta').collection('sites');
async function listSites(ws) { return (await sitesCol(ws).get()).docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name)); }
function siteAt(sites, loc) {
  if (!loc || loc.lat == null) return null;
  let best = null;
  for (const s of sites) { const d = distanceM(loc, s); if (d <= (s.radiusM || 150) && (!best || d < best.d)) best = { site: s, d }; }
  return best ? best.site : null;
}

// a Beirut ISO for a date + hh:mm typed by hand (Beirut is UTC+3 in summer, +2 in winter — read the offset off the clock)
function beirutIso(date, time) {
  const probe = new Date(date + 'T12:00:00Z');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(probe);
  const off = (+parts.find(p => p.type === 'hour').value) * 60 + (+parts.find(p => p.type === 'minute').value) - 12 * 60;   // minutes east of UTC
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m) - off * 60000).toISOString();
}

async function postsOfDay(ws, thread, date) {
  const snap = await ws.collection('site').doc(thread).collection('posts').where('date', '==', date).get();
  return snap.docs.map(d => d.data()).filter(p => !p.deleted).sort((a, b) => a.at.localeCompare(b.at));
}

// the day as one object: the taps, hours, what he did, media, the line's state
function dayOf(posts, account) {
  const taps = posts.filter(p => p.kind === 'start' || p.kind === 'finish');
  const start = taps.find(p => p.kind === 'start'), finish = [...taps].reverse().find(p => p.kind === 'finish');
  const arrived = start ? beirutHHMM(start.at) : '', finished = finish ? beirutHHMM(finish.at) : '';
  const hours = arrived && finished && mins(finished) > mins(arrived) ? Math.round((mins(finished) - mins(arrived)) / 6) / 10 : 0;
  const did = posts.filter(p => (p.kind === 'text' || p.kind === 'voice') && !p.line).map(p => p.kind === 'voice' ? (p.parsed && p.parsed.transcript) || '' : p.text || '').map(s => s.trim()).filter(Boolean);
  const media = posts.filter(p => (p.kind === 'photo' || p.kind === 'video') && !p.line && p.file).map(p => ({ postId: p.id, thread: p.thread, kind: p.kind, file: p.file }));
  return { start, finish, arrived, finished, hours, did, media, manual: taps.some(p => p.manual), noLocation: taps.some(p => !p.loc), noStart: !!(finish && !start) };
}

// write (or rewrite) the day's suggestion on the worker's ledger. Idempotent: id site-day-<thread>-<date>;
// an accepted line is never touched again.
async function writeDay(ctx, ws, thread, date, opts = {}) {
  const account = await acc.resolve(ws, thread); if (!account) throw new Error('no ledger ' + thread);
  const posts = await postsOfDay(ws, thread, date);
  const day = dayOf(posts, account);
  if (!day.start && !day.finish) return null;
  const id = 'site-day-' + thread + '-' + date;
  const ref = acc.txCol(account).doc(id);
  const cur = (await ref.get()).data();
  if (cur && cur.waAccepted) return { accountId: account.id, txId: id, state: 'accepted', kept: true };
  const site = day.start && day.start.siteId ? { id: day.start.analyticId, name: day.start.analyticName } : (account.defaultProject || null);
  // his pay: hours × hourly rate + transport when the account is hourly (Khodr, Ziad), else the day rate; no rate → priced by Mario
  const hourly = !!account.hourlyRate;
  const amount = hourly ? (day.hours ? money(day.hours * account.hourlyRate + (account.transport == null ? 0 : account.transport)) : 0) : money(account.defaultRate || 0);
  const tags = [];
  if (day.start && !day.finish) tags.push('no finish');
  if (day.noStart) tags.push('no start');
  if (day.manual) tags.push('entered by hand');
  if (day.noLocation) tags.push('no location');
  const t = { id, src: 'site', thread, date, daily: true, ref: '', service: 'Shift WhatsApp', phone: '',
    description: [day.arrived && day.finished ? `${day.arrived}–${day.finished} · ${day.hours} h` : day.arrived ? `from ${day.arrived}` : day.finished ? `until ${day.finished}` : '', ...day.did].filter(Boolean).join(' · ').slice(0, 200),
    debit: amount, credit: 0, hours: day.hours, nature: 'labour', natureSrc: 'site',
    analyticId: site && site.id ? site.id : null, analyticName: site && site.name ? site.name : '', analyticSrc: site && site.id ? 'site' : '',
    partnerId: account.odooPartner ? account.odooPartner.id : null, partnerName: account.odooPartner ? account.odooPartner.name : '', partnerSrc: account.odooPartner ? 'auto' : '',
    note: tags.join(' · '), noteSrc: tags.length ? 'site' : '',
    review: true, excluded: true, waAccepted: false, waFrom: 'them', waAt: (day.finish || day.start).at,
    media: day.media, docs: [], manual: day.manual, startPostId: day.start ? day.start.id : null, finishPostId: day.finish ? day.finish.id : null,
    createdAt: cur ? cur.createdAt : now(), createdBy: cur ? cur.createdBy : thread, updatedAt: now(), updatedBy: opts.who || 'site' };
  if (!amount) { t.noBook = true; t.ask = hourly ? 'no hours yet — the amount follows the Finish' : 'no rate on this account yet — price this day before booking'; }
  await ref.set(t);
  return { accountId: account.id, txId: id, state: 'waiting' };
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  const mine = async thread => (await ctx.threadsFor(ctx)).some(t => t.id === thread && t.kind === 'worker');
  let m;

  if (url === '/api/site/sites' && req.method === 'GET') return json(res, 200, await listSites(ws));
  if (url === '/api/site/sites' && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    const b = await readBody(req);
    const name = String(b.name || '').trim(); if (!name) return json(res, 400, { error: 'a name is needed' });
    if (!(isFinite(+b.lat) && isFinite(+b.lng))) return json(res, 400, { error: 'a position is needed' });
    const id = b.id ? String(b.id).replace(/[^\w-]/g, '') : newId();
    const s = { id, name, analyticId: b.analyticId ? +b.analyticId : null, analyticName: String(b.analyticName || ''), lat: +b.lat, lng: +b.lng, radiusM: Math.max(30, Math.min(2000, +b.radiusM || 150)), updatedAt: now(), updatedBy: who };
    await sitesCol(ws).doc(id).set(s);
    return json(res, 200, s);
  }
  if ((m = url.match(/^\/api\/site\/sites\/([\w-]+)$/)) && req.method === 'DELETE') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    await sitesCol(ws).doc(m[1]).delete(); return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/tap$/)) && req.method === 'POST') {
    const thread = m[1];
    if (!(await mine(thread))) return json(res, 403, { error: 'not your thread' });
    const b = await readBody(req);
    const kind = b.kind === 'finish' ? 'finish' : b.kind === 'start' ? 'start' : null;
    if (!kind) return json(res, 400, { error: 'start or finish' });
    const loc = b.loc && isFinite(+b.loc.lat) && isFinite(+b.loc.lng) ? { lat: +b.loc.lat, lng: +b.loc.lng, acc: Math.round(+b.loc.acc || 0) } : null;
    // by hand: today or yesterday for the worker, any day for Mario; a live tap is now
    let at = now(), date = beirutDay(), manual = false;
    if (b.manual && b.manual.date && b.manual.time) {
      const d = String(b.manual.date), tm = String(b.manual.time);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(tm)) return json(res, 400, { error: 'date and time' });
      const today = beirutDay(), yest = beirutDay(Date.now() - 864e5);
      if (!access.admin && d !== today && d !== yest) return json(res, 403, { error: 'you can enter today or yesterday; ask Mario for older days' });
      at = beirutIso(d, tm); date = d; manual = true;
      if (Date.parse(at) > Date.now() + 60e3) return json(res, 400, { error: 'that time is still ahead' });
    }
    const posts = await postsOfDay(ws, thread, date);
    const taps = posts.filter(p => p.kind === 'start' || p.kind === 'finish');
    if (kind === 'start' && taps.some(p => p.kind === 'start')) return json(res, 409, { error: 'the day already has a Start (' + beirutHHMM(taps.find(p => p.kind === 'start').at) + ')' });
    if (kind === 'finish' && taps.some(p => p.kind === 'finish')) return json(res, 409, { error: 'the day already has a Finish (' + beirutHHMM(taps.find(p => p.kind === 'finish').at) + ')' });
    // which site: the circle he is standing in, else the one he picked, else ask
    const sites = await listSites(ws);
    let site = siteAt(sites, loc) || (b.siteId ? sites.find(s => s.id === b.siteId) : null) || null;
    if (kind === 'start' && !site && sites.length && !b.siteId) return json(res, 409, { pick: true, sites: sites.map(s => ({ id: s.id, name: s.name })), error: loc ? 'you are outside every site — pick one' : 'no location — pick the site' });
    const id = newId();
    const post = { id, thread, by: who, byAdmin: !!access.admin, at, date, kind, loc, manual, enteredAt: manual ? now() : null,
      siteId: site ? site.id : null, siteName: site ? site.name : '', analyticId: site ? site.analyticId : null, analyticName: site ? site.analyticName : '',
      distanceM: site && loc ? Math.round(distanceM(loc, site)) : null, noStart: kind === 'finish' && !taps.some(p => p.kind === 'start') };
    await ws.collection('site').doc(thread).collection('posts').doc(id).set(post);
    // the day writes itself on Finish (and is refreshed when a late Start/Finish is entered by hand)
    let line = null;
    if (kind === 'finish' || manual) { try { line = await writeDay(ctx, ws, thread, date, { who }); } catch (e) { console.error('site day', thread, date, e.message); } }
    return json(res, 200, { post, line });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/day$/)) && req.method === 'GET') {
    const thread = m[1];
    if (!(await mine(thread))) return json(res, 403, { error: 'not your thread' });
    const q = new URL(req.url, 'http://x').searchParams;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : beirutDay();
    const account = await acc.resolve(ws, thread);
    const day = dayOf(await postsOfDay(ws, thread, date), account || {});
    let line = null;
    if (account) { const t = (await acc.txCol(account).doc('site-day-' + thread + '-' + date).get()).data(); if (t) line = { txId: t.id, state: t.waAccepted ? 'accepted' : t.excluded && !t.review ? 'dismissed' : 'waiting', description: t.description, note: t.note }; }
    return json(res, 200, { date, arrived: day.arrived, finished: day.finished, hours: day.hours, start: day.start || null, finish: day.finish || null, line });
  }

  return false;
}

// 23:55 Beirut: every worker with a Start today and no Finish gets his line, tagged "no finish"; yesterday is swept too
// in case the function did not run (a Vercel cron can slip).
async function sweep(ctx) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived);
  const out = [];
  for (const date of [beirutDay(), beirutDay(Date.now() - 864e5)]) {
    for (const p of people) {
      const posts = await postsOfDay(ws, p.id, date);
      if (!posts.some(x => x.kind === 'start' || x.kind === 'finish')) continue;
      try { const r = await writeDay(ctx, ws, p.id, date, { who: 'sweep' }); if (r) out.push({ thread: p.id, date, ...r }); }
      catch (e) { out.push({ thread: p.id, date, error: e.message }); }
    }
  }
  return out;
}

module.exports = { handle, sweep, writeDay, dayOf, distanceM, beirutIso };
