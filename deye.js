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

module.exports = { days, fill, FIELDS };
