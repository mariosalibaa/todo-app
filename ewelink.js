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
async function history(ctx, days = 1) {
  const d = (await tempsRef(ctx).get()).data() || {}, from = Date.now() - Math.min(days, KEEP_DAYS) * 864e5, out = {};
  for (const [id, arr] of Object.entries(d.pts || {})) out[id] = arr.filter(p => p.t >= from);
  return { pts: out, at: d.at || null };
}

module.exports = { list, setSwitch, sample, history };
