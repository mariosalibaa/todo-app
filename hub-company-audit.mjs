// ── Company on a hub row vs the company of the Odoo entry it is tied to ─────
// Mario, 2026-09-09, on Attal 72415: "this is in SARL, why is it written S LB in the hub?"
// A row carries a Company of its own AND a link to an Odoo entry. The entry is the fact — it is
// the one posted in a company's books — so where the two disagree, the entry wins.
//
//   node hub-company-audit.mjs           list the disagreements
//   node hub-company-audit.mjs --fix     write the entry's company onto the row (logged, undoable)
//
// Root cause of the batch found on 2026-09-09: postPayments wrote the right company on the row
// but the stale one on the Odoo *match* beside it, and the grid's adoptOdooFacts copies the
// match's company back onto the row — so the good value was overwritten on the next load.
// Fixed in ledger-bills.js; this repairs the rows that were already written.
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';

const FIX = process.argv.includes('--fix');
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();
const now = () => new Date().toISOString();

// every row that names an Odoo entry
const accs = await db.collection('workspaces/team/accounts').get();
const rows = [];
for (const a of accs.docs) {
  const snap = await a.ref.collection('tx').get();
  for (const d of snap.docs) {
    const t = d.data();
    const chosen = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
    const moveId = (t.bookedMove && t.bookedMove.id) || (chosen && chosen.moveId) || null;
    if (!moveId || !Number.isInteger(moveId)) continue;
    rows.push({ accRef: a.ref, acc: a.id, id: d.id, t, moveId, chosen });
  }
}
console.log(`rows tied to an Odoo entry: ${rows.length}`);

// what company each of those entries is really in
const ids = [...new Set(rows.map(r => r.moveId))];
const co = {};
for (let i = 0; i < ids.length; i += 400) {
  const part = await call('account.move', 'read', [ids.slice(i, i + 400), ['company_id', 'name', 'state']], { context: CTX });
  part.forEach(m => { co[m.id] = { company: m.company_id[1], name: m.name, state: m.state }; });
}
const gone = ids.length - Object.keys(co).length;
console.log(`entries read from Odoo: ${Object.keys(co).length}${gone ? ` (${gone} no longer exist or are in a company this login cannot see)` : ''}`);

const bad = rows.filter(r => {
  const m = co[r.moveId];
  return m && r.t.company && r.t.company !== m.company;
});
console.log(`\nrows whose Company disagrees with their Odoo entry: ${bad.length}\n`);

let last = '';
for (const r of bad.sort((x, y) => (x.acc + x.t.date).localeCompare(y.acc + y.t.date))) {
  if (r.acc !== last) { console.log(`=== ${r.acc}`); last = r.acc; }
  const m = co[r.moveId];
  console.log(`  ${r.t.date} ${String(r.t.debit || -(r.t.credit || 0)).padStart(9)} | ${m.name.padEnd(20)}`
    + ` | ${r.t.company.padEnd(22)} -> ${m.company.padEnd(22)} | ${String(r.t.description || '').slice(0, 46)}`);
}

if (!FIX) { console.log(bad.length ? '\n(run again with --fix to write the Odoo company onto these rows)' : ''); process.exit(0); }

for (const r of bad) {
  const m = co[r.moveId];
  const before = { company: r.t.company, service: r.t.service || '', companySrc: r.t.companySrc || '' };
  const data = { company: m.company, service: m.company, companySrc: 'odoo', updatedAt: now(), updatedBy: 'company-audit' };
  // the match beside it named the stale company too — that is what wrote it back
  if (r.chosen) {
    const matches = (r.t.odoo.matches || []).map(x => x.chosen ? { ...x, company: m.company } : x);
    data.odoo = { ...r.t.odoo, matches, checkedAt: now() };
  }
  await r.accRef.collection('tx').doc(r.id).set(data, { merge: true });
  await r.accRef.collection('log').add({ at: now(), who: 'company-audit', txId: r.id,
    line: [r.t.date, r.t.description].filter(Boolean).join(' · ').slice(0, 80),
    before, after: { company: m.company, service: m.company, companySrc: 'odoo' }, undo: false });
  console.log(`fixed ${r.acc}/${r.id}: ${before.company} -> ${m.company}`);
}
console.log(`\n${bad.length} row(s) put right`);
process.exit(0);
