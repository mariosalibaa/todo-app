// /mahab — the Taan / Machmouchi plant (Dr Nazih Taan & Dr Mahab Machmouchi, 25 kWp, DeyeCloud station 62112463)
// in kWh per day: solar, the grid port (EDL), the generator port, load, battery. Same recipe as the CPR plant
// (deye-calc.integrate over the 5-min Power Profile), same DeyeCloud account and token (deye.token).
//
// Days come from three places, first match wins:
//   mahab-history.json   built once (tmp/energy-hub/mahab-history-build.js) — first reading 2026-04-29 → its `last`
//   Firestore energyMahab/<day>   later days, written by the nightly cron (/api/cron/deye) or a page load
//   today                read live, kept 10 min in memory
//
// Wiring (site sketch "20260704 mahab gen control.pdf"): from 2 Jul 2026 EDL and the two generators reach the
// inverter through ATSs on ONE input, the generator port — so from then on the generator figure is EDL + generators
// together; DeyeCloud cannot tell them apart. Before that, EDL was on the grid port and there was no generator.

const D = require('./deye-calc');
const deye = require('./deye');
const HISTORY = require('./mahab-history.json');

const STATION = 62112463;
const FIELDS = HISTORY.fields;   // ['pv', 'gen', 'genOut', 'gridIn', 'gridOut', 'use', 'charge', 'discharge', 'n']
const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('energyMahab');

let todayCache = { at: 0, day: null, v: null };

async function fetchDay(ctx, ymd) {
  try { return D.integrate(await D.dayRecords(await deye.token(ctx), ymd, STATION)); }
  catch (e) {
    if (!/401|500/.test(e.message) || !(process.env.DEYE_USER && process.env.DEYE_PASS)) throw e;
    return D.integrate(await D.dayRecords(await deye.token(ctx, true), ymd, STATION));
  }
}

// missing days after the history (or short ones from the last 3 days — Deye uploads late), at most `max` per call
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

async function days(ctx) {
  const out = { station: STATION, atsFrom: '2026-07-02', fields: FIELDS, days: HISTORY.days.slice(), data: HISTORY.data.slice(), error: null, left: 0 };
  try {
    const f = await fill(ctx, 8);
    out.left = f.left;
    const today = beirutToday();
    for (let d = addDays(HISTORY.last, 1); d < today; d = addDays(d, 1)) { const v = f.have[d]; out.days.push(d); out.data.push(v ? FIELDS.map(k => v[k]) : null); }
    if (!(todayCache.day === today && Date.now() - todayCache.at < 10 * 60000)) todayCache = { at: Date.now(), day: today, v: await fetchDay(ctx, today) };
    out.days.push(today); out.data.push(FIELDS.map(k => todayCache.v[k]));
    out.today = today;
  } catch (e) {
    out.error = String(e.message || e);
    console.error('mahab:', out.error);
  }
  // which source fed the plant, per day (Mario 2026-10-20) — see sources() below
  let src = null;
  try { const s = await sources(ctx); src = s.docs; delete s.docs; out.sources = s; }
  catch (e) { out.sources = null; console.error('mahab sources:', e.message); }
  // site meter readings (Mario 2026-10-03: "record the meters reading … gen1, gen2, EDL, sum of all 3") — Firestore
  // mahabMeters/<yyyy-mm-dd_hhmm>, Beirut time, photos in Dropbox "00. PARTNER\mahab machmouche\meter readings"
  try { out.meters = await meters(ctx, src); }
  catch (e) { out.meters = []; console.error('mahab meters:', e.message); }
  return out;
}

// ── Gen 1 / Gen 2 / EDL from the grid port's voltage and frequency (Mario 2026-10-20) ──────────────────────────
// Since the morning of 2 Oct 2026 all three sources reach the inverter on its GRID port (wirePower), one at a time
// through the ATSs. Each has its own fingerprint in the inverter's 2-minute series (G_V_L1..3, PG_F1):
//   Gen 2 (meter 0719, "A")  ≈ 221 V, 50.00 Hz steady      Gen 1 (meter 0717)  ≈ 230 V, 50.00 Hz steady
//   EDL                     frequency wanders 48.8–50.7 Hz
// Rule: Hz off 50 by > 0.15 in ≥ 4 of the 11 samples around → EDL (a lone 50.25 is noise); else mean V < 226.5 → Gen 2,
// else Gen 1; V < 150 → nothing. Checked 3 → 19 Oct against the site meters: Gen 2 367.8 vs +378, Gen 1 263.1 vs +277,
// EDL 11.3 vs +12. Each finished day is kept in Firestore mahabSources/<day> (t, class, W per sample) so meter
// windows are summed without reading DeyeCloud again; today is read live, kept 10 min.
const INVERTER = 10243707, SRC_FROM = '2026-10-02', SRC = { 1: 'gen1', 2: 'gen2', e: 'edl', o: 'off' };
const srcCol = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabSources');
let srcToday = { at: 0, day: null, v: null };

async function srcDay(ctx, ymd) {   // → { day, t: [unix], c: '12eo…', p: [W, + import] }
  const r = await fetch(`https://www.deyecloud.com/device-s/device/${INVERTER}/stats/day?day=${ymd.replace(/-/g, '%2F')}&lan=en`,
    { headers: { Authorization: 'bearer ' + await deye.token(ctx), Accept: 'application/json' } });
  if (!r.ok) throw new Error('DeyeCloud ' + r.status);
  const S = {};
  for (const p of await r.json()) if (['G_V_L1', 'G_V_L2', 'G_V_L3', 'PG_F1', 'PG_Pt1'].includes(p.storageName))
    S[p.storageName] = new Map((p.detailList || []).map(x => [+x.collectionTime, +x.value]));
  const g = (k, t) => (S[k] && S[k].get(t)) || 0;
  const rows = [...(S.G_V_L1 || new Map()).keys()].sort((a, b) => a - b)
    .map(t => ({ t, v: (g('G_V_L1', t) + g('G_V_L2', t) + g('G_V_L3', t)) / 3, hz: g('PG_F1', t), p: Math.round(g('PG_Pt1', t)) }));
  const c = rows.map((r, i) => {
    if (r.v < 150) return 'o';
    const off = rows.slice(Math.max(0, i - 5), i + 6).filter(x => x.v > 150 && Math.abs(x.hz - 50) > 0.15).length;
    return off >= 4 ? 'e' : r.v < 226.5 ? '2' : '1';
  }).join('');
  const L = rows[rows.length - 1];
  return { day: ymd, t: rows.map(r => r.t), c, p: rows.map(r => r.p), last: L ? { v: Math.round(L.v * 10) / 10, hz: L.hz } : null };
}

// samples → { gen1: { h, in, out }, gen2, edl, off } between two unix times (each sample held ≤ 4 min)
function tally(docs, from = 0, to = Infinity) {
  const o = { gen1: { h: 0, in: 0, out: 0 }, gen2: { h: 0, in: 0, out: 0 }, edl: { h: 0, in: 0, out: 0 }, off: { h: 0, in: 0, out: 0 } };
  for (const d of docs) for (let i = 0; i < d.t.length; i++) {
    const t = d.t[i]; if (t < from || t >= to) continue;
    const dt = Math.min(240, (d.t[i + 1] || t + 120) - t) / 3600, k = o[SRC[d.c[i]]];
    k.h += dt; if (d.p[i] > 0) k.in += d.p[i] * dt / 1000; else k.out -= d.p[i] * dt / 1000;
  }
  for (const k in o) for (const f in o[k]) o[k][f] = Math.round(o[k][f] * 10) / 10;
  return o;
}

// one day → when each source ran, Beirut time: { gen1: ['00:00–06:00', …], … } (Mario 2026-10-20: "from which hour
// to which hour"). Runs under 10 min are switch-over noise and are dropped; the same source again within 10 min is one run.
const hhmm = t => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
function spans(d) {
  const runs = [];
  for (let i = 0; i < d.t.length; i++) {
    const k = SRC[d.c[i]], end = d.t[i] + Math.min(240, (d.t[i + 1] || d.t[i] + 120) - d.t[i]), r = runs[runs.length - 1];
    if (r && r.k === k) r.b = end; else runs.push({ k, a: d.t[i], b: end });
  }
  const out = {};
  for (const r of runs.filter(r => r.b - r.a >= 600)) {
    const list = out[r.k] = out[r.k] || [], last = list[list.length - 1];
    if (last && r.a - last.b < 600) last.b = r.b; else list.push({ a: r.a, b: r.b });
  }
  // the time view (Mario 2026-10-20): every run as [source, from minute, to minute] of the Beirut day, 0–1440
  const min = t => { const [h, m] = hhmm(t).split(':'); return +h * 60 + +m; };
  const bar = [];
  for (const k in out) for (const r of out[k]) { const a = min(r.a), b = min(r.b); bar.push([k, a, b < a ? 1440 : b]); }
  bar.sort((x, y) => x[1] - y[1]);
  for (const k in out) out[k] = out[k].map(r => { const a = hhmm(r.a), b = hhmm(r.b); return `${a}–${b < a ? '24:00' : b}`; });
  out.bar = bar;
  return out;
}

// finished days from Firestore (at most `max` read from DeyeCloud per call) + today live
async function srcDocs(ctx, max = 3) {
  const today = beirutToday(), have = {};
  (await srcCol(ctx).get()).forEach(d => { have[d.id] = d.data(); });
  let n = 0;
  for (let d = SRC_FROM; d < today && n < max; d = addDays(d, 1)) {
    if (have[d]) continue;
    have[d] = await srcDay(ctx, d); n++;
    if (have[d].t.length) await srcCol(ctx).doc(d).set(have[d]);
    await sleep(1100);
  }
  if (!(srcToday.day === today && Date.now() - srcToday.at < 10 * 60000)) srcToday = { at: Date.now(), day: today, v: await srcDay(ctx, today) };
  have[today] = srcToday.v;
  return have;
}
async function sources(ctx) {
  const docs = await srcDocs(ctx), days = {};
  for (const d of Object.keys(docs).sort()) {
    days[d] = tally([docs[d]]);
    const sp = spans(docs[d]);
    for (const [k, list] of Object.entries(sp)) if (days[d][k]) days[d][k].spans = list;
    days[d].bar = sp.bar;
  }
  const t = srcToday.v, i = t ? t.t.length - 1 : -1;
  return { from: SRC_FROM, days, now: i >= 0 ? { src: SRC[t.c[i]], at: t.t[i], ...t.last } : null, docs };
}

// Mario's check (2026-10-03): what the three site meters (Gen 1 + Gen 2 + EDL) advance between two readings must
// equal DeyeCloud's grid import + export over exactly that time (2 Oct 09:31 → 14:15: meters 41, Deye 41.7).
// Each reading after the first gets that window integrated from the 5-min series and kept on its doc (`deye`), so
// it is read from DeyeCloud once. Windows over 31 days are skipped (too many day reads for one page load).
const toSec = at => new Date(at.replace(' ', 'T') + ':00+03:00').getTime() / 1000;
async function meters(ctx, src) {
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabMeters');
  const docs = (await ref.get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.at < b.at ? -1 : 1);
  for (let i = 1; i < docs.length; i++) {
    const p = docs[i - 1], m = docs[i];
    if (m.deye && m.deye.from === p.at) continue;
    const a = toSec(p.at), b = toSec(m.at);
    if (b > Date.now() / 1000 - 600 || b - a > 31 * 86400) continue;   // Deye uploads late: wait 10 min after the reading
    const recs = [];
    for (let d = p.at.slice(0, 10); d <= m.at.slice(0, 10); d = addDays(d, 1)) {
      recs.push(...await D.dayRecords(await deye.token(ctx), d, STATION));
      await sleep(1100);
    }
    const v = D.integrate(recs.filter(r => r.dateTime >= a && r.dateTime < b));
    m.deye = { from: p.at, gridIn: v.gridIn, gridOut: v.gridOut, gen: v.gen, genOut: v.genOut, n: v.n };
    await ref.doc(m.id).set({ deye: m.deye }, { merge: true });
  }
  // the same window split by source (V + Hz above) — each meter against its own share of Deye
  if (src) for (let i = 1; i < docs.length; i++) {
    const p = docs[i - 1], m = docs[i];
    if (!m.deye || (m.split && m.split.from === p.at) || p.at.slice(0, 10) < SRC_FROM) continue;
    const ds = []; for (let d = p.at.slice(0, 10); d <= m.at.slice(0, 10); d = addDays(d, 1)) ds.push(d);
    if (ds.some(d => !src[d] || d === beirutToday())) continue;   // wait until every day of the window is stored
    m.split = { from: p.at, ...tally(ds.map(d => src[d]), toSec(p.at), toSec(m.at)) };
    await ref.doc(m.id).set({ split: m.split }, { merge: true });
  }
  return docs;
}

module.exports = { days, fill, srcDocs, STATION };
