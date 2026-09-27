// DeyeCloud for the CPR page — solar, generator input, EDL in / out (net metering), UPS load, battery, per day.
// Used by energy.js (GET /api/energy) and the nightly cron (/api/cron/deye).
//
// Days come from three places, first match wins:
//   deye-history.json      built once (deye-history-build.js) — 2025-01-01 → the day before it was built
//   Firestore energyDeye/  one doc per later day, written by the cron / by a page load that finds it missing
//   today                  read live, kept 10 min in memory
// Sign-in: DEYE_USER + DEYE_PASS (the site's own password grant; the password travels as its SHA-256, as the
// login page sends it) → a ~60-day bearer token kept in Firestore meta/deyeToken and renewed on a 401.
// DEYE_TOKEN (a token copied from a signed-in browser) is the fallback when no password is set.

const crypto = require('crypto');
const D = require('./deye-calc');
const HISTORY = require('./deye-history.json');

const BASE = 'https://www.deyecloud.com';
const FIELDS = HISTORY.fields;   // ['pv', 'gen', 'gridIn', 'gridOut', 'use', 'charge', 'discharge', 'n']
const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Lebanon: +3 in summer, +2 in winter — close enough for "which day is today" after 01:00
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

let tokenMem = null;
let todayCache = { at: 0, day: null, v: null };

async function login() {
  const body = new URLSearchParams({ grant_type: 'password', identity_type: '2', username: process.env.DEYE_USER, client_id: 'test', org_id: '0',
    record_flag: '0', system: 'Deye', lang: 'en', password: crypto.createHash('sha256').update(process.env.DEYE_PASS).digest('hex') });
  const r = await fetch(`${BASE}/oauth-s/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('DeyeCloud sign-in refused: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

async function token(ctx, fresh) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('deyeToken');
  if (!fresh) {
    if (tokenMem) return tokenMem;
    const doc = (await ref.get()).data();
    if (doc && doc.token) return (tokenMem = doc.token);
  }
  if (process.env.DEYE_USER && process.env.DEYE_PASS) {
    tokenMem = await login();
    await ref.set({ token: tokenMem, at: new Date().toISOString() });
    return tokenMem;
  }
  if (process.env.DEYE_TOKEN) return (tokenMem = process.env.DEYE_TOKEN);
  throw new Error('DEYE_USER / DEYE_PASS not set');
}

// one day, integrated — renews the token once on a 401
async function fetchDay(ctx, ymd) {
  let tk = await token(ctx);
  try { return D.integrate(await D.dayRecords(tk, ymd)); }
  catch (e) {
    if (!/401/.test(e.message) || !(process.env.DEYE_USER && process.env.DEYE_PASS)) throw e;
    tk = await token(ctx, true);
    return D.integrate(await D.dayRecords(tk, ymd));
  }
}

const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('energyDeye');

// store the days after the history that are missing (or were short when read — Deye uploads late sometimes),
// at most `max` per call, one request a second (DeyeCloud answers 429 above that)
async function fill(ctx, max) {
  const yesterday = addDays(beirutToday(), -1);
  const have = {};
  (await col(ctx).where('day', '>', HISTORY.last).get()).forEach(d => { have[d.id] = d.data(); });
  const todo = [];
  for (let d = addDays(HISTORY.last, 1); d <= yesterday; d = addDays(d, 1)) {
    const h = have[d];
    if (!h || (h.n < 280 && d >= addDays(yesterday, -3))) todo.push(d);
  }
  const done = [];
  for (const d of todo.slice(0, max)) {
    const v = await fetchDay(ctx, d);
    await col(ctx).doc(d).set({ day: d, ...v, at: new Date().toISOString() });
    have[d] = v; done.push(d);
    await sleep(1100);
  }
  return { have, done, left: Math.max(0, todo.length - done.length) };
}

// every day from 2025-01-01 to today → { days, data: [[pv, gen, gridIn, gridOut, use, charge, discharge, n] | null] }
async function days(ctx) {
  const out = { days: HISTORY.days.slice(), data: HISTORY.data.slice(), error: null, left: 0 };
  try {
    const f = await fill(ctx, 8);   // a page load catches up a little; the nightly cron does the rest
    out.left = f.left;
    const today = beirutToday();
    for (let d = addDays(HISTORY.last, 1); d < today; d = addDays(d, 1)) { const v = f.have[d]; out.days.push(d); out.data.push(v ? FIELDS.map(k => v[k]) : null); }
    if (!(todayCache.day === today && Date.now() - todayCache.at < 10 * 60000)) todayCache = { at: Date.now(), day: today, v: await fetchDay(ctx, today) };
    out.days.push(today); out.data.push(FIELDS.map(k => todayCache.v[k]));
  } catch (e) {
    out.error = String(e.message || e);
    console.error('deye:', out.error);
  }
  return out;
}

// The three battery racks (Mario 2026-09-27: "show the battery in 3 columns (3 racks), 12 batteries each, the cycles").
// One rack per inverter (M1, S2, S3); DeyeCloud only knows the rack, through its inverter's BMS readings
// (/device-s/device/originalData): t_cg_n1 / t_dcg_n1 = lifetime charge / discharge kWh, BMS_SOC, Li_B_SOH, BMST °C,
// BMS_B_V1 V. The 12 modules of a rack are in series — they all see the same cycles.
let racksCache = { at: 0, v: null };
async function racks(ctx) {
  if (racksCache.v && Date.now() - racksCache.at < 10 * 60000) return racksCache.v;
  const get = async (path, retried) => {
    const tk = await token(ctx, retried);
    const r = await fetch(BASE + path, { headers: { Authorization: 'bearer ' + tk, Accept: 'application/json' } });
    if (r.status === 401 && !retried && process.env.DEYE_USER) return get(path, true);
    if (!r.ok) throw new Error('DeyeCloud ' + r.status);
    return r.json();
  };
  const l = await get(`/maintain-s/power/deye/device/${D.STATION}/device-list?deviceType=INVERTER`);
  const list = (l.data || l.records || l.list || l || []);
  const out = [];
  for (const d of list) {
    const r = await get('/device-s/device/originalData?deviceId=' + d.deviceId);
    const f = {}; const walk = o => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v); else f[k] = v; } }; walk(r);
    const n = k => (f[k] == null || f[k] === '' ? null : +f[k]);
    out.push({ id: d.deviceId, name: d.deviceName || d.deviceSn, sn: d.deviceSn, charge: n('t_cg_n1'), discharge: n('t_dcg_n1'), soc: n('BMS_SOC'), soh: n('Li_B_SOH'), temp: n('BMST'), volt: n('BMS_B_V1'), at: d.collectionTime ? new Date(d.collectionTime * 1000).toISOString() : null });
    await sleep(400);
  }
  // each rack's own BMS (Mario 2026-09-27: its "Cycle Times" is the real count; min / max cell voltages): the BATTERY
  // devices <inverter SN>M01 carry one child each — the BMS — whose originalData has NUMcyc1 (cycles), MAX_C_V / MIN_C_V
  // (cell V) with VCM_BCU / VCMN_BCU (which of the 12 batteries), T_C_MAX / T_C_MIN with TCM_BCU / TCMN_BCU, BV, BSC, BSH
  try {
    const bl = await get(`/maintain-s/power/deye/device/${D.STATION}/device-list?deviceType=BATTERY`);
    for (const b of (bl.data || [])) for (const c of (b.childs || [])) {
      const rack = out.find(r => r.id === b.parentId); if (!rack) continue;
      const r = await get('/device-s/device/originalData?deviceId=' + c.deviceId);
      const f = {}; const walk = o => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v); else f[k] = v; } }; walk(r);
      const n = k => (f[k] == null || f[k] === '' ? null : +f[k]);
      rack.bms = { sn: c.deviceSn, cycles: n('NUMcyc1'), soc: n('BSC'), soh: n('BSH'), volt: n('BV'),
        cellMax: n('MAX_C_V'), cellMaxBat: n('VCM_BCU'), cellMin: n('MIN_C_V'), cellMinBat: n('VCMN_BCU'),
        tMax: n('T_C_MAX'), tMaxBat: n('TCM_BCU'), tMin: n('T_C_MIN'), tMinBat: n('TCMN_BCU') };
      await sleep(400);
    }
  } catch (e) { console.error('deye bms:', e.message); }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  racksCache = { at: Date.now(), v: out };
  return out;
}

// Live flow + totals (Mario 2026-09-27: "show this on the hub" — DeyeCloud's Flow Graph — and "the total system
// production in kWh"). /maintain-s/fast/system = now (W) and today (kWh); stats/total = since commissioning (kWh);
// the last 5-min record of today splits the production into solar / generator. Kept 1 min.
let liveCache = { at: 0, v: null };
async function live(ctx) {
  if (liveCache.v && Date.now() - liveCache.at < 60000) return liveCache.v;
  const get = async (path, retried) => {
    const tk = await token(ctx, retried);
    const r = await fetch(BASE + path, { headers: { Authorization: 'bearer ' + tk, Accept: 'application/json' } });
    if (r.status === 401 && !retried && process.env.DEYE_USER) return get(path, true);
    if (!r.ok) throw new Error('DeyeCloud ' + r.status);
    return r.json();
  };
  const f = await get(`/maintain-s/fast/system/${D.STATION}`);
  const t = (await get(`/maintain-s/history/batteryPower/${D.STATION}/stats/total`)).statistics || {};
  let last = null;
  try { const recs = await D.dayRecords(await token(ctx), beirutToday()); last = recs[recs.length - 1] || null; } catch (e) {}
  const kw = v => (v == null ? null : Math.round(+v / 10) / 100);
  const v = {
    at: f.lastUpdateTime ? new Date(f.lastUpdateTime * 1000).toISOString() : null,
    now: { solar: last ? kw(last.pvPower) : null, gen: last ? kw(last.generatorPower) : null, production: kw(f.generationPower),
      grid: kw(f.wirePower), load: kw(f.usePower), battery: kw(f.batteryPower), soc: f.batterySoc, wireStatus: f.wireStatus, batteryStatus: f.batteryStatus,
      splitAt: last ? new Date(last.dateTime * 1000).toISOString() : null },
    today: { production: f.generationValue, load: f.useValue, bought: f.buyValue, sold: f.gridValue, charge: f.chargeValue, discharge: f.dischargeValue },
    total: { production: t.generationValue, load: t.useValue, bought: t.buyValue, sold: t.gridValue, charge: t.chargeValue, discharge: t.dischargeValue },
  };
  liveCache = { at: Date.now(), v };
  return v;
}

// Power Profile for one day (Mario 2026-09-27: DeyeCloud's chart on the hub): the 5-min records as
// [epoch s, solar, generator, EDL (+ buy / − sell), battery (+ discharge / − charge), load, SOC %] in kW.
// A past day never changes — kept for the life of the instance; today is reread after a minute.
const profCache = {};
async function profile(ctx, ymd) {
  const c = profCache[ymd], today = beirutToday();
  if (c && (ymd < today || Date.now() - c.at < 60000)) return c.v;
  const recs = await D.dayRecords(await token(ctx), ymd);
  const kw = v => (v == null ? null : Math.round(+v / 10) / 100);
  const v = { day: ymd, rows: recs.map(r => [r.dateTime, kw(r.pvPower), kw(r.generatorPower), kw(r.wirePower), kw(r.batteryPower), kw(r.usePower), r.batterySoc == null ? null : Math.round(+r.batterySoc)]) };
  profCache[ymd] = { at: Date.now(), v };
  return v;
}

module.exports = { days, fill, racks, live, profile, FIELDS };
