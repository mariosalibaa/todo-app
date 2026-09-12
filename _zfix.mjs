import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const D = admin.firestore.FieldValue.delete();
const col = db.collection("workspaces/team/accounts/ziad-cash/tx");
const now = new Date().toISOString();

const FILE = { id: 5309, name: "20260901 kanaan 15$ - naccache 1728 - paid_ziad - posted.pdf" };
const match = {
  chosen: true, lineId: 11884, moveId: 4355, move: "PCSH5/2026/00011", date: "2026-09-01", amount: 15,
  partner: "Kanaan Group s.a.l", partnerId: 246, label: "Plywood sheet 244x122cm 4mm (note 07474)",
  company: "S LB", journal: "Cash ZIAD USD", state: "posted",
  docs: ["BILL/2026/09/0001 (Plywood sheet 244x122cm 4mm (note 07474))"],
  docIds: { "BILL/2026/09/0001 (Plywood sheet 244x122cm 4mm (note 07474))": 4354, "BILL/2026/09/0001": 4354 },
  odooRef: "Plywood sheet 244x122cm 4mm (note 07474)",
  analytics: [{ id: 115, name: "Mario Naccache 1728", from: "BILL/2026/09/0001" }],
  score: 10, why: ["same purchase as BILL/2026/09/0001 (invoice note 07474), tied by hand 2026-09-08"],
};

// 1. the Aug-31 "kanaan" row IS the plywood already booked as BILL/2026/09/0001 — never book it again
await col.doc("xl-2026-08-31-d1500-kanaan").set({
  bookedMove: D,
  noBook: true,
  noBookNote: "Same purchase as BILL/2026/09/0001 (Kanaan, plywood note 07474, $15, paid by Ziad). The duplicate BILL/2026/08/0029 booked from this row was deleted 2026-09-08.",
  ref: "BILL/2026/09/0001", service: "S LB", company: "S LB", companySrc: "odoo",
  partnerId: 246, partnerName: "Kanaan Group s.a.l", partnerSrc: "odoo",
  analyticId: 115, analyticName: "Mario Naccache 1728", analyticSrc: "odoo", analyticFrom: "BILL/2026/09/0001",
  paidBy: "ziad", paidBySrc: "odoo",
  files: [FILE.name], fileIds: [FILE],
  matchedOdoo: "odoo-11884",
  odoo: { checkedAt: now, matches: [match] },
  updatedAt: now, updatedBy: "claude-fix-2026-09-08",
}, { merge: true });

// 2. the Odoo payment line belongs to that row, by hand so imports keep it
await col.doc("odoo-11884").set({
  excluded: true, odooOnly: false, dupOf: "xl-2026-08-31-d1500-kanaan", dupSrc: "manual", tiedBy: "manual",
  updatedAt: now, updatedBy: "claude-fix-2026-09-08",
}, { merge: true });

// 3. the Sep-1 "Z40 - Ziad Payment August" row is NOT the plywood — untie it
await col.doc("xl-2026-09-01-d1500-z40-ziad-payment-a").set({
  matchedOdoo: D, odoo: D, ref: "", service: "S LB",
  partnerId: null, partnerName: "", partnerSrc: "",
  analyticId: null, analyticName: "", analyticSrc: "", analyticFrom: "",
  paidBy: "", paidBySrc: "",
  files: [], fileIds: [],
  company: "", companySrc: "",
  noBook: true,
  noBookNote: "Untied 2026-09-08: was wrongly matched to the Kanaan plywood payment (same $15, same day). Z39 = Ziad Payment July was $228 — check what Z40 August really is before booking.",
  ask: "Z40 — Ziad Payment August: the sheet says $15 while Z39 (July) was $228. Is $15 right, and what account should it go to?",
  updatedAt: now, updatedBy: "claude-fix-2026-09-08",
}, { merge: true });

for (const id of ["xl-2026-08-31-d1500-kanaan", "odoo-11884", "xl-2026-09-01-d1500-z40-ziad-payment-a"]) {
  const d = await col.doc(id).get();
  const t = d.data();
  console.log(id, "|", t.date, t.description, "| debit", t.debit, "| ref", t.ref, "| excluded", !!t.excluded, "| noBook", !!t.noBook, "| bookedMove", t.bookedMove ? t.bookedMove.name : "-", "| dupOf", t.dupOf || "-", "| matchedOdoo", t.matchedOdoo || "-");
}
process.exit(0);
