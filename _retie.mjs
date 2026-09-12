// Re-point a hub cash row that was booked as a duplicate bill onto the bill that survived.
// Usage: node _retie.mjs <account> <rowIdFragment>
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const [acct, frag] = process.argv.slice(2);
const snap = await db.collection(`workspaces/team/accounts/${acct}/tx`).get();
snap.docs.filter(d => d.id.includes(frag)).forEach(d => {
  const t = d.data();
  console.log(d.id, "|", t.date, "|", t.description, "| debit", t.debit, "credit", t.credit,
    "| ref", t.ref, "| booked", t.bookedMove && t.bookedMove.name, "| matchedOdoo", t.matchedOdoo,
    "| noBook", !!t.noBook, "| files", (t.fileIds || []).length);
});
process.exit(0);
