import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ref = db.doc('workspaces/team/accounts/abed-cash/tx/xl-2026-09-01-d1088-attal-bolt-driver-');
await ref.set({ ref: 'BILL/2026/09/0001', noBook: true,
  bookedMove: { id: 4379, name: 'BILL/2026/09/0001', ref: '72023', kind: 'bill', state: 'posted', paymentState: 'paid', at: new Date().toISOString(), by: 'claude (tied by hand, Mario 2026-09-13)',
    paidBy: [{ name: 'TRANS/2026/09/0005', moveId: 4692, amount: 10.88, date: '2026-09-01' }] },
  partnerId: 13, partnerName: 'Ste. ATTAL', partnerSrc: 'odoo', companySrc: 'odoo',
  noBookNote: 'Attal invoice 72023 was already booked as BILL/2026/09/0001 (SARL) and settled by Abed through TRANS/2026/09/0005 — tied by hand 2026-09-13; a stray draft payment from the Pay button was deleted.',
  updatedAt: new Date().toISOString(), updatedBy: 'mario.salibaa@gmail.com' }, { merge: true });
console.log('tied');
