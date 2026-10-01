// Deye — the CPR inverter plant (DeyeCloud station 61244864, 3 × 50 kW: M1 + S2 + S3) in kWh per day.
// The station's Power Profile series (/maintain-s/history/batteryPower/<id>/stats/daily) is the three inverters
// together, one reading every 5 min, in watts — and it already keeps the sources apart:
//   pvPower = solar · generatorPower = the generator input · wirePower = the grid input (EDL; < 0 = fed back)
//   usePower = the UPS load (what the buildings draw through the inverters) · batteryPower (< 0 = charging)
// kWh = Σ W × Δt, each reading held until the next one but never longer than one sampling step, so a gap in
// the series contributes nothing (the day is then under-counted, never averaged up). Same rule as the Taan
// plant, checked there against DeyeCloud's own .xlsx export.
// Deye's daily counters (statistics.buyValue …) glitch now and then — the integrated series is what we keep.

const STATION = 61244864;
const BASE = 'https://www.deyecloud.com';

async function dayRecords(token, ymd, station = STATION) {   // station: another plant on the same account (the Taan plant, /mahab)
  const [y, m, d] = ymd.split('-').map(Number);
  const r = await fetch(`${BASE}/maintain-s/history/batteryPower/${station}/stats/daily?year=${y}&month=${m}&day=${d}`,
    { headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`DeyeCloud ${r.status}${r.status === 401 ? ' (DEYE_TOKEN expired — sign in to deyecloud.com and copy a new one)' : ''}`);
  const j = await r.json();
  const key = +ymd.replace(/-/g, '');
  return (j.records || []).filter(x => x.acceptDay === key).sort((a, b) => a.dateTime - b.dateTime);
}

// one day's records → { pv, gen, gridIn, gridOut, use, charge, discharge, n } in kWh
function integrate(recs) {
  const out = { pv: 0, gen: 0, gridIn: 0, gridOut: 0, use: 0, charge: 0, discharge: 0, n: recs.length, prod: 0, genOut: 0 };
  if (!recs.length) return out;
  const steps = []; for (let i = 1; i < recs.length; i++) steps.push(recs[i].dateTime - recs[i - 1].dateTime);
  const step = steps.length ? steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 300;   // the sampling step (median)
  recs.forEach((r, i) => {
    const dt = Math.min(step, i + 1 < recs.length ? recs[i + 1].dateTime - r.dateTime : step) / 3600;   // hours
    const w = k => (+r[k] || 0) * dt / 1000;
    out.pv += Math.max(0, w('pvPower'));
    const gp = w('generatorPower'); if (gp > 0) out.gen += gp; else out.genOut -= gp;   // < 0 = sent back out through the generator port (the Taan plant's EDL sits on it)
    const g = w('wirePower'); if (g > 0) out.gridIn += g; else out.gridOut -= g;
    out.use += Math.max(0, w('usePower'));
    out.prod += Math.max(0, w('generationPower'));   // Deye's "production" = solar + generator
    const b = w('batteryPower'); if (b > 0) out.discharge += b; else out.charge -= b;
  });
  for (const k of Object.keys(out)) if (k !== 'n') out[k] = Math.round(out[k] * 10) / 10;
  // before Apr 2025 Deye recorded only the total (no pvPower / generatorPower): no split, not 0
  if (!recs.some(r => r.pvPower != null || r.generatorPower != null)) { out.pv = null; out.gen = null; }
  return out;
}

module.exports = { STATION, dayRecords, integrate };
