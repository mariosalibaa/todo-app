// Ajaltoun 4193 — machines & trucks from the site cameras (Mario, 2026-10-10).
// Static data reviewed from the SD cards: data/excavation-days.json (hours per machine and truck loads per
// day) and data/excavation-loads.json (every truck load with a photo and how well it was filled).
// Photos live in public/excavation/<folder>/ and are only handed out here, behind the same access as
// /api/ajaltoun (the 'ajaltoun' or 'excavation' app). public/excavation is kept out of the deploy (.vercelignore,
// 449 MB filled Vercel's free Function Storage): on Vercel they stream from Firebase Storage excavation/<folder>/,
// uploaded with scripts/upload-excavation-photos.js — re-run it after adding photos (2026-10-11).
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const PHOTOS = path.join(__dirname, 'public', 'excavation');

// local file when there is one (dev), else Firebase Storage
function sendPhoto(res, folder, name) {
  const f = path.join(PHOTOS, folder, name);
  if (fs.existsSync(f)) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(fs.readFileSync(f));
    return;
  }
  const file = require('firebase-admin').storage().bucket().file(`excavation/${folder}/${name}`);
  return file.download().then(([buf]) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(buf);
  }, e => { res.writeHead(e.code === 404 ? 404 : 502); res.end(e.code === 404 ? 'not found' : 'photo unavailable'); });
}

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}

const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', d => s += d).on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }).on('error', no); });
// Mario's review of each suspicious event: status (suspicious / not / investigate) + note — Firestore workspaces/<team>/excavationReviews/<event id>
const reviewsCol = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('excavationReviews');
async function readReviews(ctx) {
  if (!ctx || !ctx.db) return {};
  try { const snap = await reviewsCol(ctx).get(); const o = {}; snap.forEach(d => { o[d.id] = d.data(); }); return o; } catch { return {}; }
}

// Days after the last SD-card review fill in by themselves from the phone's Tapo event lists (Mario 2026-10-14:
// "this should be auto updated with new data"): working day / activity window / vehicle + person counts; hours and
// loads stay null until they are counted from Tapo frames (not the SD cards, Mario 2026-10-14).
const PIT = ['D2 C425', 'D2_Up C630', 'D3 up C630', 'Tapo C630 D2-D3'];   // cameras that look at the machines
async function phoneDays(ctx, sdDays) {
  if (!ctx || !ctx.db) return [];
  const last = sdDays.reduce((m, d) => d.date > m ? d.date : m, '');
  const out = [];
  try {
    const snap = await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('cameraDays').get();
    snap.forEach(doc => {
      const c = doc.data();
      if (!c.date || c.date <= last) return;
      const cams = (c.cameras || []).filter(x => x.total > 0);
      const pit = cams.filter(x => PIT.includes(x.cam));
      const day = t => t >= '06:00' && t < '19:00';
      const pitEv = pit.flatMap(x => (x.events || []).filter(e => day((e.time || '').slice(0, 5))));
      const veh = pitEv.filter(e => /Vehicle/.test(e.kind)).length;
      const times = pitEv.map(e => e.time.slice(0, 5)).sort();
      out.push({ date: c.date, hitachi: null, komatsu: null, loads: null, cams: cams.map(x => x.cam.replace(/ C\d{3}$/, '')),
        phone: { partial: !!c.partial, work: veh >= 3, vehicle: veh, person: pitEv.filter(e => /Person/.test(e.kind)).length,
          first: times[0] || '', last: times[times.length - 1] || '', events: cams.reduce((s, x) => s + x.total, 0) } });
    });
  } catch { return []; }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function handle(req, res, url, user, ctx) {
  const p = url.split('?')[0];
  if (p === '/api/ajaltoun/machines' && req.method === 'GET') {
    const days = readJson('excavation-days.json', { days: [] });
    const loads = readJson('excavation-loads.json', []);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const diesel = readJson('excavation-diesel.json', null);
    const flags = readJson('excavation-flags.json', []);
    const georges = readJson('georges.json', null);
    const bmw = readJson('bmw.json', null);
    const tacoma = readJson('tacoma.json', null);
    const dodge = readJson('dodge.json', null);
    const visitors = readJson('visitors.json', null);
    const reviews = await readReviews(ctx);
    days.days = [...(days.days || []), ...await phoneDays(ctx, days.days || [])];
    res.end(JSON.stringify({ ...days, loads, diesel, flags, georges, bmw, tacoma, dodge, visitors, reviews }));
    return true;
  }
  const m = p.match(/^\/api\/ajaltoun\/machines\/photo\/(\d{8}_\d{4}[\w-]*\.jpg)$/);
  if (m && req.method === 'GET') {
    await sendPhoto(res, 'loads', m[1]);
    return true;
  }
  if (p === '/api/ajaltoun/machines/review' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '').replace(/[^\w-]/g, '').slice(0, 60);
    const status = ['suspicious', 'not', 'investigate', ''].includes(b.status) ? b.status : null;
    if (!id || status === null || !ctx || !ctx.db) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"bad review"}'); return true; }
    const doc = { status, note: String(b.note || '').slice(0, 2000), by: (user && (user.name || user.email)) || '', at: new Date().toISOString() };
    await reviewsCol(ctx).doc(id).set(doc, { merge: true });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, id, ...doc }));
    return true;
  }
  const gp = p.match(/^\/api\/ajaltoun\/machines\/(georges|bmw|tacoma|dodge|visitors)\/(\d{8}[\w-]{0,12}\.jpg)$/);
  if (gp && req.method === 'GET') {
    await sendPhoto(res, gp[1], gp[2]);
    return true;
  }
  // Day report from the Tapo app (Mario 2026-10-12): every plug-in of the Samsung scrapes each camera's event list
  // and pushes one doc per day (D:\vscode\phone-sync\tapo_sync.py -> scripts/push-camera-days.js)
  if (p === '/api/ajaltoun/machines/daily' && req.method === 'GET') {
    let days = [];
    if (ctx && ctx.db) {
      try {
        const snap = await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('cameraDays').get();
        snap.forEach(d => days.push(d.data()));
      } catch { days = []; }
    }
    days.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ days }));
    return true;
  }
  const cd = p.match(/^\/api\/ajaltoun\/machines\/camday\/([a-z0-9-]{2,30}_\d{8}_\d{6}\.jpg)$/);
  if (cd && req.method === 'GET') {
    await sendPhoto(res, 'camdays', cd[1]);
    return true;
  }
  const fl = p.match(/^\/api\/ajaltoun\/machines\/flag\/(\d{8}_[a-z0-9_]{2,24}\.jpg)$/);
  if (fl && req.method === 'GET') {
    await sendPhoto(res, 'flags', fl[1]);
    return true;
  }
  return false;
}

module.exports = { handle };
