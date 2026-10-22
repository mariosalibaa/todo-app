// Villa Tohme — the three panel series (the inverter's MPPT inputs PV1 / PV2 / PV3) compared in kWh per kWp.
//
// DeyeCloud keeps the inverter's own 5-min series (/device-s/device/<id>/stats/day: DP1..DP3 W, DC1..DC3 A,
// BMS_SOC) for about 90 days only — older days are gone, so each day is kept when it is read (Firestore
// energyTohme/<day>.mppt; tohme-mppt.json holds 24 Jul → 21 Oct 2026, the oldest DeyeCloud still had,, pulled 2026-10-22).
//
// Per day: e = kWh per series over the day; eu = kWh per series only while the battery is below 97 % (the panels
// run free — once the battery is full the inverter throttles them, not evenly, so that part says nothing about the
// panels); am / pm = eu before / after solar noon (≈ 09:40 UTC all year in Lebanon); im = the highest current (A)
// while running free. Comparison = eu / kWp of each series.
//
// kWp per series: the layout is not in the drawings (SLD shows 4 × 15 + 10, the site has 69 × 590 W: villa 5,
// small house 20, parking 44). Estimated from overcast days, when diffuse light makes each series' share follow
// its size: 17.9 / 42.5 / 39.2 % of 40.71 kWp ≈ 12 / 29 / 28 panels. Change PANELS once the real count is known.

const INVERTER = 5630527;
const PANEL_W = 590;
const PANELS = [12, 29, 28];   // PV1, PV2, PV3 — estimated (see above)
const KWP = PANELS.map(n => n * PANEL_W / 1000);
const NOON = 9 * 3600 + 40 * 60;   // solar noon, seconds into the UTC day

// S = { DP1: [[t, W]…], DC1: …, BMS_SOC: … } → one day's figures
function analyze(S) {
  const r1 = x => Math.round(x * 10) / 10;
  const P = [1, 2, 3].map(m => S['DP' + m] || []), I = [1, 2, 3].map(m => S['DC' + m] || []);
  const soc = new Map((S.BMS_SOC || []).map(([t, v]) => [t, v]));
  const n = P[0].length, out = { e: [0, 0, 0], eu: [0, 0, 0], am: [0, 0, 0], pm: [0, 0, 0], im: [0, 0, 0], n };
  for (let i = 0; i < n; i++) {
    const t = P[0][i][0], dt = Math.min(360, i + 1 < n ? P[0][i + 1][0] - t : 300) / 3600;
    const free = (soc.get(t) ?? 0) < 97, pmHalf = t % 86400 >= NOON;
    for (let m = 0; m < 3; m++) {
      const kwh = Math.max(0, (P[m][i] || [0, 0])[1]) * dt / 1000;
      out.e[m] += kwh;
      if (free) { out.eu[m] += kwh; (pmHalf ? out.pm : out.am)[m] += kwh; out.im[m] = Math.max(out.im[m], (I[m][i] || [0, 0])[1]); }
    }
  }
  for (const k of ['e', 'eu', 'am', 'pm', 'im']) out[k] = out[k].map(r1);
  return out;
}

async function day(token, ymd) {
  const r = await fetch(`https://www.deyecloud.com/device-s/device/${INVERTER}/stats/day?day=${ymd.replace(/-/g, '%2F')}&lan=en`,
    { headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } });
  if (!r.ok) throw new Error('DeyeCloud device ' + r.status);
  const S = {};
  for (const p of await r.json()) if (/^(DP|DC)[1-3]$|^BMS_SOC$/.test(p.storageName)) S[p.storageName] = (p.detailList || []).map(x => [+x.collectionTime, +x.value]);
  return (S.DP1 || []).length ? analyze(S) : null;   // null = DeyeCloud no longer has that day
}

module.exports = { analyze, day, INVERTER, PANELS, PANEL_W, KWP };
