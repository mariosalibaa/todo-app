// Ajaltoun 4193 — seed the hub BUDGET from the two BOQ summary sheets (local laptop, Dropbox files).
//   node ajaltoun-boq-import.mjs [--dry] [--replace]
// U = "villa up 333" (0. Summary Villa U.xls, Mar 2024), D = "villa down" (0. Summary Villa down 2023-from sayed.xlsx).
// "up 250" is disregarded (Mario, 2026-09-12). Each summary line becomes one item per villa TYPE, with the trade it
// belongs to (= the section Odoo lines are classified into) and a phase for the cashflow. Prices are 2022–2024, so
// every imported item is flagged review=true until Mario looks at it on the hub. Re-running without --replace only
// adds items that are not there yet (matched on type + bill + name).
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry'), REPLACE = process.argv.includes('--replace');
const BOQ = 'D:/Dropbox/0. SHIFT/00. DEVELOPMENT/AJALTOUN 4193/0. BOQ+SPECS+PRESENTATION/0. EXCEL boq';
const FILES = { U: `${BOQ}/20220908 BOQ TRS - villa up 333/0. Summary Villa U.xls`, D: `${BOQ}/20220908 BOQ TRS - villa down/0. Summary Villa down 2023-from sayed.xlsx` };

// bill number → trade (section id) and phase
const TRADE = { 1: ['excavation', 'site'], 2: ['concrete', 'structure'], 3: ['blockwork', 'structure'], 4: ['waterproofing', 'structure'],
  5: ['joinery', 'finishing'], 6: ['aluminium', 'finishing'], 7: ['plaster', 'finishing'], 8: ['tiling', 'finishing'], 9: ['painting', 'finishing'],
  10: ['ceilings', 'finishing'], 11: ['plumbing', 'finishing'], 12: ['electrical', 'finishing'], 13: ['hvac', 'finishing'], 14: ['landscape', 'finishing'],
  15: ['lift', 'finishing'], 16: ['pool', 'finishing'], 17: ['joinery', 'finishing'], 20: ['landscape', 'site'] };
const tradeOf = (bill, name) => /stone wall/i.test(name) ? ['stone', 'site'] : /roof brick|solar/i.test(name) ? ['tiling', 'finishing'] : (TRADE[bill] || ['general', 'finishing']);

// read both sheets through Python (xlrd for .xls, openpyxl for .xlsx) as JSON rows
const PY = `
import sys, json
def rows_xls(p):
    import xlrd; sh = xlrd.open_workbook(p).sheet_by_index(0)
    return [sh.row_values(i)[:8] for i in range(sh.nrows)]
def rows_xlsx(p):
    import openpyxl; ws = openpyxl.load_workbook(p, data_only=True).worksheets[0]
    return [[c for c in r[:8]] for r in ws.iter_rows(values_only=True)]
out = {}
for k, p in json.loads(sys.argv[1]).items():
    out[k] = rows_xls(p) if p.endswith('.xls') else rows_xlsx(p)
print(json.dumps(out, default=str))`;
const sheets = JSON.parse(execFileSync('python', ['-c', PY, JSON.stringify(FILES)], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf8' } }));

const items = [];
for (const [type, rows] of Object.entries(sheets)) {
  let bill = 0, started = false;
  for (const r of rows) {
    const [b, name, unit, qty, price, f6, f7] = r.map(x => (x === '' || x === undefined) ? null : x);
    if (!started) { if (String(b) === 'Bill') started = true; continue; }
    if (typeof b === 'number' && b > 0) bill = b;
    if (!name || /^(subtotal|grand total|construction cost|land|selling|profit|construction cost \+ land)$/i.test(String(name).trim())) continue;
    // U sheet: unit price in col 5, "included" flag in col 6, total in col 7 · D sheet: total in col 6
    const total = type === 'U' ? f7 : f6;
    const isHead = qty == null && price == null && (total == null || total === 0);   // a bill heading with its lines below
    if (isHead) continue;
    const n = String(name).trim();
    const [trade, phase] = tradeOf(bill, n);
    const it = { type, bill, trade, phase, name: n, unit: unit ? String(unit).trim() : null,
      qty: typeof qty === 'number' ? qty : null, price: typeof price === 'number' ? price : null,
      amount: null, review: true, source: type === 'U' ? 'Summary Villa U.xls (Mar 2024)' : 'Summary Villa down 2023-from sayed.xlsx (Sep 2023)', note: null };
    if (it.qty != null && it.price != null) it.total = +(it.qty * it.price).toFixed(2);
    else { it.amount = typeof total === 'number' ? total : 0; it.total = it.amount; it.qty = null; it.price = null; }
    if (!it.total && it.qty == null) continue;   // an empty placeholder line (e.g. "External plaster" with no quantity)
    items.push(it);
  }
}
for (const t of ['U', 'D']) { const s = items.filter(i => i.type === t); console.log(t, s.length, 'items, total', s.reduce((x, i) => x + i.total, 0).toFixed(2)); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(new URL('./firebase-service-account.json', import.meta.url), 'utf8'))) });
const col = admin.firestore().collection('workspaces').doc(process.env.TEAM_ID || 'team').collection('ajaltounBoq');
const existing = (await col.get()).docs.map(d => d.data());
if (REPLACE && !DRY) { const b = admin.firestore().batch(); existing.forEach(e => b.delete(col.doc(e.id))); await b.commit(); existing.length = 0; console.log('cleared'); }
const key = i => `${i.type}|${i.bill}|${i.name.toLowerCase()}`;
const have = new Set(existing.map(key));
let n = 0, order = Date.now();
const batch = admin.firestore().batch();
for (const it of items) {
  if (have.has(key(it))) continue;
  const id = (order++).toString(36) + Math.random().toString(36).slice(2, 5);
  const doc = { id, order, ...it, history: [], createdAt: new Date().toISOString(), createdBy: 'boq-import', updatedAt: new Date().toISOString(), updatedBy: 'boq-import' };
  if (!DRY) batch.set(col.doc(id), doc);
  n++;
}
if (!DRY) await batch.commit();
console.log(`${DRY ? 'would add' : 'added'} ${n} items (${existing.length} already there)`);
process.exit(0);
