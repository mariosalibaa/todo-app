// ── Odoo mirror rows whose entry is gone or cancelled ───────────────────────
// A row with src 'odoo' is a mirror of an Odoo entry. When that entry is deleted, or cancelled,
// the row mirrors nothing: it still shows in the grid, still carries a ✓ that leads nowhere or to
// a cancelled document. Mario, 2026-09-10: delete them.
// Only src 'odoo' rows are ever touched — an `xl-` row is the worker's own sheet and stays.
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';
const FIX = process.argv.includes('--fix');
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const now = () => new Date().toISOString();
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();

const accs = await db.collection('workspaces/team/accounts').get();
const rows = [];
for (const a of accs.docs) {
  const snap = await a.ref.collection('tx').get();
  for (const d of snap.docs) {
    const t = d.data();
    if (t.src !== 'odoo') continue;                     // never the worker's own sheet rows
    const chosen = t.odoo && (t.odoo.matches || []).find(x => x.chosen);
    const moveId = (t.staleOdoo && t.staleOdoo.moveId) || (chosen && chosen.moveId) || (t.bookedMove && t.bookedMove.id) || null;
    if (!Number.isInteger(moveId)) continue;
    rows.push({ accRef: a.ref, acc: a.id, id: d.id, t, moveId });
  }
}
const ids = [...new Set(rows.map(r => r.moveId))];
const state = {};
for (let i = 0; i < ids.length; i += 400) {
  const part = await call('account.move', 'read', [ids.slice(i, i + 400), ['name', 'state', 'company_id']], { context: CTX });
  part.forEach(m => { state[m.id] = m; });
}
const gone = rows.filter(r => !state[r.moveId]);
const cancelled = rows.filter(r => state[r.moveId] && state[r.moveId].state === 'cancel');
console.log(`Odoo mirror rows            : ${rows.length}`);
console.log(`  their entry was deleted   : ${gone.length}`);
console.log(`  their entry is cancelled  : ${cancelled.length}`);
// A mirror row that is EXCLUDED, or that folds behind a sheet row (`dupOf`), carries no money of
// its own — the xl row does. One that is counted and stands alone IS the account's content (Mario
// cash has no workbook), so deleting it would move a real balance: those are held back unless
// --include-counted is given.
const all = [...gone, ...cancelled];
const safe = all.filter(r => r.t.excluded || r.t.dupOf);
const held = all.filter(r => !(r.t.excluded || r.t.dupOf));
const doomed = process.argv.includes('--include-counted') ? all : safe;
console.log(`  safe to delete (excluded / behind a sheet row): ${safe.length}`);
console.log(`  counted and standing alone — held back        : ${held.length}`);
if (held.length) {
  const impact = {};
  held.forEach(r => { impact[r.acc] = Math.round(((impact[r.acc] || 0) + ((r.t.credit || 0) - (r.t.debit || 0))) * 100) / 100; });
  console.log(`  deleting those would move: ${Object.entries(impact).map(([k, v]) => k + ' by ' + v).join(', ')}`);
}
const byAcc = {};
doomed.forEach(r => { byAcc[r.acc] = (byAcc[r.acc] || 0) + 1; });
console.log('\nby account:');
Object.entries(byAcc).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
console.log('\nfirst 30:');
doomed.sort((a, b) => (a.acc + a.t.date).localeCompare(b.acc + b.t.date)).slice(0, 30).forEach(r => {
  const m = state[r.moveId];
  console.log(`  ${r.acc.padEnd(13)} ${r.t.date} ${String(r.t.debit || -(r.t.credit || 0)).padStart(9)} | ${r.id.padEnd(14)}`
    + ` | ${(m ? m.name + ' ' + m.state : 'entry ' + r.moveId + ' deleted').padEnd(28)} | ${String(r.t.description || '').slice(0, 44)}`);
});
if (!FIX) { console.log('\n(run again with --fix to delete them)'); process.exit(0); }
let n = 0;
for (const r of doomed) {
  const m = state[r.moveId];
  await r.accRef.collection('tx').doc(r.id).delete();
  await r.accRef.collection('log').add({ at: now(), who: 'orphan-rows', txId: r.id,
    line: [r.t.date, r.t.description].filter(Boolean).join(' · ').slice(0, 80),
    before: { date: r.t.date, description: r.t.description || '', debit: r.t.debit || 0, credit: r.t.credit || 0,
      src: 'odoo', odooEntry: m ? `${m.name} (${m.state})` : `id ${r.moveId}, deleted in Odoo` },
    after: {}, undo: false });
  n++;
}
console.log(`\n${n} row(s) deleted`);
process.exit(0);
