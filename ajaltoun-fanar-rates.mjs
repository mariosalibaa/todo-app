// Ajaltoun 4193 — the July-2026 reference rates (Fanar 212 BOQ by Sayed Saadeh) next to the budget lines,
// and the one-off restructure Mario agreed on 2026-09-12:
//   1. every budget line that matches a Fanar item gets ref = { rate, unit, src } (shown on the hub; "use" applies it)
//   2. plumbing and electrical move to Fanar's all-in per-point rates (rough piping + 1st + 2nd fix inside the rate),
//      so the old lump lines "Pipes / Embedded items / Labor / Cables" are dropped — they would double count
//   3. soft-cost lines the Ajaltoun budget never had (subdivision + title deeds, utility connections, insurance…)
//   node ajaltoun-fanar-rates.mjs [--dry]
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const SRC = 'Fanar 212 BOQ, Sayed Saadeh, 17-7-2026';
const now = () => new Date().toISOString();

// name pattern → Fanar rate; `unit` is Fanar's unit; `allin` marks the per-point MEP rates that replace the lumps
const REF = [
  [/^excavation$/i, 6, 'cbm'], [/stone wall/i, null, 'sqm'],
  [/^concrete$/i, 220, 'cbm', 'incl. formwork, labour and steel'], [/^labor ?$/i, 0, 'cbm', 'inside the $220/m³ concrete rate'], [/^steel$/i, 0, 'Tons', 'inside the $220/m³ concrete rate'],
  [/^block ?work/i, 12.5, 'sqm', '10 cm; 15 cm $18; insulation $6'],
  [/waterproofing - basement/i, 27, 'sqm'], [/waterproofing - roof/i, 27, 'sqm'], [/^waterproofing ?$/i, 27, 'sqm', 'basement & roof $27, wet rooms $18'],
  [/roof bricks?/i, 110, 'sqm', 'with thermal insulation'], [/^wood doors$/i, 275, 'no.', 'MDF; solid entrance $600'], [/^D1 /i, 275, 'no.'], [/^D2 /i, 600, 'no.'], [/^D3 /i, 275, 'no.'], [/^D4 /i, 275, 'no.'], [/^D5 /i, 275, 'no.'],
  [/^kitchen$/i, 200, 'lm', 'built-in cupboards, Blum, Egger'], [/^vanities$/i, null, ''],
  [/^aluminum$/i, 135, 'sqm', 'without monoblock; balustrade $60'], [/parking door$/i, 120, 'sqm'],
  [/internal - walls/i, 10, 'sqm'], [/internal - ceilings/i, 10, 'sqm'], [/^external ?$/i, 17, 'sqm', 'scaffolding included'],
  [/^tiles$/i, 26, 'sqm', 'all-in $21–28 by type'], [/^stairs$/i, 27, 'sqm'], [/^salon$/i, 28, 'sqm'], [/^bedrooms$/i, 26, 'sqm'], [/^WC bedrooms/i, 24, 'sqm'], [/^multipurpose$/i, 26, 'sqm'], [/^WC multipurpose/i, 24, 'sqm'], [/^roof$/i, 26, 'sqm'], [/^WC roof/i, 24, 'sqm'], [/roof terrace/i, 26, 'sqm'], [/^maid/i, 26, 'sqm'], [/basement floor/i, 20, 'sqm', 'stamped concrete'], [/^cladding$/i, 40, 'sqm', 'stone; WPC wood $100'],
  [/^walls$/i, 6, 'sqm', 'internal; external $12 incl. scaffolding'], [/^ceilings/i, 6, 'sqm'],
  // plumbing, all-in per point
  [/water closet/i, 345, 'no.', 'all-in', true], [/^sink$/i, 225, 'no.', 'all-in', true], [/bac a douche/i, 465, 'no.', 'all-in', true], [/kitchen sink/i, 575, 'no.', 'all-in', true],
  [/^drain$/i, 75, 'no.', 'all-in', true], [/regard 4/i, 75, 'no.', 'all-in', true], [/regard 6/i, 75, 'no.', 'all-in', true], [/hot water tank/i, 295, 'no.', 'all-in, 200 L', true],
  [/^water tank$/i, 435, 'no.', 'all-in, 2500 L with pump', true], [/^boilers$/i, null, 'no.'], [/^valves$/i, 200, 'no.', '', true], [/pressure pump/i, 295, 'no.', 'all-in', true],
  // electrical, all-in per point
  [/^pann?els$/i, 175, 'no.', '+ breakers $35 each', true], [/^bells$/i, 53, 'no.', '', true], [/^interphone ?$/i, 70, 'no.', 'videophone; system $2,400', true], [/interphone call/i, 2400, 'no.', 'videophone system', true],
  [/^telephone$/i, 53, 'no.', '', true], [/telephone cabinet/i, 70, 'no.', '', true], [/^TV$/i, 53, 'no.', '', true], [/light point/i, 17.5, 'no.', '', true], [/1 way switch/i, 35, 'no.', '', true], [/2 way switch/i, 53, 'no.', '', true],
  [/minute timer/i, 53, 'no.', '', true], [/waterproof socket/i, 70, 'no.', '', true], [/^sockets$/i, 35, 'no.', '1 module; 2 modules $53', true], [/^fridge$/i, 70, 'no.', '', true], [/wash machine/i, 70, 'no.', '', true], [/dish ?washer/i, 70, 'no.', '', true],
  [/^fan$/i, 35, 'no.', '', true], [/earthing/i, 1500, 'no.', '', true], [/^cables$/i, 1250, 'no.', 'per apartment', true],
  [/AC split/i, 445, 'no.', '9k $415 · 12k $445 · 18k $570 (copper $22–24/lm extra)'], [/^lift$/i, 19000, 'no.', 'roomless, stainless doors'],
  [/^pool$/i, null, ''], [/^terraces ?$/i, null, ''], [/^fencing$/i, null, 'lm'], [/^green areas$/i, 10000, 'no.', 'asphalt & landscaping GF'],
];
// lump lines that Fanar's all-in rates make redundant
const DROP = [/^embedded items$/i, /^embedded pipes$/i, /^labor ?$/i, /^pipes$/i, /^cables$/i];
const MEP_TRADES = new Set(['plumbing', 'electrical', 'hvac']);
// lines to add to both villa types (2026 prices, so review = false)
const ADD = [
  { bill: 11, trade: 'plumbing', phase: 'finishing', name: 'Risers (per villa)', unit: 'no.', qty: 1, price: 2300, note: 'Fanar: $2,300 per riser' },
  { bill: 12, trade: 'electrical', phase: 'finishing', name: 'Cables (per floor)', unit: 'no.', qty: 2, price: 1250, note: 'Fanar: $1,250 per apartment' },
  { bill: 12, trade: 'electrical', phase: 'finishing', name: 'Breakers 1 pole', unit: 'no.', qty: 20, price: 35 },
  { bill: 12, trade: 'electrical', phase: 'finishing', name: 'Solar panels wiring (PV cables to panel room)', unit: 'no.', qty: 6, price: 170 },
  { bill: 13, trade: 'hvac', phase: 'finishing', name: 'Copper pipes 9.5 + 6.35 mm, insulated', unit: 'lm', qty: 60, price: 22 },
  { bill: 18, trade: 'general', phase: 'finishing', name: 'Efraz + sanadet (subdivision + title deeds), 1/6', unit: 'no.', qty: 1, price: 4167, note: 'Fanar: $25,000 for the building → per villa' },
  { bill: 18, trade: 'general', phase: 'finishing', name: 'EDL, generator, water connections', unit: 'no.', qty: 1, price: 2500 },
  { bill: 18, trade: 'general', phase: 'structure', name: 'Insurance — 2 years', unit: 'no.', qty: 1, price: 800 },
  { bill: 18, trade: 'general', phase: 'finishing', name: 'Marhale tenye (second-stage permit)', unit: 'no.', qty: 1, price: 500 },
];

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(new URL('./firebase-service-account.json', import.meta.url), 'utf8'))) });
const col = admin.firestore().collection('workspaces').doc(process.env.TEAM_ID || 'team').collection('ajaltounBoq');
const items = (await col.get()).docs.map(d => d.data());
const batch = admin.firestore().batch();
const stamp = (it, changes) => { it.history = [...(it.history || []), { at: now(), by: 'fanar-rates', changes }].slice(-50); it.updatedAt = now(); it.updatedBy = 'fanar-rates'; };
let refs = 0, applied = 0, dropped = 0, added = 0;
for (const it of items) {
  const m = REF.find(([re]) => re.test(it.name.trim()));
  if (DROP.some(re => re.test(it.name.trim())) && MEP_TRADES.has(it.trade)) { dropped++; console.log('DROP ', it.type, it.name, it.total); if (!DRY) batch.delete(col.doc(it.id)); continue; }
  if (!m) continue;
  const [, rate, unit, note, allin] = m;
  it.ref = { rate, unit, note: note || '', src: SRC }; refs++;
  if (allin && rate != null && it.qty != null) {   // MEP: the all-in rate replaces the old price now
    const changes = [{ f: 'price', from: it.price, to: rate }, { f: 'review', from: it.review, to: false }];
    it.price = rate; it.total = +(it.qty * rate).toFixed(2); it.review = false; it.note = [it.note, 'Fanar all-in rate (rough + 1st + 2nd fix)'].filter(Boolean).join(' · ');
    stamp(it, changes); applied++;
  }
  if (!DRY) batch.set(col.doc(it.id), it);
}
let order = Date.now();
for (const type of ['U', 'D']) for (const a of ADD) {
  if (items.some(i => i.type === type && i.name.toLowerCase() === a.name.toLowerCase())) continue;
  const id = (order++).toString(36) + Math.random().toString(36).slice(2, 5);
  const doc = { id, order, type, ...a, amount: null, total: +(a.qty * a.price).toFixed(2), review: false, source: SRC, note: a.note || null, history: [], createdAt: now(), createdBy: 'fanar-rates', updatedAt: now(), updatedBy: 'fanar-rates' };
  if (!DRY) batch.set(col.doc(id), doc); added++;
}
if (!DRY) await batch.commit();
console.log(`${DRY ? 'would: ' : ''}refs ${refs} · MEP rates applied ${applied} · lumps dropped ${dropped} · lines added ${added}`);
process.exit(0);
