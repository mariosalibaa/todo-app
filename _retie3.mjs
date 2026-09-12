import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const D = admin.firestore.FieldValue.delete();
const now = new Date().toISOString();

const jobs = [
  { row: "xl-2026-08-04-d1601-attal", ref: "BILL/2026/08/0005", inv: "70896", amount: "16.01",
    analyticId: 45, analyticName: "Naccache Milede Mum",
    file: { id: 5221, name: "20260804 attal 16.01$ ttc milede_naccache.pdf" } },
  { row: "xl-2026-08-04-d1161-attal", ref: "BILL/2026/08/0004", inv: "70902", amount: "11.61",
    analyticId: 147, analyticName: "Milede Sin el Fil",
    file: { id: 5220, name: "20260804 attal 11.61$ ttc milede_sin el fil.pdf" } },
];
for (const j of jobs) {
  const note = `Same purchase as ${j.ref} in SHIFT GROUP SARL (Attal VAT invoice ${j.inv}, $${j.amount}). The S LB twin booked from this row was deleted 2026-09-08; the SARL bill is now settled paid-by Khodr.`;
  await db.doc(`workspaces/team/accounts/khodr-cash/tx/${j.row}`).set({
    bookedMove: D, noBook: true, noBookNote: note,
    ref: j.ref, service: "SHIFT GROUP SARL (USD)", company: "SHIFT GROUP SARL (USD)", companySrc: "odoo",
    partnerId: 13, partnerName: "Ste. ATTAL", partnerSrc: "odoo",
    analyticId: j.analyticId, analyticName: j.analyticName, analyticSrc: "odoo", analyticFrom: j.ref,
    paidBy: "khodr", paidBySrc: "odoo",
    files: [j.file.name], fileIds: [j.file],
    updatedAt: now, updatedBy: "claude-fix-2026-09-08",
  }, { merge: true });
  const t = (await db.doc(`workspaces/team/accounts/khodr-cash/tx/${j.row}`).get()).data();
  console.log(j.row, "| ref", t.ref, "| company", t.company, "| noBook", !!t.noBook, "| booked", t.bookedMove ? t.bookedMove.name : "-", "| analytic", t.analyticName, "| files", (t.fileIds || []).length);
}
process.exit(0);
