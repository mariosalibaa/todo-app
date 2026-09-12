// Ziad's hub account off the cash-box model: from now on his rows are booked the way Abed's,
// Khodr's and Mitri's are — a bill from him settled paid-by him — not as entries in a cash box.
// Run only after ziad-to-partner-ledger.mjs has emptied his cash accounts in Odoo.
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ref = db.doc("workspaces/team/accounts/ziad-cash");
const before = (await ref.get()).data();
console.log("before: cashBox =", before.cashBox, "| odooPartner =", JSON.stringify(before.odooPartner), "| journals =", (before.odooJournals || []).map(j => j.id).join(","));
if (process.argv.includes("--commit")) {
  await ref.set({ cashBox: false, cashBoxNote: "Moved to the partner ledger 2026-09-08: his cash journals were emptied onto 401100 / Ziad Arabe, like Abed, Khodr and Mitri.", updatedAt: new Date().toISOString(), updatedBy: "ziad-partner-2026-09-08" }, { merge: true });
  const after = (await ref.get()).data();
  console.log("after: cashBox =", after.cashBox);
} else console.log("dry run — pass --commit");
process.exit(0);
