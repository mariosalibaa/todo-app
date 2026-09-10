// ── The project on a hub row vs the project on the Odoo line it was booked as ──
// Mario, 2026-09-10: "updating analytical account on hub is not updating odoo". From now on a
// row edit pushes straight through (accounts.js → bills.pushAnalytic); this puts right the rows
// that drifted apart before that.
//
//   node hub-analytic-sync.mjs           list the disagreements
//   node hub-analytic-sync.mjs --fix     write the hub's project onto the Odoo line
//
// A posted bill line takes analytic_distribution from a plain write — no draft/post cycle — so a
// paid bill keeps its reconciliation.
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';

const FIX = process.argv.includes('--fix');
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const money = n => Math.round((+n || 0) * 100) / 100;
const now = () => new Date().toISOString();

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();

// the same shape the hub books with: a split is each account id with its percentage
const distOf = t => Array.isArray(t.analyticSplit) && t.analyticSplit.length > 1
  ? Object.fromEntries(t.analyticSplit.map(s => [String(s.id), +s.pct]))
  : t.analyticId ? { [String(t.analyticId)]: 100 } : null;
const same = (a, b) => {
  const norm = o => Object.entries(o || {}).map(([k, v]) => k + ':' + Math.round(+v * 100)).sort().join(',');
  return norm(a) === norm(b);
};

const accs = await db.collection('workspaces/team/accounts').get();
const rows = [];
for (const a of accs.docs) {
  const snap = await a.ref.collection('tx').get();
  for (const d of snap.docs) {
    const t = { id: d.id, ...d.data() };
    if (t.src === 'odoo' || t.excluded) continue;             // mirrors and folded rows carry no booking of their own
    const chosen = t.odoo && (t.odoo.matches || []).find(x => x.chosen);
    // a project lives on the expense line of a BILL; a row tied to its settlement (PSETT / TRANS)
    // has to be followed through that match's documents to the bill behind it
    const candidates = [
      (t.bookedMove && t.bookedMove.id) || null,
      (chosen && chosen.moveId) || null,
      ...Object.values((chosen && chosen.docIds) || {}),
    ].filter(Number.isInteger);
    if (!candidates.length || !distOf(t)) continue;
    rows.push({ accRef: a.ref, acc: a.id, t, candidates: [...new Set(candidates)], label: (chosen && chosen.label) || '' });
  }
}
console.log(`booked rows carrying a project: ${rows.length}`);

const ids = [...new Set(rows.flatMap(r => r.candidates))];
const moves = {};
for (let i = 0; i < ids.length; i += 300) {
  const part = await call('account.move', 'read', [ids.slice(i, i + 300), ['name', 'state', 'move_type', 'company_id', 'invoice_line_ids']], { context: CTX });
  part.forEach(m => { moves[m.id] = m; });
}
const billOf = r => r.candidates.map(id => moves[id]).find(m => m && ['in_invoice', 'in_refund'].includes(m.move_type)
  && m.state !== 'cancel' && (m.invoice_line_ids || []).length);
const lineIds = [...new Set(Object.values(moves).flatMap(m => m.invoice_line_ids || []))];
const lines = {};
for (let i = 0; i < lineIds.length; i += 400) {
  const part = await call('account.move.line', 'read', [lineIds.slice(i, i + 400), ['name', 'price_subtotal', 'analytic_distribution', 'move_id']], { context: CTX });
  part.forEach(l => { lines[l.id] = l; });
}

const off = [], skipped = [];
for (const r of rows) {
  const mv = billOf(r);
  if (!mv) {
    const seen = r.candidates.map(id => moves[id]).filter(Boolean);
    skipped.push({ r, why: !seen.length ? 'the entry no longer exists'
      : seen.every(m => m.state === 'cancel') ? 'cancelled'
      : 'no bill line — a project lives on the bill, not on its settlement' });
    continue;
  }
  const mine = (mv.invoice_line_ids || []).map(id => lines[id]).filter(Boolean);
  if (!mine.length) { skipped.push({ r, why: mv.name + ' has no invoice line' }); continue; }
  const amount = money(r.t.debit || r.t.credit);
  let line = r.label ? mine.find(l => String(l.name || '').startsWith(String(r.label).slice(0, 40))) : null;
  if (!line) { const near = mine.filter(l => Math.abs(l.price_subtotal - amount) < 0.02); if (near.length === 1) line = near[0]; }
  if (!line) { skipped.push({ r, why: `cannot tell which line of ${mv.name}` }); continue; }
  const want = distOf(r.t);
  if (same(line.analytic_distribution, want)) continue;
  // Only push what a person or the workbook put on the row. A project the hub ADOPTED from Odoo
  // ('odoo') means Odoo was the author — a disagreement there means Odoo has since been corrected,
  // and pushing the hub's copy back would undo that correction.
  if (r.t.analyticSrc === 'odoo') { skipped.push({ r, why: "the hub's project was read from Odoo — Odoo is the author" }); continue; }
  off.push({ r, mv, line, want, src: r.t.analyticSrc || 'no source' });
}
console.log(`  the Odoo line disagrees : ${off.length}`);
console.log(`  could not be checked    : ${skipped.length}\n`);

const nameOf = d => Object.entries(d || {}).map(([k, v]) => k + '@' + v + '%').join(' + ') || '—';
let last = '';
off.sort((a, b) => (a.r.acc + a.r.t.date).localeCompare(b.r.acc + b.r.t.date)).forEach(o => {
  if (o.r.acc !== last) { console.log(`=== ${o.r.acc}`); last = o.r.acc; }
  console.log(`  ${o.r.t.date} ${String(o.r.t.debit || -(o.r.t.credit || 0)).padStart(8)} | ${o.mv.name.padEnd(20)} line ${o.line.id}`
    + `\n      Odoo has ${nameOf(o.line.analytic_distribution).padEnd(30)} hub says ${nameOf(o.want)} [${o.src}]`
    + `\n      ${String(o.r.t.description || '').slice(0, 78)}`);
});
if (skipped.length) {
  console.log('\ncould not be checked:');
  const why = {}; skipped.forEach(s => { why[s.why.replace(/[A-Z]+\/\d[\d/]*/g, '<entry>')] = (why[s.why.replace(/[A-Z]+\/\d[\d/]*/g, '<entry>')] || 0) + 1; });
  Object.entries(why).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
}

if (!FIX) { console.log(off.length ? '\n(run again with --fix to write the hub\'s project onto Odoo)' : ''); process.exit(0); }

let done = 0;
for (const o of off) {
  await call('account.move.line', 'write', [[o.line.id], { analytic_distribution: o.want }],
    { context: { ...CTX, company_id: o.mv.company_id[0] } });
  await o.r.accRef.collection('log').add({ at: now(), who: 'analytic-sync', txId: o.r.t.id,
    line: [o.r.t.date, o.r.t.description].filter(Boolean).join(' · ').slice(0, 80),
    before: { odooAnalytic: o.line.analytic_distribution || null, on: `${o.mv.name} line ${o.line.id}` },
    after: { odooAnalytic: o.want, on: `${o.mv.name} line ${o.line.id}` }, undo: false });
  done++;
}
console.log(`\n${done} Odoo line(s) put in step with the hub`);
process.exit(0);
