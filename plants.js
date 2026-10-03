// /plants — every solar plant on DeyeCloud and Solarman in one list (Mario 2026-10-03: "a place where I sign in to
// DeyeCloud and Solarman and see all my plants"). The sign-ins live on the server, never in the page:
//   DeyeCloud   the same account and token as /cpr and /mahab (deye.token: DEYE_USER/DEYE_PASS, else the stored token)
//   Solarman    official OpenAPI when SOLARMAN_APP_ID + SOLARMAN_APP_SECRET are set (globalapi.solarmanpv.com, the app key
//               Solarman hands out by email), else the website's own sign-in (pro.solarmanpv.com — the same platform
//               DeyeCloud is built on) with SOLARMAN_USER + SOLARMAN_PASS. Neither set = "not connected" on the page.
// Offline alert: check() compares each plant's status with the last one seen (Firestore meta/plantWatch) and sends
// Telegram when an inverter stays offline for an hour, and again when it is back. Run every 15 min by the laptop task
// PlantsWatch (D:\vscode\todo\plants-watch.mjs), daily by Vercel cron as a fallback. A plant that is already dead on
// the first check is remembered quietly — only changes are announced.
const crypto = require('crypto');
const deye = require('./deye');

const DEYE = 'https://www.deyecloud.com';
const SM_API = 'https://globalapi.solarmanpv.com';
const SM_WEB = 'https://pro.solarmanpv.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STATUS = { NORMAL: 'online', PARTIAL_OFFLINE: 'partial', ALL_OFFLINE: 'offline', NO_DEVICE: 'nodevice', ALARM: 'alarm', FAULT: 'alarm' };
const kw = w => (w == null ? null : Math.round(+w / 10) / 100);

// ── DeyeCloud ────────────────────────────────────────────────────────────────
async function deyeGet(ctx, path, body, retried) {
  const tk = await deye.token(ctx, retried);
  const r = await fetch(DEYE + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'bearer ' + tk, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if ((r.status === 401 || r.status === 500) && !retried && process.env.DEYE_USER) return deyeGet(ctx, path, body, true);
  if (!r.ok) throw new Error('DeyeCloud ' + r.status);
  return r.json();
}
const fromStation = (src, s) => ({
  src, id: String(s.id), name: (s.name || '').trim(), kwp: s.installedCapacity, status: STATUS[s.networkStatus] || String(s.networkStatus || '').toLowerCase(),
  nowKw: kw(s.generationPower), today: s.generationValue, month: s.generationMonth, year: s.generationYear, total: s.generationTotal,
  useKw: kw(s.usePower), last: s.lastUpdateTime ? new Date(s.lastUpdateTime * 1000).toISOString() : null, type: s.type, grid: s.gridInterconnectionType,
});
async function deyeList(ctx) {
  const out = [];
  for (let page = 1; page < 10; page++) {
    const j = await deyeGet(ctx, `/maintain-s/operating/station/v2/search?page=${page}&size=100`, {});
    for (const d of j.data || []) out.push(fromStation('deye', d.station || {}));
    if (out.length >= (j.total || 0) || !(j.data || []).length) break;
  }
  return out;
}
async function deyeDevices(ctx, id) {
  const out = [];
  for (const type of ['INVERTER', 'COLLECTOR', 'BATTERY']) {
    let j; try { j = await deyeGet(ctx, `/maintain-s/power/deye/device/${id}/device-list?deviceType=${type}`); } catch (e) { continue; }
    for (const d of j.data || []) {
      let f = {}; try { f = JSON.parse(d.featureData || '{}'); } catch {}
      out.push({ type: type.toLowerCase(), sn: d.deviceSn, id: d.deviceId, online: d.deviceStatus === 1, status: d.deviceStatus,
        last: d.collectionTime ? new Date(d.collectionTime * 1000).toISOString() : null, kw: d.generationPower != null ? kw(d.generationPower) : null,
        today: d.generation, role: (d.extend || {}).P_INF || null, ratedKw: (d.extend || {}).Pr1 ? +(d.extend.Pr1) / 1000 : null,
        logger: d.parent && d.parent.deviceSn !== d.deviceSn ? d.parent.deviceSn : null, soc: f.B_left_cap1 != null ? +f.B_left_cap1 : null });
      for (const c of d.childs || []) out.push({ type: 'bms', sn: c.deviceSn, id: c.deviceId, online: c.deviceStatus === 1, status: c.deviceStatus, last: c.collectionTime ? new Date(c.collectionTime * 1000).toISOString() : null, parent: d.deviceSn });
    }
    await sleep(300);
  }
  return out;
}

// ── Solarman ─────────────────────────────────────────────────────────────────
let smTok = null;
const smMode = () => (process.env.SOLARMAN_APP_ID && process.env.SOLARMAN_APP_SECRET ? 'api' : process.env.SOLARMAN_USER && process.env.SOLARMAN_PASS ? 'web' : null);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function smToken(fresh) {
  if (smTok && !fresh) return smTok;
  if (smMode() === 'api') {
    const r = await fetch(`${SM_API}/account/v1.0/token?appId=${encodeURIComponent(process.env.SOLARMAN_APP_ID)}&language=en`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSecret: process.env.SOLARMAN_APP_SECRET, email: process.env.SOLARMAN_USER, password: sha(process.env.SOLARMAN_PASS || '') }) });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('Solarman sign-in refused: ' + (j.msg || r.status));
    return (smTok = j.access_token);
  }
  const r = await fetch(`${SM_WEB}/oauth-s/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', identity_type: '2', username: process.env.SOLARMAN_USER, client_id: 'test', system: 'SOLARMAN', lang: 'en', password: sha(process.env.SOLARMAN_PASS) }) });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Solarman sign-in refused: ' + (j.error_description || j.error || r.status));
  return (smTok = j.access_token);
}
async function smPost(path, body, retried) {
  const base = smMode() === 'api' ? SM_API : SM_WEB;
  const r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'bearer ' + await smToken(retried), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
  if (r.status === 401 && !retried) return smPost(path, body, true);
  if (!r.ok) throw new Error('Solarman ' + r.status);
  return r.json();
}
async function smList() {
  const out = [];
  if (smMode() === 'api') {
    for (let page = 1; page < 10; page++) {
      const j = await smPost('/station/v1.0/list?language=en', { page, size: 100 });
      for (const s of j.stationList || []) out.push({ src: 'solarman', id: String(s.id), name: (s.name || '').trim(), kwp: s.installedCapacity, status: STATUS[s.networkStatus] || String(s.networkStatus || '').toLowerCase(),
        nowKw: kw(s.generationPower), today: null, month: null, year: null, total: null, last: s.lastUpdateTime ? new Date(s.lastUpdateTime * 1000).toISOString() : null, type: s.type, grid: s.gridInterconnectionType });
      if (out.length >= (j.total || 0) || !(j.stationList || []).length) break;
    }
    return out;
  }
  for (let page = 1; page < 10; page++) {   // the website: the same station search DeyeCloud uses
    const j = await smPost(`/maintain-s/operating/station/v2/search?page=${page}&size=100`, {});
    for (const d of j.data || []) out.push(fromStation('solarman', d.station || {}));
    if (out.length >= (j.total || 0) || !(j.data || []).length) break;
  }
  return out;
}
async function smDevices(id) {
  if (smMode() === 'api') {
    const j = await smPost('/station/v1.0/device?language=en', { stationId: +id, page: 1, size: 100 });
    return (j.deviceListItems || []).map(d => ({ type: String(d.deviceType || '').toLowerCase(), sn: d.deviceSn, id: d.deviceId, online: d.connectStatus === 1, status: d.connectStatus, last: d.collectionTime ? new Date(d.collectionTime * 1000).toISOString() : null }));
  }
  const out = [];
  for (const type of ['INVERTER', 'COLLECTOR']) {
    let j; try { j = await smPost(`/maintain-s/power/device/${id}/device-list?deviceType=${type}`); } catch (e) { continue; }
    for (const d of j.data || []) out.push({ type: type.toLowerCase(), sn: d.deviceSn, id: d.deviceId, online: d.deviceStatus === 1, status: d.deviceStatus, last: d.collectionTime ? new Date(d.collectionTime * 1000).toISOString() : null });
  }
  return out;
}

// ── together ─────────────────────────────────────────────────────────────────
let cache = { at: 0, v: null };
async function list(ctx, fresh) {
  if (!fresh && cache.v && Date.now() - cache.at < 2 * 60000) return cache.v;
  const v = { at: new Date().toISOString(), plants: [], sources: {} };
  try { const p = await deyeList(ctx); v.plants.push(...p); v.sources.deye = { ok: true, n: p.length }; }
  catch (e) { v.sources.deye = { ok: false, error: String(e.message || e) }; }
  if (!smMode()) v.sources.solarman = { ok: false, connected: false, error: 'not connected' };
  else {
    try { const p = await smList(); v.plants.push(...p); v.sources.solarman = { ok: true, n: p.length, mode: smMode() }; }
    catch (e) { v.sources.solarman = { ok: false, connected: true, mode: smMode(), error: String(e.message || e) }; }
  }
  cache = { at: Date.now(), v };
  return v;
}
async function devices(ctx, src, id) { return src === 'solarman' ? smDevices(id) : deyeDevices(ctx, id); }

// a read-only link for one plant (a client sees their own plant only) — HMAC of src:id
const shareKey = (src, id) => crypto.createHmac('sha256', process.env.PLANTS_SHARE_SECRET || process.env.ACCOUNTING_API_KEY || 'x').update(`plant:${src}:${id}`).digest('hex').slice(0, 20);

// ── offline watch ────────────────────────────────────────────────────────────
const BAD = new Set(['partial', 'offline', 'alarm']);
async function check(ctx, send) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('plantWatch');
  const prev = (await ref.get()).data() || {};
  const seen = prev.plants || {}, first = !prev.at;
  const L = await list(ctx, true), now = Date.now(), msgs = [];
  if (!L.plants.length) return { ok: false, sources: L.sources };
  for (const p of L.plants) {
    const k = `${p.src}:${p.id}`, s = seen[k] || {};
    const bad = BAD.has(p.status);
    if (bad) {
      const since = s.badSince || (first ? null : now);   // first run: already bad = unknown start, never announced
      let note = s.note || null;
      if (since && !s.told && now - since >= 60 * 60000) {
        let what = '';
        try { const d = (await devices(ctx, p.src, p.id)).filter(x => !x.online && (x.type === 'inverter' || x.type === 'collector'));
          what = d.map(x => `${x.type} ${x.sn}${x.role ? ' (' + x.role + ')' : ''}${x.last ? ' — last data ' + new Date(x.last).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`).join('\n'); } catch (e) {}
        msgs.push(`⚠ ${p.name} — ${p.status === 'partial' ? 'partly offline' : p.status} for over an hour${what ? '\n' + what : ''}`);
        seen[k] = { status: p.status, badSince: since, told: true, note };
      } else seen[k] = { status: p.status, badSince: since, told: s.told || false, quiet: first || s.quiet || false };
    } else {
      if (s.told) msgs.push(`✅ ${p.name} — back online`);
      seen[k] = { status: p.status };
    }
  }
  await ref.set({ at: new Date().toISOString(), plants: seen });
  if (msgs.length && send) await send(msgs.join('\n\n') + '\n\nhttps://hub.shift-group.co/plants');
  return { ok: true, plants: L.plants.length, sent: msgs.length, first, sources: L.sources };
}

module.exports = { list, devices, check, shareKey };
