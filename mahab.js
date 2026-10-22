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
    // final once written after noon of the day after (Deye's late uploads are in); before that read again, at most
    // once an hour. (Was: n < 280 in the last 3 days — a day DeyeCloud logged short stays short, so every page load
    // read those days again; same fix as Tohme, 2026-10-22.)
    if (!h) todo.push(d);
    else if (!(h.at >= addDays(d, 1) + 'T09:00:00Z') && !(Date.now() - Date.parse(h.at) < 3600e3)) todo.push(d);
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

// live = false: Firestore only, today as last kept (plant-today.js) — the page's first paint, ~1 s.
// live = true: the page's second call when the first said `stale` — today read again when over 10 min old, missing
// days read from DeyeCloud (Mario 2026-10-22: "loading is taking time — fix it the way you fixed Tohme").
async function days(ctx, { live = false } = {}) {
  const out = { station: STATION, atsFrom: '2026-07-02', fields: FIELDS, days: HISTORY.days.slice(), data: HISTORY.data.slice(), error: null, left: 0, stale: false };
  const today = beirutToday();
  const [, src] = await Promise.all([
    (async () => {
      try {
        const [f, td] = await Promise.all([fill(ctx, live ? 8 : 0), T.today(ctx, 'mahab', today, () => fetchDay(ctx, today), { live })]);
        out.left = f.left; if (td.stale || f.left > 0) out.stale = true; out.todayAt = new Date(td.at).toISOString();
        for (let d = addDays(HISTORY.last, 1); d < today; d = addDays(d, 1)) { const v = f.have[d]; out.days.push(d); out.data.push(v ? FIELDS.map(k => v[k]) : null); }
        out.days.push(today); out.data.push(FIELDS.map(k => td.v[k]));
        out.today = today;
      } catch (e) {
        out.error = String(e.message || e);
        console.error('mahab:', out.error);
      }
    })(),
    // which source fed the plant, per day (Mario 2026-10-20) — see sources() below
    sources(ctx, { live }).catch(e => { console.error('mahab sources:', e.message); return null; }),
  ]);
  if (src) { if (src.stale) out.stale = true; delete src.stale; }
  out.sources = src;
  // site meter readings (Mario 2026-10-03: "record the meters reading … gen1, gen2, EDL, sum of all 3") — Firestore
  // mahabMeters/<yyyy-mm-dd_hhmm>, Beirut time, photos in Dropbox "00. PARTNER\mahab machmouche\meter readings"
  try { const m = await meters(ctx, { live }); if (m.pending) out.stale = true; out.meters = m.docs; }
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
// each finished day's figures (tally + spans + peakOut, ~4 KB) are kept apart in mahabSourceDays/<day> as JSON, so a
// page load reads those and not the raw 2-minute days (~24 KB each, 474 KB by 22 Oct 2026). SUM_V: bump when the
// figures change → re-made from the raw days.
const SUM_V = 1;
const sumCol = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabSourceDays');
const T = require('./plant-today');

async function srcDay(ctx, ymd) {   // → { day, t: [unix], c: '12eo…', p: [W, + import], s: [battery SOC %] }
  const r = await fetch(`https://www.deyecloud.com/device-s/device/${INVERTER}/stats/day?day=${ymd.replace(/-/g, '%2F')}&lan=en`,
    { headers: { Authorization: 'bearer ' + await deye.token(ctx), Accept: 'application/json' } });
  if (!r.ok) throw new Error('DeyeCloud ' + r.status);
  const S = {};
  for (const p of await r.json()) if (['G_V_L1', 'G_V_L2', 'G_V_L3', 'PG_F1', 'PG_Pt1', 'B_left_cap1'].includes(p.storageName))
    S[p.storageName] = new Map((p.detailList || []).map(x => [+x.collectionTime, +x.value]));
  const g = (k, t) => (S[k] && S[k].get(t)) || 0;
  const rows = [...(S.G_V_L1 || new Map()).keys()].sort((a, b) => a - b)
    .map(t => ({ t, v: (g('G_V_L1', t) + g('G_V_L2', t) + g('G_V_L3', t)) / 3, hz: g('PG_F1', t), p: Math.round(g('PG_Pt1', t)), s: Math.round(g('B_left_cap1', t)) }));
  const c = rows.map((r, i) => {
    if (r.v < 150) return 'o';
    const off = rows.slice(Math.max(0, i - 5), i + 6).filter(x => x.v > 150 && Math.abs(x.hz - 50) > 0.15).length;
    return off >= 4 ? 'e' : r.v < 226.5 ? '2' : '1';
  }).join('');
  const L = rows[rows.length - 1];
  return { day: ymd, t: rows.map(r => r.t), c, p: rows.map(r => r.p), s: rows.map(r => r.s), last: L ? { v: Math.round(L.v * 10) / 10, hz: L.hz } : null };
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
    if (r && r.k === k) { r.b = end; r.ib = i; } else runs.push({ k, a: d.t[i], b: end, ia: i, ib: i });
  }
  const out = {};
  for (const r of runs.filter(r => r.b - r.a >= 600)) {
    const list = out[r.k] = out[r.k] || [], last = list[list.length - 1];
    if (last && r.a - last.b < 600) { last.b = r.b; last.ib = r.ib; } else list.push({ a: r.a, b: r.b, ia: r.ia, ib: r.ib });
  }
  // the time view (Mario 2026-10-20): every run as [source, from minute, to minute] of the Beirut day, 0–1440
  const min = t => { const [h, m] = hhmm(t).split(':'); return +h * 60 + +m; };
  const bar = [];
  // kWh in / out of each stretch, its own samples only (Mario 2026-10-20: "amount import and export next to each timing")
  for (const k in out) for (const r of out[k]) {
    r.in = 0; r.out = 0;
    for (let i = r.ia; i <= r.ib; i++) if (SRC[d.c[i]] === k) {
      const kwh = d.p[i] * Math.min(240, (d.t[i + 1] || d.t[i] + 120) - d.t[i]) / 3600 / 1000;
      if (kwh > 0) r.in += kwh; else r.out -= kwh;
    }
    r.in = Math.round(r.in * 10) / 10; r.out = Math.round(r.out * 10) / 10;
  }
  for (const k in out) for (const r of out[k]) { const a = min(r.a), b = min(r.b); bar.push([k, a, b < a ? 1440 : b, r.in, r.out]); }
  bar.sort((x, y) => x[1] - y[1]);
  // battery SOC at the start and the end of each stretch (Mario 2026-10-20) — shown on the page only when asked
  const soc = i => d.s ? d.s[i] : null;
  for (const k in out) out[k] = out[k].map(r => { const a = hhmm(r.a), b = hhmm(r.b); return { t: `${a}–${b < a ? '24:00' : b}`, s0: soc(r.ia), s1: soc(r.ib), in: r.in, out: r.out }; });
  out.bar = bar;
  // the SOC line for the time view: one point every ~10 min, [minute, %]
  out.soc = d.s ? d.t.map((t, i) => [min(t), d.s[i]]).filter((x, i) => i % 5 === 0 || i === d.t.length - 1) : [];
  return out;
}

// one raw day → the figures the page shows
function figures(doc) {
  const o = tally([doc]);
  const sp = spans(doc);
  for (const k of ['gen1', 'gen2', 'edl', 'off']) if (sp[k]) o[k].spans = sp[k];
  o.bar = sp.bar; o.soc = sp.soc;
  // the highest kW sent back while each source was on (Mario 2026-10-20: the generator owner checks it against his
  // load, so his generator never drops under 20 % of its size) — W, from the 2-minute readings
  for (const k of ['gen1', 'gen2', 'edl']) o[k].peakOut = 0;
  doc.p.forEach((w, i) => { const k = SRC[doc.c[i]]; if (w < 0 && o[k]) o[k].peakOut = Math.max(o[k].peakOut, -w); });
  return o;
}

// a raw finished day: Firestore, else (live only) DeyeCloud — kept for the meter windows and the export chart.
// Days stored before the SOC was kept (no `s`) are read again on a live call.
const rawMem = new Map();
async function rawDay(ctx, d, live) {
  if (rawMem.has(d)) return rawMem.get(d);
  let v = (await srcCol(ctx).doc(d).get()).data();
  if (!(v && v.s) && live) { v = await srcDay(ctx, d); if (v.t.length) await srcCol(ctx).doc(d).set(v); await sleep(1100); }
  if (v && v.s) { if (rawMem.size > 40) rawMem.delete(rawMem.keys().next().value); rawMem.set(d, v); }
  return v || null;
}
const todaySrc = (ctx, live) => T.today(ctx, 'mahabSrc', beirutToday(), () => srcDay(ctx, beirutToday()), { live });

async function sources(ctx, { live = false } = {}) {
  const today = beirutToday(), days = {}, seen = new Set();
  const [sums, td] = await Promise.all([sumCol(ctx).get(), todaySrc(ctx, live)]);
  sums.forEach(x => { const d = x.data(); if (d.v === SUM_V && d.day < today) { seen.add(d.day); days[d.day] = JSON.parse(d.j); } });
  let n = 0, stale = td.stale;
  for (let d = SRC_FROM; d < today; d = addDays(d, 1)) {
    if (seen.has(d)) continue;
    if (n++ >= 6) { stale = true; continue; }   // a few a call; the rest on the next one
    const raw = await rawDay(ctx, d, live);
    if (raw && raw.t && raw.t.length) days[d] = figures(raw);
    if (!(raw && raw.s)) { stale = true; continue; }
    await sumCol(ctx).doc(d).set({ day: d, v: SUM_V, j: JSON.stringify(days[d] || null), at: new Date().toISOString() });
  }
  for (const d in days) if (!days[d]) delete days[d];
  const t = td.v, i = t ? t.t.length - 1 : -1;
  if (t && t.t.length) days[today] = figures(t);
  return { from: SRC_FROM, days, now: i >= 0 ? { src: SRC[t.c[i]], at: t.t[i], ...t.last } : null, stale };
}

// Mario's check (2026-10-03): what the three site meters (Gen 1 + Gen 2 + EDL) advance between two readings must
// equal DeyeCloud's grid import + export over exactly that time (2 Oct 09:31 → 14:15: meters 41, Deye 41.7).
// Each reading after the first gets that window integrated from the 5-min series and kept on its doc (`deye`), so
// it is read from DeyeCloud once. Windows over 31 days are skipped (too many day reads for one page load).
const toSec = at => new Date(at.replace(' ', 'T') + ':00+03:00').getTime() / 1000;
async function meters(ctx, { live = false } = {}) {
  let pending = false;
  const ref = ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('mahabMeters');
  const docs = (await ref.get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.at < b.at ? -1 : 1);
  for (let i = 1; i < docs.length; i++) {
    const p = docs[i - 1], m = docs[i];
    if (m.deye && m.deye.from === p.at) continue;
    const a = toSec(p.at), b = toSec(m.at);
    if (b > Date.now() / 1000 - 600 || b - a > 31 * 86400) continue;   // Deye uploads late: wait 10 min after the reading
    if (!live) { pending = true; continue; }   // a DeyeCloud read: left to the page's live call
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
  for (let i = 1; i < docs.length; i++) {
    const p = docs[i - 1], m = docs[i];
    if (!m.deye || (m.split && m.split.from === p.at) || p.at.slice(0, 10) < SRC_FROM) continue;
    const ds = []; for (let d = p.at.slice(0, 10); d <= m.at.slice(0, 10); d = addDays(d, 1)) ds.push(d);
    if (ds.includes(beirutToday())) continue;   // wait until every day of the window is stored
    const raws = []; for (const d of ds) raws.push(await rawDay(ctx, d, live));
    if (raws.some(r => !(r && r.s))) { pending = true; continue; }
    m.split = { from: p.at, ...tally(raws, toSec(p.at), toSec(m.at)) };
    await ref.doc(m.id).set({ split: m.split }, { merge: true });
  }
  return { docs, pending };
}

// one day's 2-minute series for the export chart: { day, t, c, p } (finished days from Firestore, today live)
async function srcSeries(ctx, ymd) {
  if (ymd === beirutToday()) { const v = (await todaySrc(ctx, true)).v; return { day: ymd, t: v.t, c: v.c, p: v.p }; }
  const d = (await srcCol(ctx).doc(ymd).get()).data();
  return d ? { day: ymd, t: d.t, c: d.c, p: d.p } : null;
}

module.exports = { days, fill, sources, srcSeries, STATION };
