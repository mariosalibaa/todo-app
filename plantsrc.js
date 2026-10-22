// Which source fed a plant, day by day — Bookstop Kaslique and McKinsey Electronics (Mario 2026-10-20: "add bookstop,
// mckinsey", same idea as /energy/plants/mahab). Pages: /energy/plants/<key> (plant-src.html), API /api/plant-src?p=<key>.
//
//   Bookstop   SOLARMAN 2596285, 3 × 12 kW Deye in parallel. EDL, the small generator (80 kW) and the big one (150 kW)
//              come in on the GRID port through an ATS; each has its own frequency (memory bookstop-kaslique-solarman):
//              EDL ≈ 50.0 Hz steady · the big gen 49.3 Hz at its 24 kW, rising toward 50.5 Hz as the load drops ·
//              small gen idles at 51.6–51.8 Hz and the inverters REFUSE it (import ≈ 0, the battery drains — 3 Oct 2026),
//              loaded it hunts 48–50.7 Hz. Mario 2026-10-20: the refused one is the small gen; no kWh meters on site.
//   McKinsey   DeyeCloud 61438093, 2 × 50 kW (M1 + S2). No EDL. One generator on the GEN port — 30 kVA now; history
//              (Mario 2026-10-20): 30 kVA (sent to the Bekaa) → 150 kVA (bought, sold) → 30 kVA (another, on site);
//              a new 150 kVA is bought, not yet installed.
//
// One day = the inverters' day series (plants.daySeries: DeyeCloud /device-s/…/stats/day, Solarman the same path), on the
// master's clock, slaves lined up by time and summed: t, class per sample, source W (+ = into the plant), solar W, load W,
// SOC %. Finished days are kept in Firestore plantSources/<key>_<day>; today is read live, kept 10 min. Nothing here
// writes to an inverter.

const P = require('./plants');

const PLANTS = {
  bookstop: {
    name: 'Bookstop Kaslique', src: 'solarman', id: 2596285, kwp: 44.85, from: '2026-10-01', port: 'grid',
    lead: '3 × 12 kW Deye in parallel · EDL and two generators on one input through the ATS',
    classes: { e: 'EDL', g: 'Generator (big or small)', r: 'Small generator — refused' },
  },
  mckinsey: {
    name: 'McKinsey Electronics', src: 'deye', id: 61438093, kwp: 120, from: '2026-10-01', port: 'gen',
    lead: '2 × 50 kW Deye (M1 + S2) · no EDL · the generator on the generator input',
    classes: { g: 'Generator (30 kVA)' },
    history: 'Generators on site: 30 kVA (moved to the Bekaa) → 150 kVA (bought, then sold) → 30 kVA (another one, on site now). A new 150 kVA is bought, not yet installed.',
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const beirutDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const hhmm = t => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
const minOf = t => { const [h, m] = hhmm(t).split(':'); return +h * 60 + +m; };
const col = (ctx, key) => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('plantSources');
// a slave's value nearest to t (within 5½ min — Solarman samples every 5 min, the inverters a few seconds apart)
const near = (a, t) => { if (!a || !a.length) return null; let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; }
  let best = null; for (const i of [lo - 1, lo]) if (a[i] && Math.abs(a[i][0] - t) <= 330 && (!best || Math.abs(a[i][0] - t) < Math.abs(best[0] - t))) best = a[i];
  return best ? best[1] : null; };

function classify(key, rows) {
  if (key === 'mckinsey') return rows.map(r => r.v > 150 || Math.abs(r.p) > 300 ? 'g' : 'o').join('');
  // Bookstop: by frequency, looking at ±2 samples (±10 min) so one odd reading does not flip the source
  return rows.map((r, i) => {
    if (r.v < 150) return 'o';
    if (r.hz > 51.3) return 'r';
    const w = rows.slice(Math.max(0, i - 2), i + 3).filter(x => x.v > 150 && x.hz > 40).map(x => x.hz).sort((a, b) => a - b);
    if (!w.length) return 'g';
    if (w.every(h => h >= 49.8 && h <= 50.2)) return 'e';
    // a generator's frequency follows its load (the big one: 49.3 Hz at 24 kW, 50.5 Hz at 4 kW) and the voltages overlap
    // (218–231 V for both), so the two running generators are not told apart — one class (checked 2026-10-20, 1–20 Oct)
    return 'g';
  }).join('');
}

const devMem = new Map();   // key → { at, inv } — the inverter list barely changes; kept 6 h
async function readDay(ctx, key, ymd) {
  const cfg = PLANTS[key];
  let dm = devMem.get(key);
  if (!(dm && Date.now() - dm.at < 6 * 3600e3)) { dm = { at: Date.now(), inv: (await P.devices(ctx, cfg.src, String(cfg.id))).filter(d => d.type === 'inverter') }; if (dm.inv.length) devMem.set(key, dm); }
  const inv = dm.inv;
  // no inverter listed = the sign-in or the cloud failed, not an empty day — never kept as one (2026-10-22)
  if (!inv.length) throw new Error((cfg.src === 'solarman' ? 'SOLARMAN' : 'DeyeCloud') + ': no inverter listed');
  const master = inv.find(d => /^M/i.test(d.role || '')) || inv[0];
  const S = {};
  // the inverters side by side, not one after the other (each day series is 1.4–7 MB)
  await Promise.all(inv.map(async d => { try { S[d.id] = await P.daySeries(ctx, cfg.src, d.id, ymd); } catch (e) { S[d.id] = {}; } }));
  const m = S[master.id] || {}, clock = (m.S_P_T || m.B_left_cap1 || m.G_V_L1 || []).map(x => x[0]);
  const at = (d, k, t) => d.id === master.id ? near(m[k], t) : near((S[d.id] || {})[k], t);
  const sum = (k, t) => inv.reduce((s, d) => s + (+at(d, k, t) || 0), 0);
  const vKey = cfg.port === 'gen' ? 'GEN_V_L1' : 'G_V_L1', pKey = cfg.port === 'gen' ? 'GEN_P_T' : 'PG_Pt1';
  const rows = clock.map(t => ({ t, v: +near(m[vKey], t) || 0, hz: +near(m.PG_F1, t) || 0, p: Math.round(sum(pKey, t)),
    pv: Math.round(sum('S_P_T', t)), l: Math.round(sum('E_Puse_t1', t)), s: Math.round(+near(m.B_left_cap1, t) || 0) }));
  return { day: ymd, t: rows.map(r => r.t), c: classify(key, rows), p: rows.map(r => r.p), pv: rows.map(r => r.pv),
    l: rows.map(r => r.l), s: rows.map(r => r.s), hz: rows.map(r => Math.round(r.hz * 100) / 100), v: rows.map(r => Math.round(r.v * 10) / 10) };
}

// one stored day → the figures the page shows
function summary(key, raw) {
  const cls = Object.keys(PLANTS[key].classes);
  const d = key === 'bookstop' ? { ...raw, c: raw.c.replace(/[bs]/g, 'g') } : raw;   // days stored before 2026-10-20 split big / small
  const o = { pv: 0, load: 0, socMin: null, socMax: null, full: 0, n: d.t.length, src: {} };
  for (const k of cls) o.src[k] = { h: 0, in: 0, out: 0 };
  const dt = i => Math.min(600, (d.t[i + 1] || d.t[i] + 300) - d.t[i]) / 3600;   // hours this sample stands for (≤ 10 min)
  for (let i = 0; i < d.t.length; i++) {
    const h = dt(i), s = d.s[i];
    o.pv += d.pv[i] * h / 1000; o.load += d.l[i] * h / 1000;
    if (s > 0) { o.socMin = o.socMin == null ? s : Math.min(o.socMin, s); o.socMax = Math.max(o.socMax || 0, s); }
    if (s >= 99 && d.pv[i] > 500) o.full += h;   // battery full while the sun is up: the solar is being held back
    const k = o.src[d.c[i]]; if (!k) continue;
    k.h += h; if (d.p[i] > 0) k.in += d.p[i] * h / 1000; else k.out -= d.p[i] * h / 1000;
  }
  // stretches per source (≥ 10 min, the same source again within 10 min = one), with kWh and SOC start → end
  const runs = [];
  for (let i = 0; i < d.t.length; i++) {
    const k = d.c[i], end = d.t[i] + dt(i) * 3600, r = runs[runs.length - 1];
    if (r && r.k === k) { r.b = end; r.ib = i; } else runs.push({ k, a: d.t[i], b: end, ia: i, ib: i });
  }
  const merged = [];
  for (const r of runs.filter(r => r.k !== 'o' && r.b - r.a >= 600)) {
    const l = merged.filter(x => x.k === r.k).pop();
    if (l && l === merged[merged.length - 1] && r.a - l.b < 600) { l.b = r.b; l.ib = r.ib; } else merged.push({ ...r });
  }
  o.bar = merged.map(r => {
    let kin = 0, kout = 0; for (let i = r.ia; i <= r.ib; i++) if (d.c[i] === r.k) { const e = d.p[i] * dt(i) / 1000; if (e > 0) kin += e; else kout -= e; }
    const a = minOf(r.a), b = minOf(r.b);
    return [r.k, a, b < a ? 1440 : b, Math.round(kin * 10) / 10, Math.round(kout * 10) / 10, d.s[r.ia], d.s[r.ib]];
  });
  // the refused source (Bookstop): when, how long, how far the battery fell, the frequency it sat at
  o.refused = merged.filter(r => r.k === 'r').map(r => { const hz = d.hz ? d.hz.slice(r.ia, r.ib + 1).filter(x => x > 40) : [];
    return { a: hhmm(r.a), b: hhmm(r.b), min: Math.round((r.b - r.a) / 60), s0: d.s[r.ia], s1: d.s[r.ib], sMin: Math.min(...d.s.slice(r.ia, r.ib + 1)), hz: hz.length ? Math.max(...hz) : null }; });
  for (const k in o.src) for (const f in o.src[k]) o.src[k][f] = Math.round(o.src[k][f] * 10) / 10;
  o.pv = Math.round(o.pv * 10) / 10; o.load = Math.round(o.load * 10) / 10; o.full = Math.round(o.full * 10) / 10;
  return o;
}

// Firestore: plantSources/<key>_<day> = the raw day (t, c, p, pv, l, s, hz, v — kept for re-computing), and
// plantSourceDays/<key>_<day> = its summary as JSON (`j`, ~3 KB) — the page reads only these (Mario 2026-10-22: the
// raw days were ~10 KB each and every load re-summed them all). SUM_V: bump when summary() changes → re-summed from raw.
const SUM_V = 1;
const sumCol = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('plantSourceDays');
const T = require('./plant-today');

// live = false: Firestore only (today as last kept) — the page's first paint. live = true: today read again when
// over 10 min old, and up to `max` finished days not stored yet read from the cloud.
async function page(ctx, key, max, { live = false } = {}) {
  const cfg = PLANTS[key]; if (!cfg) throw new Error('unknown plant');
  const now = beirutDay(), days = {}, seen = new Set();
  const [sums, td] = await Promise.all([
    sumCol(ctx).where('key', '==', key).get(),
    T.today(ctx, 'src_' + key, now, () => readDay(ctx, key, now), { live })
      .catch(e => ({ v: { day: now, t: [], c: '', p: [], pv: [], l: [], s: [] }, at: Date.now(), stale: true, error: e.message })),
  ]);
  sums.forEach(x => { const d = x.data(); if (d.v === SUM_V && d.day < now) { seen.add(d.day); const v = JSON.parse(d.j); if (v) days[d.day] = v; } });
  let n = 0, left = 0;
  for (let d = cfg.from; d < now; d = addDays(d, 1)) {
    if (seen.has(d)) continue;
    let raw = (await col(ctx).doc(`${key}_${d}`).get()).data();
    if (!raw && live && n < max) {
      try { raw = await readDay(ctx, key, d); } catch (e) { console.error('plantsrc', key, d, e.message); n = max; left++; continue; }
      n++;
      // an empty finished day is kept too (the plant was not logging), so it is not asked for again on every load
      await col(ctx).doc(`${key}_${d}`).set({ key, ...raw, at: new Date().toISOString() });
      await sleep(800);
    }
    if (!raw) { left++; continue; }
    const v = raw.t.length ? summary(key, raw) : null;
    if (v) days[d] = v;
    await sumCol(ctx).doc(`${key}_${d}`).set({ key, day: d, v: SUM_V, j: JSON.stringify(v), at: new Date().toISOString() });
  }
  const t = td.v, i = t.t.length - 1;
  if (t.t.length) days[now] = summary(key, t);
  const nowv = i >= 0 ? { at: t.t[i], src: t.c[i], soc: t.s[i], p: t.p[i], pv: t.pv[i], l: t.l[i], hz: t.hz ? t.hz[i] : null } : null;
  const { classes, name, kwp, lead, port, history, src, id } = cfg;
  return { key, name, kwp, lead, port, history, src, id, classes, today: now, days, now: nowv, left, todayAt: new Date(td.at).toISOString(), todayError: td.error || null, stale: td.stale || left > 0, study: !!require('./plant-study').STUDIES[key] };
}

module.exports = { PLANTS, page, readDay, summary };
