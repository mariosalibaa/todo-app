// /energy/ewelink — Mario's Sonoff devices on eWeLink (CoolKit), app "Shift Claude" from dev.ewelink.cc (OAuth2.0,
// region 'as'). Tokens: seeded from env EWELINK_AT / EWELINK_RT (the laptop's ~/.ewelink-creds.json after `npm run login`
// in D:\vscode\ewelink), then kept in Firestore meta/ewelinkAuth because a refresh rotates both tokens (access 30 days).
// Env: EWELINK_APP_ID, EWELINK_APP_SECRET, EWELINK_REGION (as), EWELINK_AT, EWELINK_RT.
const eWeLink = require('ewelink-api-next').default;

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const authRef = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('ewelinkAuth');

let cached = null;   // { client, at } for the life of the function instance
async function client(ctx) {
  const appId = process.env.EWELINK_APP_ID, appSecret = process.env.EWELINK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('EWELINK_APP_ID / EWELINK_APP_SECRET not set');
  const stored = (await authRef(ctx).get()).data() || {};
  const at = stored.at || process.env.EWELINK_AT, rt = stored.rt || process.env.EWELINK_RT, region = stored.region || process.env.EWELINK_REGION || 'as';
  if (!at) throw new Error('eWeLink not linked: run npm run login in D:\\vscode\\ewelink and set EWELINK_AT / EWELINK_RT');
  if (cached && cached.at === at) return cached.client;
  const c = new eWeLink.WebAPI({ appId, appSecret, region, logObj: quiet });
  c.at = at; c.rt = rt;
  const probe = await c.home.getFamily({ lang: 'en' });
  if (probe && probe.error === 0) { cached = { client: c, at }; return c; }
  const r = await c.user.refreshToken({ rt });
  if (!r || r.error !== 0) throw new Error(`eWeLink token refresh failed (${r && r.error} ${(r && r.msg) || ''}) — run npm run login on the laptop and update EWELINK_AT / EWELINK_RT`);
  await authRef(ctx).set({ at: c.at, rt: c.rt, region, refreshedAt: new Date().toISOString() });
  cached = { client: c, at: c.at };
  return c;
}

const num = v => (v === undefined || v === null || v === 'unavailable' || v === '' || isNaN(+v)) ? null : +v;
function flatten(t) {
  const d = t.itemData || {}, p = d.params || {};
  return {
    id: d.deviceid, name: (d.name || '').trim(), model: d.productModel, brand: d.brandName, uiid: d.extra && d.extra.uiid,
    online: !!d.online, shared: t.itemType === 2,
    switch: p.switch === 'on' ? true : p.switch === 'off' ? false : null,
    switches: Array.isArray(p.switches) ? p.switches.map(s => ({ outlet: s.outlet, on: s.switch === 'on' })) : null,
    temp: num(p.currentTemperature), humidity: num(p.currentHumidity), sensor: p.sensorType && !/error/i.test(p.sensorType) ? p.sensorType : null,
  };
}
async function list(ctx) {
  const c = await client(ctx);
  const r = await c.device.getAllThingsAllPages({ lang: 'en' });
  if (!r || r.error !== 0) throw new Error(`getAllThings failed: ${r && r.error} ${(r && r.msg) || ''}`);
  return (r.data.thingList || []).filter(t => t.itemType === 1 || t.itemType === 2).map(flatten);
}
async function setSwitch(ctx, id, on, outlet) {
  const c = await client(ctx);
  const params = outlet === undefined || outlet === null ? { switch: on ? 'on' : 'off' } : { switches: [{ outlet: +outlet, switch: on ? 'on' : 'off' }] };
  const r = await c.device.setThingStatus({ type: 1, id, params });
  if (!r || r.error !== 0) throw new Error(`setThingStatus failed: ${r && r.error} ${(r && r.msg) || ''}${r && r.error === 4002 ? ' (device offline)' : ''}`);
  await new Promise(res => setTimeout(res, 800));
  return (await list(ctx)).find(d => d.id === id) || null;
}

// Temperature history: eWeLink's cloud keeps no readings (only switch operations), so the laptop task HeaterWatch asks
// /api/ewelink/check every 10 min and each probe's reading goes into meta/ewelinkTemps { pts: { <deviceid>: [{t,c}] }, names },
// KEEP_DAYS back (14 d × 144 × ~5 probes ≈ 10k points, one doc). A page view samples too when the last one is stale.
const KEEP_DAYS = 14;
const tempsRef = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('ewelinkTemps');
async function sample(ctx) {
  const devs = await list(ctx), now = Date.now(), ref = tempsRef(ctx), d = (await ref.get()).data() || {};
  const pts = d.pts || {}, names = d.names || {};
  let added = 0;
  for (const x of devs) {
    if (!x.online || x.temp == null || x.temp < -30 || x.temp > 120) continue;
    const arr = (pts[x.id] || []).filter(p => now - p.t < KEEP_DAYS * 864e5);
    if (!arr.length || now - arr[arr.length - 1].t >= 5 * 60e3) { arr.push({ t: now, c: x.temp }); added++; }
    pts[x.id] = arr; names[x.id] = x.name;
  }
  await ref.set({ pts, names, at: new Date(now).toISOString() });
  return { ok: true, probes: Object.keys(pts).length, added, devices: devs.length };
}
// eWeLink's own history: GET /v2/device/temp-hum-history?deviceid&last=<ISO> — refused to a dev-center app (407), it
// only answers the eWeLink WEB app's id (K0OC…, public in web.ewelink.cc's bundle) with a token from a web.ewelink.cc
// password login (EWELINK_WEB_AT, 30 days; Playwright relogin — see memory ewelink-mcp). Arrays are NEWEST-FIRST and
// UTC-aligned: hourly[i] = the hour of `last` minus i h (24), last7Days[i] = yesterday 23:00Z minus i h (168),
// daily[i] = {min,max} of today(UTC) minus i days (30), monthly (6). Cached 30 min per device in meta/ewelinkCloudHist.
const WEB_APPID = () => process.env.EWELINK_WEB_APPID || 'K0OCDSvIaBWdEaU4zxlKEwk26kmshoXK';
const cloudRef = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('ewelinkCloudHist');
async function cloudFetch(ctx, id) {
  const stored = (await authRef(ctx).get()).data() || {};
  const at = (stored.web && stored.web.at) || process.env.EWELINK_WEB_AT;
  if (!at) return { error: 'no web token' };
  const region = (stored.web && stored.web.region) || process.env.EWELINK_REGION || 'as';
  const last = new Date();
  const res = await fetch(`https://${region}-apia.coolkit.cc/v2/device/temp-hum-history?deviceid=${id}&last=${encodeURIComponent(last.toISOString())}`,
    { headers: { Authorization: 'Bearer ' + at, 'X-CK-Appid': WEB_APPID(), 'X-CK-Nonce': Math.random().toString(36).slice(2, 10) } });
  const j = await res.json().catch(() => ({}));
  if (j.error) return { error: j.error, msg: j.msg };
  const th = (j.data && j.data.tempHistory) || {};
  const hourTop = Math.floor(last.getTime() / 3600e3) * 3600e3, dayTop = Math.floor(last.getTime() / 864e5) * 864e5;
  const pts = {};
  (th.last7Days || []).forEach((c, i) => { if (typeof c === 'number') pts[dayTop - 3600e3 - i * 3600e3] = c; });
  (th.hourly || []).forEach((c, i) => { if (typeof c === 'number') pts[hourTop - i * 3600e3] = c; });
  const hourly = Object.keys(pts).map(t => ({ t: +t, c: pts[t] })).sort((a, b) => a.t - b.t);
  const daily = (th.daily || []).map((d, i) => ({ t: dayTop - i * 864e5, min: d && d.min, max: d && d.max })).filter(d => typeof d.min === 'number').sort((a, b) => a.t - b.t);
  return { hourly, daily, at: last.toISOString() };
}
async function cloudHistory(ctx, ids, send) {
  const ref = cloudRef(ctx), d = (await ref.get()).data() || {}, out = {}, now = Date.now();
  let changed = false, authFail = null;
  for (const id of ids) {
    const c = d[id];
    if (c && now - new Date(c.at).getTime() < 30 * 60e3) { out[id] = c; continue; }
    try {
      const r = await cloudFetch(ctx, id);
      if (r.error) { if (/^(401|406)$/.test(String(r.error))) authFail = r; out[id] = c || null; continue; }
      out[id] = d[id] = r; changed = true;
    } catch (e) { out[id] = c || null; }
  }
  if (changed) await ref.set(d);
  if (authFail && send && d.authTold !== new Date().toISOString().slice(0, 10)) {
    d.authTold = new Date().toISOString().slice(0, 10); await ref.set(d);
    await send(`⚠ eWeLink: the web token for the temperature history is refused (${authFail.error} ${authFail.msg || ''}) — tell Claude "relogin ewelink" to renew it.\n\nhttps://hub.shift-group.co/energy/ewelink`);
  }
  return out;
}
async function history(ctx, days = 1) {
  const d = (await tempsRef(ctx).get()).data() || {}, from = Date.now() - Math.min(days, KEEP_DAYS) * 864e5, out = {};
  for (const [id, arr] of Object.entries(d.pts || {})) out[id] = arr.filter(p => p.t >= from);
  return { pts: out, at: d.at || null };
}

module.exports = { list, setSwitch, sample, history, cloudHistory };
