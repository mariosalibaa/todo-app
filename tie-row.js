// Tie one Excel row to an Odoo move by hand, for the case no rule can express: a single
// supplier invoice that covers two rows of the sheet (mrad's 125 = 75 cement + 50 pipe on
// 16 Feb 2026 — the bill's ref points at the first row, this ties the second).
// The row gets the same `bookedMove` / `odoo.matches` a posted row gets, so it counts as
// linked, is never booked twice, and shows the bill in the Odoo column.
//
//   node tie-row.js <accountId> <rowId> <moveId> "<why>"        dry run
//   node tie-row.js <accountId> <rowId> <moveId> "<why>" --commit
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const [accountId, rowId, moveId, why] = process.argv.slice(2);
const COMMIT = process.argv.includes('--commit');
if (!accountId || !rowId || !moveId) { console.error('usage: node tie-row.js <accountId> <rowId> <moveId> "<why>" [--commit]'); process.exit(1); }

const svc = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-service-account.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(svc), projectId: svc.project_id });
const db = admin.firestore();
const TEAM_ID = process.env.TEAM_ID || 'team';

(async () => {
  const { call } = await import('file:///D:/vscode/odoo/odoo.mjs');
  const [mv] = await call('account.move', 'read', [[+moveId], ['id', 'name', 'ref', 'state', 'amount_total', 'invoice_date', 'partner_id', 'company_id', 'payment_state']],
    { context: { allowed_company_ids: [2, 7, 10] } });
  if (!mv) throw new Error('no such move: ' + moveId);
  const ref = db.collection('workspaces').doc(TEAM_ID).collection('accounts').doc(accountId).collection('tx').doc(rowId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('no such row: ' + rowId);
  const t = snap.data();
  console.log(`row  ${t.date}  ${t.debit || t.credit}  ${t.description}`);
  console.log(`move ${mv.name}  ${mv.amount_total}  ${mv.partner_id[1]}  ${mv.company_id[1]}  ${mv.payment_state}`);
  console.log(`why  ${why || '(none given)'}`);
  const at = new Date().toISOString();
  const data = {
    bookedMove: { id: mv.id, name: mv.name, ref: mv.ref, kind: 'vendor-bill', at, state: mv.state, paymentState: mv.payment_state, by: 'hand' },
    ref: mv.name, service: mv.company_id[1], company: mv.company_id[1], companySrc: 'odoo', partnerId: mv.partner_id[0],
    odoo: { checkedAt: at, matches: [{ chosen: true, moveId: mv.id, move: mv.name, date: mv.invoice_date, amount: mv.amount_total,
      partner: mv.partner_id[1], partnerId: mv.partner_id[0], label: t.description, company: mv.company_id[1], journal: 'BILL',
      state: mv.state, docs: [], analytics: [], score: 10, why: [why || 'tied by hand'], tiedBy: 'manual' }] },
  };
  if (!COMMIT) { console.log('\nDry run — re-run with --commit'); process.exit(0); }
  await ref.set(data, { merge: true });
  console.log('\ntied.');
  process.exit(0);
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
