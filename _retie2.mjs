import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const D = admin.firestore.FieldValue.delete();
const now = new Date().toISOString();

const jobs = [
  {
    acct: "ziad-cash", row: "xl-2026-05-13-d24900-sakr",
    ref: "BILL/2026/05/0023", partnerId: 325, partnerName: "Sakr Building Materials",
    analyticId: 69, analyticName: "Ajaltoun 4193",
    file: { id: 5241, name: "20260513 Sakr Building Materials 249.55$ Fiprostar Foval and Ingco cordless combo kit - ajaltoun 4193.pdf" },
    paidBy: "ziad",
    note: "Same purchase as BILL/2026/05/0023 (Sakr, Fiprostar Foval + Ingco combo kit, invoice $249.55). The duplicate BILL/2026/05/0032 booked from this row was deleted 2026-09-08; the real bill is now paid from Cash ZIAD USD and the 0.55 difference with the sheet sits in MISC/2026/05/0002 (ZIADCASH-ROUNDING-2026-05).",
  },
  {
    acct: "khodr-cash", row: "xl-2026-07-22-d10100-sakr",
    ref: "BILL/2026/07/0004", partnerId: 325, partnerName: "Sakr Building Materials",
    analyticId: 21, analyticName: "Mckinsey",
    file: { id: 5246, name: "20260722 Sakr Building Materials 101.01$ photovoltaic brush.pdf" },
    paidBy: "khodr",
    note: "Same purchase as BILL/2026/07/0004 (Sakr, photovoltaic brush, invoice $101.01). The duplicate BILL/2026/07/0021 booked from this row was deleted 2026-09-08; the real bill is now settled paid-by Khodr (PSETT/2026/00058) instead of Cash Mario, and the 0.01 difference sits in MISC/2026/07/0003 (KHODRCASH-ROUNDING-2026-07).",
  },
];

for (const j of jobs) {
  await db.doc(`workspaces/team/accounts/${j.acct}/tx/${j.row}`).set({
    bookedMove: D, noBook: true, noBookNote: j.note,
    ref: j.ref, service: "S LB", company: "S LB", companySrc: "odoo",
    partnerId: j.partnerId, partnerName: j.partnerName, partnerSrc: "odoo",
    analyticId: j.analyticId, analyticName: j.analyticName, analyticSrc: "odoo", analyticFrom: j.ref,
    paidBy: j.paidBy, paidBySrc: "odoo",
    files: [j.file.name], fileIds: [j.file],
    updatedAt: now, updatedBy: "claude-fix-2026-09-08",
  }, { merge: true });
  const t = (await db.doc(`workspaces/team/accounts/${j.acct}/tx/${j.row}`).get()).data();
  console.log(j.acct, j.row, "| ref", t.ref, "| noBook", !!t.noBook, "| booked", t.bookedMove ? t.bookedMove.name : "-", "| files", (t.fileIds || []).length, "| analytic", t.analyticName);
}
process.exit(0);
