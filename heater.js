// /heater — the water heater's Tuya controller (Smart Life account mario.salibaa@gmail.com, cloud project
// "Shift Claude", Central Europe). Status + switch for the page, and the watch that the laptop task HeaterWatch
// runs every 10 min through /api/heater/check (Telegram via the hub's bot, like plants.js).
// Env: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_ENDPOINT (https://openapi.tuyaeu.com), TUYA_HEATER_ID,
//      HEATER_ON_HOURS (alert when a channel stays on longer, default 2), HEATER_MAX_TEMP (°C, default 70),
//      TUYA_TRIAL_EXPIRY (yyyy-mm-dd — the free IoT Core trial; reminder 15 days before, then daily).
const crypto = require('crypto');

const ID = () => process.env.TUYA_ACCESS_ID || '', SECRET = () => process.env.TUYA_ACCESS_SECRET || '';
const EP = () => process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com';
const DEV = () => process.env.TUYA_HEATER_ID || 'bfe63ca3086095e88en9ef';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', SECRET()).update(s).digest('hex').toUpperCase();

let tok = null, tokExp = 0;
async function request(method, p, body, auth = true) {
  if (!ID() || !SECRET()) throw new Error('TUYA_ACCESS_ID / TUYA_ACCESS_SECRET not set');
  if (auth && (!tok || Date.now() > tokExp)) {
    const r = await request('GET', '/v1.0/token?grant_type=1', null, false);
    tok = r.access_token; tokExp = Date.now() + (r.expire_time - 60) * 1000;
  }
  const t = Date.now().toString(), bodyStr = body ? JSON.stringify(body) : '';
  const [p0, q0] = p.split('?'), sortedPath = q0 ? p0 + '?' + q0.split('&').sort().join('&') : p0;   // Tuya signs the query with its keys sorted
  const sign = hmac(ID() + (auth ? tok : '') + t + [method, sha256(bodyStr), '', sortedPath].join('\n'));
  const headers = { client_id: ID(), sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
  if (auth) headers.access_token = tok;
  const res = await fetch(EP() + p, { method, headers, body: bodyStr || undefined });
  const j = await res.json();
  if (!j.success) { if (auth && /1010|1011|1012/.test(String(j.code))) tok = null; throw new Error(`Tuya ${j.code} ${j.msg}`); }
  return j.result;
}

// the device as the page shows it. temp_current is tenths of °C (314 = 31.4 °C); humidity_value 0 = no probe fitted
async function status() {
  const [d, st] = await Promise.all([request('GET', `/v1.0/iot-03/devices/${DEV()}`), request('GET', `/v1.0/iot-03/devices/${DEV()}/status`)]);
  const s = Object.fromEntries((Array.isArray(st) ? st : d.status || []).map(x => [x.code, x.value]));
  return {
    id: d.id, name: d.name || 'Water Heater', online: !!d.online, product: d.product_name,
    // a reading outside 0–110 °C is a probe glitch (a −28.0 showed once on 2026-10-20 between two 28.0s) — shown as unknown, never stored
    temp: typeof s.temp_current === 'number' && s.temp_current >= 0 && s.temp_current <= 1100 ? s.temp_current / 10 : null,
    humidity: s.humidity_value > 0 ? s.humidity_value : null,
    switches: { all: !!s.switch_all, ch1: !!s.switch_1, ch2: !!s.switch_2 },
    fault: s.fault || 0, raw: s,
    at: new Date().toISOString(),
  };
}

const CODES = new Set(['switch_all', 'switch_1', 'switch_2']);
async function set(code, value) {
  if (!CODES.has(code)) throw new Error('unknown switch ' + code);
  await request('POST', `/v1.0/iot-03/devices/${DEV()}/commands`, { commands: [{ code, value: !!value }] });
  await new Promise(r => setTimeout(r, 800));   // the cloud echoes the new state a moment later
  return status();
}

// the watch: a channel on for longer than HEATER_ON_HOURS → one message, then ✅ when it goes off; temperature over
// HEATER_MAX_TEMP → one message, then ✅ back under (5 °C below); offline > 1 h → one message; the Tuya trial expiry.
async function check(ctx, send) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('heaterWatch');
  const prev = (await ref.get()).data() || {}, now = Date.now(), msgs = [];
  const ON_H = +process.env.HEATER_ON_HOURS || 0, MAX_T = +process.env.HEATER_MAX_TEMP || 70;
  const st = { ...prev };
  let s = null;
  try { s = await status(); } catch (e) { st.lastError = e.message; }
  const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
  if (s) {
    st.lastError = null; st.last = { at: s.at, temp: s.temp, sw: s.switches, online: s.online };
    try { await sync(ctx, 16); } catch (e) { console.error('heater sync:', e.message); }   // the graph's points, from Tuya's own report log
    // (no "channel on too long" watch: nothing is wired to the module's relays — the heater is on the Sonoff, Mario 2026-10-20;
    //  HEATER_ON_HOURS=0 by default keeps it off; set it when a relay carries a load again)
    if (ON_H > 0) for (const ch of ['ch1', 'ch2']) {
      const on = s.online && s.switches.all && s.switches[ch], k = 'on_' + ch, o = st[k] || {};
      if (on) {
        const since = o.since || now;
        if (!o.told && now - since >= ON_H * 3600e3) { msgs.push(`♨️ Water heater — channel ${ch.slice(2)} on since ${hhmm(since)} (over ${ON_H} h), ${s.temp} °C`); st[k] = { since, told: true }; }
        else st[k] = { since, told: !!o.told };
      } else { if (o.told) msgs.push(`✅ Water heater — channel ${ch.slice(2)} off (was on since ${hhmm(o.since)})`); st[k] = {}; }
    }
    // temperature
    const hot = st.hot || {};
    if (s.temp != null && s.temp >= MAX_T && !hot.told) { msgs.push(`🔥 Water heater — ${s.temp} °C (limit ${MAX_T} °C)`); st.hot = { told: true, since: now }; }
    else if (s.temp != null && s.temp <= MAX_T - 5 && hot.told) { msgs.push(`✅ Water heater — back to ${s.temp} °C`); st.hot = {}; }
    // offline for an hour
    const off = st.off || {};
    if (!s.online) { const since = off.since || now; if (!off.told && now - since >= 3600e3) { msgs.push(`⚠ Water heater probe module offline since ${hhmm(since)}`); st.off = { since, told: true }; } else st.off = { since, told: !!off.told }; }
    else { if (off.told) msgs.push('✅ Water heater controller back online'); st.off = {}; }
    if (s.fault) { if (!st.faultTold) { msgs.push(`⚠ Water heater controller reports fault ${s.fault}`); st.faultTold = true; } } else st.faultTold = false;
  }
  // the free IoT Core trial (one data center) — Mario renews it on platform.tuya.com; 15 days before, once a day
  const exp = process.env.TUYA_TRIAL_EXPIRY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp || '')) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut' }).format(new Date());
    const left = Math.round((Date.UTC(+exp.slice(0, 4), +exp.slice(5, 7) - 1, +exp.slice(8, 10)) - Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))) / 864e5);
    if (left <= 15 && st.trialTold !== today) {
      msgs.push(`${left < 0 ? '🔴' : '🟡'} Tuya IoT Core trial ${left < 0 ? 'EXPIRED ' + (-left) + ' days ago' : left === 0 ? 'expires TODAY' : 'expires in ' + left + ' days'} (${exp}) — renew it on platform.tuya.com → Cloud → the "Shift Claude" project → Service API → IoT Core → Extend trial, then tell Claude the new date.`);
      st.trialTold = today;
    }
  }
  st.at = new Date().toISOString();
  await ref.set(st);
  if (msgs.length && send) await send(msgs.join('\n\n') + '\n\nhttps://hub.shift-group.co/energy/tuya');
  return { ok: !!s, sent: msgs.length, temp: s && s.temp, switches: s && s.switches, error: st.lastError || undefined };
}

// The temperature series for the graph comes from Tuya's own report log (GET /v2.0/cloud/thing/{id}/report-logs,
// ~1,300 reports a day, 7-day windows, 100 per page, rate-limited). The probe is noisy — a −28, a −7.4, a 19 between
// 28s — so each 10-minute bucket keeps the MEDIAN of its readings in 0–110 °C. Buckets live in one Firestore doc
// (meta/heaterTemps: pts [{t,c}], syncedTo, backTo), KEEP_DAYS back; sync() pulls what is new (and, a few pages a run,
// what is older) so a page view only reads the doc.
const KEEP_DAYS = 14, BUCKET = 10 * 60e3, PAGE = 100;
const tempsRef = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('meta').doc('heaterTemps');
const ok = c => c >= 0 && c <= 110;
// newest first; stops at maxPages or the rate limit — returns what it got and whether the window was finished
async function pullLogs(start, end, maxPages) {
  const out = []; let key = '', done = false;
  for (let i = 0; i < maxPages; i++) {
    let r;
    try { r = await request('GET', `/v2.0/cloud/thing/${DEV()}/report-logs?codes=temp_current&end_time=${end}&size=${PAGE}&start_time=${start}${key ? '&last_row_key=' + key : ''}`); }
    catch (e) { if (/frequent/i.test(e.message)) break; throw e; }
    for (const l of r.logs || []) out.push({ t: +l.event_time, c: +l.value / 10 });
    if (!r.has_more) { done = true; break; }
    key = r.last_row_key;
  }
  return { logs: out, done };
}
function bucketise(logs, into) {
  const by = {};
  for (const l of logs) if (ok(l.c)) (by[Math.floor(l.t / BUCKET) * BUCKET] ||= []).push(l.c);
  for (const [t, vs] of Object.entries(by)) { vs.sort((a, b) => a - b); into[t] = vs[Math.floor(vs.length / 2)]; }
}
async function sync(ctx, maxPages = 16) {
  const ref = tempsRef(ctx), d = (await ref.get()).data() || {}, now = Date.now(), floor = now - KEEP_DAYS * 864e5;
  const map = {}; for (const p of d.pts || []) if (p.t >= floor && ok(p.c)) map[p.t] = p.c;
  let syncedTo = d.syncedTo || 0, backTo = d.backTo || 0, pages = 0;
  // forward: from the last synced bucket (re-read, it may have been half full) to now, 7 days at most per Tuya window
  const fwdStart = Math.max(syncedTo ? syncedTo - BUCKET : now - 864e5, now - 7 * 864e5 + 1);
  const f = await pullLogs(fwdStart, now, Math.max(2, Math.ceil(maxPages / 2)));
  bucketise(f.logs, map); pages += Math.ceil(f.logs.length / PAGE) || 1;
  if (f.done) syncedTo = now; else if (f.logs.length) syncedTo = Math.min(...f.logs.map(l => l.t));   // newest-first pages: the oldest fetched is where we stopped
  if (!backTo) backTo = fwdStart;
  // backward: older history, a few pages a run, down to KEEP_DAYS (Tuya keeps about a week)
  const left = maxPages - pages;
  if (left > 0 && backTo > floor) {
    const end = backTo - 1, start = Math.max(floor, end - 7 * 864e5 + 1);
    const b = await pullLogs(start, end, left);
    bucketise(b.logs, map);
    if (b.done) backTo = start; else if (b.logs.length) backTo = Math.min(...b.logs.map(l => l.t));
    if (!b.logs.length) backTo = start;   // nothing older in that window — Tuya's retention ends here
  }
  const pts = Object.keys(map).map(t => ({ t: +t, c: map[t] })).sort((a, b) => a.t - b.t);
  await ref.set({ pts, syncedTo, backTo, at: new Date(now).toISOString() });
  return { points: pts.length, syncedTo, backTo };
}
async function history(ctx, days = 1) {
  const d = (await tempsRef(ctx).get()).data() || {}, from = Date.now() - Math.min(days, KEEP_DAYS) * 864e5;
  const pts = (d.pts || []).filter(p => p.t >= from && ok(p.c));
  return { pts, syncedTo: d.syncedTo || 0, backTo: d.backTo || 0 };
}

module.exports = { status, set, check, history, sync };
