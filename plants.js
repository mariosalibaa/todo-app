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
        logger: d.parent && d.parent.deviceSn !== d.deviceSn ? d.parent.deviceSn : null, soc: f.B_left_cap1 != null ? +f.B_left_cap1 : null,
        fd: type === 'INVERTER' ? f : undefined });   // the inverter's latest readings (S_P_T, PG_Pt1, B_P1, Etdy_*…) — the power flow reads them
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
  // the website's sign-in. A SOLARMAN Business account lands in org 0 (sees no plant) — sign in again straight into
  // the business org (org_id on the password grant; switch_org answers sorry_for_server_exception here). The org is
  // SOLARMAN_ORG, else the first one /user-s/acc/org/my lists (SHIFT = 62647, found 2026-10-03).
  const grant = org => fetch(`${SM_WEB}/oauth-s/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', identity_type: '2', username: process.env.SOLARMAN_USER, client_id: 'test', system: 'SOLARMAN', lang: 'en', password: sha(process.env.SOLARMAN_PASS), ...(org ? { org_id: String(org) } : {}) }) })
    .then(r => r.json().catch(() => ({ error: r.status })));
  let org = process.env.SOLARMAN_ORG;
  if (!org) {
    const j = await grant();
    if (!j.access_token) throw new Error('Solarman sign-in refused: ' + (j.error_description || j.error));
    const l = await (await fetch(`${SM_WEB}/user-s/acc/org/my`, { headers: { Authorization: 'bearer ' + j.access_token } })).json().catch(() => []);
    org = Array.isArray(l) && l[0] && l[0].org ? l[0].org.id : null;
    if (!org) return (smTok = j.access_token);
  }
  const j = await grant(org);
  if (!j.access_token) throw new Error('Solarman sign-in refused: ' + (j.error_description || j.error));
  return (smTok = j.access_token);
}
async function smPost(path, body, retried) {
  const base = smMode() === 'api' ? SM_API : SM_WEB;
  const r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'bearer ' + await smToken(retried), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
  if (r.status === 401 && !retried) return smPost(path, body, true);
  if (!r.ok) throw new Error('Solarman ' + r.status);
  return r.json();
}
async function smGet(path, retried) {
  const r = await fetch(SM_WEB + path, { headers: { Authorization: 'bearer ' + await smToken(retried), Accept: 'application/json' } });
  if (r.status === 401 && !retried) return smGet(path, true);
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
  for (const type of ['inverter', 'collector', 'battery']) {   // the website: /maintain-s/operating/station/<id>/<type> (netState 1 = online)
    let j; try { j = await smGet(`/maintain-s/operating/station/${id}/${type}?page=1&size=1000`); } catch (e) { continue; }
    for (const d of j.data || []) out.push({ type, sn: d.deviceSn, id: d.id, online: d.netState === 1, status: d.netState, role: d.name || null,
      last: d.collectionTime ? new Date(d.collectionTime * 1000).toISOString() : null, logger: d.parentDeviceType === 'COLLECTOR' ? d.parentDeviceSn : null });
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
  // most loggers report to both platforms: a Solarman plant named like a DeyeCloud one is that plant — kept on the
  // DeyeCloud line (tag "also on Solarman"), not listed twice and not alerted twice
  // Mario 2026-10-03: "where there is conflict or duplication, Deye is the updated platform — we moved many plants
  // to Deye". So the same name = the DeyeCloud plant wins, whatever Solarman says (its 40 kWp "Mckinsey" = the earlier
  // record of DeyeCloud's 120 kWp one). Also (same kWp and one name inside the other / a shared word of 4+ letters: "CPR" = "CPR Complexe…",
  // "Raashin" = "Georges Youssef Matar (Therese Raashin)", "feytroun" = "Faytroun" by Antoine Menassa)
  const norm = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = n => new Set(n.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && w !== 'villa' && w !== 'residence'));
  const deyes = v.plants.filter(p => p.src === 'deye');
  const twin = p => deyes.find(d => !d.alsoSolarman && norm(d.name) === norm(p.name)) || deyes.find(d => !d.alsoSolarman && Math.abs((d.kwp || 0) - (p.kwp || 0)) < 0.011 &&
    (norm(d.name).includes(norm(p.name)) || norm(p.name).includes(norm(d.name)) || [...words(p.name)].some(w => words(d.name).has(w))));
  v.plants = v.plants.filter(p => { if (p.src !== 'solarman') return true; const d = twin(p); if (!d) return true; d.alsoSolarman = p.id; return false; });
  cache = { at: Date.now(), v };
  return v;
}
async function devices(ctx, src, id) { return src === 'solarman' ? smDevices(id) : deyeDevices(ctx, id); }

// ── live detail of one plant: power flow, grid/gen source health, alarms (Mario 2026-10-03) ──────────────────
// Read when a plant is opened, never for the whole list. Sources:
//   DeyeCloud  the inverter list's featureData = latest readings + today's counters (cheap); V / Hz only exist in the
//              day series (/device-s/device/<id>/stats/day, 1-min samples, ~7 MB) — read for the master only
//   Solarman   no featureData on its device list: the day series of every inverter (5-min, ~1.4 MB each)
// Parallel inverters: power and today's kWh = the sum of the inverters; SOC, grid V and Hz = the master (M1 / M01).
// Read-only: nothing here ever writes to an inverter.
const SERIES_KEYS = new Set(['S_P_T', 'E_Puse_t1', 'PG_Pt1', 'G_V_L1', 'PG_F1', 'B_left_cap1', 'B_P1', 'GEN_P_T',
  'Etdy_ge1', 'Etdy_use1', 'Etdy_pu1', 'E_B_D', 'Etdy_cg1', 'Etdy_dcg1', 'GEN_P_D']);
const beirutDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const seriesMem = new Map();   // src:device:day → { at, v } — 5 min
async function daySeries(ctx, src, devId, ymd) {
  const k = `${src}:${devId}:${ymd}`, c = seriesMem.get(k);
  if (c && Date.now() - c.at < 5 * 60000) return c.v;
  const path = `/device-s/device/${devId}/stats/day?day=${ymd.replace(/-/g, '%2F')}&lan=en`;
  const arr = src === 'solarman' ? await smGet(path) : await deyeGet(ctx, path);
  const v = {};
  for (const p of Array.isArray(arr) ? arr : []) if (SERIES_KEYS.has(p.storageName))
    v[p.storageName] = (p.detailList || []).map(d => [+d.collectionTime, +d.value]).filter(x => x[0] && !isNaN(x[1])).sort((a, b) => a[0] - b[0]);
  if (seriesMem.size > 60) seriesMem.delete(seriesMem.keys().next().value);
  seriesMem.set(k, { at: Date.now(), v });
  return v;
}
const lastOf = (s, key) => { const a = s && s[key]; return a && a.length ? a[a.length - 1][1] : null; };
const lastAt = s => Math.max(0, ...Object.values(s || {}).map(a => a.length ? a[a.length - 1][0] : 0));
// value of a series nearest to t (within 4 min) — lines up the slaves' samples on the master's clock
const near = (a, t) => { if (!a || !a.length) return null; let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; }
  let best = null; for (const i of [lo - 1, lo]) if (a[i] && Math.abs(a[i][0] - t) <= 240 && (!best || Math.abs(a[i][0] - t) < Math.abs(best[0] - t))) best = a[i];
  return best ? best[1] : null; };

// The source health of one day. rows = [{ t, v, hz, grid (W, + import), batt (W, + discharge), soc }] on the master's clock.
// "Source present but not accepted" (Bookstop 3 Oct 2026, 17:00–19:15: the generator at 51–52 Hz was refused, SOC
// 47 % → 4 %, F56 DC_VoltLow at 19:04): grid V > 150 AND |import| < 100 W AND the battery discharging, for ≥ 20 min
// with the SOC falling.
function sourceHealth(rows, now = Date.now()) {
  const out = { presentH: 0, episodes: [] };
  if (!rows.length) return out;
  for (let i = 0; i < rows.length; i++) {
    const dt = i + 1 < rows.length ? Math.min(rows[i + 1].t - rows[i].t, 600) : 300;
    if (rows[i].v > 150) out.presentH += dt / 3600;
  }
  out.presentH = Math.round(out.presentH * 10) / 10;
  // A battery-first inverter also leaves a healthy source unused while the SOC is high (Bookstop 3 Oct, 15:17–17:05:
  // SOC 99 → 69 %, 49–50 Hz) — normal. So a run only counts when the battery goes below SOC_FLOOR while the source is
  // there (it should have taken over by then), or when the frequency sits outside 49–51 Hz for most of the run.
  // Each stretch (a one-sample blip of ≤ 5 min does not end it) is judged on its own; qualifying stretches less than
  // 15 min apart are then one episode, which must last ≥ 20 min with the SOC falling.
  const SOC_FLOOR = 30;
  const bad = r => r.v > 150 && r.grid != null && Math.abs(r.grid) < 100 && r.batt > 0;
  const pieces = [];
  for (let i = 0; i < rows.length; i++) {
    if (!bad(rows[i])) continue;
    const p = pieces[pieces.length - 1];
    if (p && rows[i].t - rows[p.j].t <= 6 * 60) p.j = i; else pieces.push({ i, j: i });
  }
  const stats = (i, j) => { const seg = rows.slice(i, j + 1).filter(bad), hz = seg.map(r => r.hz).filter(x => x != null);
    return { seg, hz, offHz: hz.filter(x => x < 49 || x > 51).length, minSoc: Math.min(...seg.map(r => r.soc).filter(x => x != null)) }; };
  const ok = pieces.filter(p => { const s = stats(p.i, p.j); return s.minSoc < SOC_FLOOR || s.offHz > s.hz.length / 2; });
  const merged = [];
  for (const p of ok) { const m = merged[merged.length - 1]; if (m && rows[p.i].t - rows[m.j].t <= 15 * 60) m.j = p.j; else merged.push({ ...p }); }
  for (const m of merged) {
    const a = rows[m.i], b = rows[m.j], s = stats(m.i, m.j);
    if (b.t - a.t < 20 * 60 || a.soc == null || b.soc == null || !(b.soc < a.soc)) continue;
    out.episodes.push({ from: new Date(a.t * 1000).toISOString(), to: new Date(b.t * 1000).toISOString(), socFrom: a.soc, socTo: b.soc,
      hzMin: s.hz.length ? Math.min(...s.hz) : null, hzMax: s.hz.length ? Math.max(...s.hz) : null, v: Math.round(s.seg.reduce((x, r) => x + r.v, 0) / s.seg.length),
      why: s.offHz > s.hz.length / 2 ? 'hz' : 'soc', active: m.j >= rows.length - 3 && now / 1000 - b.t < 20 * 60 });
  }
  return out;
}

async function detail(ctx, src, id, opt = {}) {
  const devs = await devices(ctx, src, id);
  const inv = devs.filter(d => d.type === 'inverter');
  const master = inv.find(d => /^M/i.test(d.role || '')) || inv.find(d => d.online) || inv[0];
  const ymd = beirutDay();
  const out = { at: new Date().toISOString(), day: ymd, devices: devs.map(d => { const { fd, ...x } = d; return x; }), flow: null, today: null, source: null, alarms: null };
  if (!inv.length) return out;
  // per inverter: latest readings + today's counters
  const series = {};
  if (src === 'solarman') {
    for (const d of inv) { try { series[d.id] = await daySeries(ctx, src, d.id, ymd); } catch (e) { series[d.id] = null; } }
  } else if (master) { try { series[master.id] = await daySeries(ctx, src, master.id, ymd); } catch (e) { out.seriesError = String(e.message || e); } }
  const latest = d => d.fd && Object.keys(d.fd).length ? d.fd : Object.fromEntries([...SERIES_KEYS].map(k => [k, lastOf(series[d.id], k)]));
  const num = (o, k) => o[k] == null || o[k] === '' || isNaN(+o[k]) ? null : +o[k];
  const sum = k => { let s = null; for (const d of inv) { const v = num(latest(d), k); if (v != null) s = (s || 0) + v; } return s; };
  const ms = latest(master), at = src === 'solarman' ? lastAt(series[master.id]) : +(ms.zv || 0) || (master.last ? Date.parse(master.last) / 1000 : 0);
  const W = v => v == null ? null : Math.round(v / 10) / 100;
  out.flow = { at: at ? new Date(at * 1000).toISOString() : null, solarKw: W(sum('S_P_T')), loadKw: W(sum('E_Puse_t1')), gridKw: W(sum('PG_Pt1')),
    genKw: W(sum('GEN_P_T')), battKw: W(sum('B_P1')), soc: num(ms, 'B_left_cap1') };
  out.today = { solar: sum('Etdy_ge1'), load: sum('Etdy_use1'), gridIn: sum('Etdy_pu1') ?? sum('E_B_D'),
    charge: sum('Etdy_cg1'), discharge: sum('Etdy_dcg1'), gen: sum('GEN_P_D') };
  // fill the device rows Solarman leaves empty (now kW / today kWh)
  for (const x of out.devices) if (x.type === 'inverter') {
    const l = latest(inv.find(d => d.id === x.id) || {});
    if (x.kw == null && num(l, 'S_P_T') != null) x.kw = W(num(l, 'S_P_T'));
    if (x.today == null && num(l, 'Etdy_ge1') != null) x.today = num(l, 'Etdy_ge1');
  }
  // the source health — the master's clock, the grid import summed over the inverters
  const m = series[master.id];
  if (m && m.G_V_L1 && m.G_V_L1.length) {
    const others = inv.filter(d => d !== master && series[d.id]);
    const rows = m.G_V_L1.map(([t, v]) => {
      let grid = near(m.PG_Pt1, t), batt = near(m.B_P1, t);
      for (const d of others) { const g = near(series[d.id].PG_Pt1, t), b = near(series[d.id].B_P1, t); if (g != null && grid != null) grid += g; if (b != null && batt != null) batt += b; }
      return { t, v, hz: near(m.PG_F1, t), grid, batt, soc: near(m.B_left_cap1, t) };
    });
    const last = rows[rows.length - 1];
    out.source = { v: last.v, hz: last.hz, hzBad: last.v > 150 && last.hz != null && (last.hz < 49 || last.hz > 51), at: new Date(last.t * 1000).toISOString(), ...sourceHealth(rows) };
    if (opt.rows) out.rows = rows;
  }
  if (opt.alarms) { try { out.alarms = await alarms(ctx, src, id); } catch (e) { out.alarms = { error: String(e.message || e) }; } }
  return out;
}

// the platform's alarm list for one plant, last `days` days, newest first; a code seen twice or more is "recurring"
async function alarms(ctx, src, id, days = 7) {
  const path = '/maintain-s/operating/station/alert?order.direction=DESC&order.property=alertTime&size=100&page=1';
  const j = src === 'solarman' ? await smPost(path, { stationId: +id }) : await deyeGet(ctx, path, { stationId: +id });
  const since = Date.now() / 1000 - days * 86400;
  const list = (j.data || []).filter(a => +a.alertTime >= since).map(a => ({ name: a.alertName || a.alertNameEn || a.ruleName || a.code || '?', device: a.deviceName || a.deviceSn || '',
    from: a.alertTime ? new Date(a.alertTime * 1000).toISOString() : null, to: a.endTime ? new Date(a.endTime * 1000).toISOString() : null, level: a.level ?? a.alertLevel ?? null }));
  const n = {}; for (const a of list) n[a.name] = (n[a.name] || 0) + 1;
  for (const a of list) a.count = n[a.name];
  return list;
}

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
      const since = s.badSince || (first || !seen[k] ? null : now);   // first sight (first run, or a plant new to the list): already bad = unknown start, never announced
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
  // source watch: a grid / generator present but refused while the battery drains (see sourceHealth) — only the plants
  // ticked "Watch the source" on the page (the day series is heavy), Bookstop by default. One message when an episode
  // starts, one when it ends.
  const watch = prev.source || { 'solarman:2596285': true }, srcState = prev.srcState || {}, hhmm = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
  for (const k of Object.keys(watch).filter(k => watch[k])) {
    const [src, id] = k.split(':'), p = L.plants.find(x => x.src === src && x.id === id) || L.plants.find(x => src === 'solarman' && x.alsoSolarman === id);
    const name = p ? p.name : k, st = srcState[k] || {};
    let ep = null;
    try { const d = await detail(ctx, src, id); ep = d.source && d.source.episodes.find(e => e.active); }
    catch (e) { continue; }   // a failed read changes nothing
    if (ep && !st.told) {
      msgs.push(`⚠ ${name} — a source is there but the inverters are not taking it, since ${hhmm(ep.from)}\n` +
        `grid port ${ep.v} V · ${ep.hzMin}–${ep.hzMax} Hz · import ≈ 0 kW · battery discharging, SOC ${ep.socFrom}% → ${ep.socTo}%`);
      srcState[k] = { told: true, since: ep.from };
    } else if (!ep && st.told) {
      msgs.push(`✅ ${name} — the source episode is over (since ${hhmm(st.since)})`);
      srcState[k] = {};
    }
  }
  await ref.set({ at: new Date().toISOString(), plants: seen, source: watch, srcState });
  if (msgs.length && send) await send(msgs.join('\n\n') + '\n\nhttps://hub.shift-group.co/plants');
  return { ok: true, plants: L.plants.length, sent: msgs.length, first, sources: L.sources };
}

// tick / untick a plant for the source watch
async function setWatch(ctx, src, id, on) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('plantWatch');
  const prev = (await ref.get()).data() || {};
  const watch = { ...(prev.source || { 'solarman:2596285': true }), [`${src}:${id}`]: !!on };
  await ref.set({ source: watch }, { merge: true });
  return watch;
}
async function watching(ctx) {
  const d = (await ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('plantWatch').get()).data() || {};
  return d.source || { 'solarman:2596285': true };
}

module.exports = { list, devices, detail, alarms, check, shareKey, setWatch, watching, sourceHealth };
