// ── Hub rows pointing at an Odoo entry that no longer exists ────────────────
// Mario, 2026-09-10, on Khoder's SEC $6.99: "why is your Odoo link not working?"
// The row was written when the purchase was a bill in S LB. That bill was later deleted and the
// purchase rebooked in SARL — but the row still holds the old move id, so its ✓ link opens
// "records with IDs 4836 cannot be found", and its Company still says S LB.
//
//   node hub-deadlink-audit.mjs            list them, with the replacement where one is found
//   node hub-deadlink-audit.mjs --fix      re-tie to the replacement; clear the link where none
//
// How a replacement is found, most trustworthy first:
//   1. an entry carrying the same Bill Reference (`ref`) as the dead one
//   2. the same partner + same amount, within 10 days, in any company
// Anything else is left for a person to decide — the link is cleared so the row goes back to the
// booking queue instead of showing a ✓ that leads nowhere.
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';

const FIX = process.argv.includes('--fix');
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const money = n => Math.round((+n || 0) * 100) / 100;
const now = () => new Date().toISOString();

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();

// ── every row that names an Odoo entry ─────────────────────────────────────
const accs = await db.collection('workspaces/team/accounts').get();
const rows = [];
for (const a of accs.docs) {
  const snap = await a.ref.collection('tx').get();
  for (const d of snap.docs) {
    const t = d.data();
    const chosen = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
    const moveId = (t.bookedMove && t.bookedMove.id) || (chosen && chosen.moveId) || null;
    if (!Number.isInteger(moveId)) continue;
    rows.push({ accRef: a.ref, acc: a.id, id: d.id, t, moveId, chosen });
  }
}
const ids = [...new Set(rows.map(r => r.moveId))];
const alive = new Set();
for (let i = 0; i < ids.length; i += 400) {
  // ask for a REAL field: `read` with only ['id'] hands back a stub for every id you name,
  // deleted ones included, and never touches the table — the check would always pass
  const part = await call('account.move', 'read', [ids.slice(i, i + 400), ['name']], { context: CTX });
  part.forEach(m => alive.add(m.id));
}
const dead = rows.filter(r => !alive.has(r.moveId));
console.log(`rows tied to an Odoo entry : ${rows.length}`);
console.log(`entries still in Odoo      : ${alive.size} of ${ids.length}`);
console.log(`rows pointing at a gone one: ${dead.length}\n`);

// ── look for what replaced each one ────────────────────────────────────────
const refOf = r => (r.chosen && r.chosen.odooRef) || (r.t.bookedMove && r.t.bookedMove.ref) || '';
const refs = [...new Set(dead.map(refOf).filter(Boolean))];
const byRef = {};
for (let i = 0; i < refs.length; i += 200) {
  const part = await call('account.move', 'search_read', [[['ref', 'in', refs.slice(i, i + 200)]]],
    { fields: ['id', 'name', 'ref', 'date', 'company_id', 'move_type', 'amount_total', 'state'], context: CTX, limit: 2000 });
  part.forEach(m => { (byRef[m.ref] = byRef[m.ref] || []).push(m); });
}
// The row's own `ref` is the strongest signal of all: when a purchase is rebooked, whoever moved
// it usually writes the new entry's name onto the row, and only the buried odoo.matches keeps the
// dead id. If that name is a move that exists, it IS the replacement — no guessing.
const names = [...new Set(dead.map(r => String(r.t.ref || '')).filter(x => /^[A-Z]/.test(x)))];
const byName = {};
for (let i = 0; i < names.length; i += 200) {
  const part = await call('account.move', 'search_read', [[['name', 'in', names.slice(i, i + 200)]]],
    { fields: ['id', 'name', 'ref', 'date', 'company_id', 'move_type', 'amount_total', 'state'], context: CTX, limit: 2000 });
  part.forEach(m => { (byName[m.name] = byName[m.name] || []).push(m); });
}

// the partners and amounts we still have to place
const need = dead.filter(r => !(byRef[refOf(r)] || []).length && r.t.partnerId);
const partners = [...new Set(need.map(r => r.t.partnerId))];
const byPartner = {};
for (let i = 0; i < partners.length; i += 60) {
  const part = await call('account.move', 'search_read', [[['partner_id', 'in', partners.slice(i, i + 60)]]],
    { fields: ['id', 'name', 'ref', 'date', 'company_id', 'move_type', 'amount_total', 'state', 'partner_id'], context: CTX, limit: 6000 });
  part.forEach(m => { (byPartner[m.partner_id[0]] = byPartner[m.partner_id[0]] || []).push(m); });
}
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
// What kind of entry a name stands for. A row that named a cash payment must not be re-tied to a
// supplier bill just because the amount agrees — they are different documents and the ✓ would lie.
const kindOf = name => /^R?BILL/.test(name) ? 'bill'
  : /^(PCSH|PSETT|SETT|PBNK)/.test(name) ? 'payment'
  : /^TRANS/.test(name) ? 'transfer'
  : /^MISC/.test(name) ? 'misc' : 'other';
const deadName = r => (r.chosen && r.chosen.move) || (r.t.bookedMove && r.t.bookedMove.name) || '';
function replacementFor(r) {
  const want = kindOf(deadName(r));
  const same = m => kindOf(m.name) === want;
  // …but a sequence number is reused in every company, so the amount must agree as well:
  // BILL/2026/08/0022 is Khoder's dead $6.99 in S LB and an unrelated $7.88 in SARL.
  const amt0 = money(r.t.debit || r.t.credit);
  const named = (byName[String(r.t.ref || '')] || []).filter(m => Math.abs(m.amount_total - amt0) < 0.02);
  if (named.length === 1) return { m: named[0], how: 'the row already names it' };
  const hit = (byRef[refOf(r)] || []).filter(same)[0];
  if (hit) return { m: hit, how: 'same Bill Reference' };
  const amt = money(r.t.debit || r.t.credit);
  const near = (byPartner[r.t.partnerId] || []).filter(m => same(m)
    && Math.abs(m.amount_total - amt) < 0.02 && days(m.date, r.t.date) <= 10);
  if (near.length === 1) return { m: near[0], how: 'same partner, amount, date and kind' };
  if (near.length > 1) return { many: near.length };
  return null;
}

let retie = 0, clear = 0, ambiguous = 0, held = 0;
const plan = [];
for (const r of dead) {
  const f = replacementFor(r);
  if (f && f.m) { retie++; plan.push({ r, to: f.m, how: f.how }); }
  else if (f && f.many) { ambiguous++; plan.push({ r, many: f.many }); }
  else { clear++; plan.push({ r, gone: true }); }
}
console.log(`  ${String(retie).padStart(5)} can be re-tied to the entry that replaced them`);
console.log(`  ${String(ambiguous).padStart(5)} have several candidates — left for a person`);
console.log(`  ${String(clear).padStart(5)} have no replacement — the link is cleared\n`);

const byAcc = {};
plan.forEach(p => { const k = p.r.acc; (byAcc[k] = byAcc[k] || { retie: 0, many: 0, gone: 0 })[p.to ? 'retie' : p.many ? 'many' : 'gone']++; });
console.log('by account:');
Object.entries(byAcc).sort((a, b) => (b[1].retie + b[1].many + b[1].gone) - (a[1].retie + a[1].many + a[1].gone))
  .forEach(([k, v]) => console.log(`  ${k.padEnd(20)} re-tie ${String(v.retie).padStart(4)}   ambiguous ${String(v.many).padStart(3)}   clear ${String(v.gone).padStart(4)}`));

console.log('\nfirst 25 that can be re-tied:');
plan.filter(p => p.to).slice(0, 25).forEach(p => console.log(
  `  ${p.r.acc.padEnd(13)} ${p.r.t.date} ${String(p.r.t.debit || -(p.r.t.credit || 0)).padStart(8)}`
  + ` | was ${String(p.r.chosen && p.r.chosen.move || (p.r.t.bookedMove || {}).name || '').padEnd(20)} (${p.r.moveId})`
  + ` -> ${p.to.name.padEnd(20)} ${String(p.to.company_id[1]).slice(0, 20).padEnd(20)} [${p.how}]`));

if (!FIX) { console.log('\n(run again with --fix to apply)'); process.exit(0); }

for (const p of plan) {
  const { r } = p;
  const before = { company: r.t.company || '', ref: r.t.ref || '',
    bookedMove: r.t.bookedMove || null, odooMoveId: r.chosen ? r.chosen.moveId : null };
  let data, after;
  if (p.to) {
    const co = p.to.company_id[1];
    data = { company: co, service: co, companySrc: 'odoo', ref: p.to.name,
      bookedMove: { ...(r.t.bookedMove || {}), id: p.to.id, name: p.to.name, ref: p.to.ref || '', state: p.to.state, at: now(), retiedAt: now() },
      updatedAt: now(), updatedBy: 'deadlink-audit' };
    if (r.chosen) data.odoo = { ...r.t.odoo, checkedAt: now(),
      matches: (r.t.odoo.matches || []).map(x => x.chosen
        ? { ...x, moveId: p.to.id, move: p.to.name, company: co, state: p.to.state, docs: [], docIds: {},
            why: [...(x.why || []), 'the entry it named was deleted; re-tied to ' + p.to.name] }
        : x) };
    after = { company: co, ref: p.to.name, odooMoveId: p.to.id };
  } else if (p.many) {
    continue;                                   // several candidates: a person decides
  } else if (!r.t.noBook && !process.argv.includes('--all')) {
    // Clearing the link puts the row back in the booking queue, and the next Book months
    // would post a bill for it. A row already marked noBook cannot be rebooked, so its dead
    // link goes quietly; a counted row waits for Mario (2026-09-12) unless --all is passed.
    held++; continue;
  } else {
    // nothing replaced it: stop showing a ✓ that leads nowhere, put the row back in the queue
    data = { bookedMove: admin.firestore.FieldValue.delete(), ref: '',
      odoo: { checkedAt: now(), matches: [] }, updatedAt: now(), updatedBy: 'deadlink-audit' };
    after = { bookedMove: null, ref: '', odooMoveId: null };
  }
  await r.accRef.collection('tx').doc(r.id).set(data, { merge: true });
  await r.accRef.collection('log').add({ at: now(), who: 'deadlink-audit', txId: r.id,
    line: [r.t.date, r.t.description].filter(Boolean).join(' · ').slice(0, 80), before, after, undo: false });
}
console.log(`\n${retie} re-tied, ${clear} cleared, ${ambiguous} left for you`);
process.exit(0);
