// A receipt photo on a day the sheet has no spending row on = a purchase that may never have been written down.
import admin from "firebase-admin";
import { readFileSync, writeFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const W = { ziad: "ziad-cash", abed: "abed-cash", khoder: "khodr-cash", mitri: "mitri-cash" };
const idx = JSON.parse(readFileSync("D:/vscode/wa-photos/index.json", "utf8"));
const out = [];
for (const [who, acct] of Object.entries(W)) {
  const snap = await db.collection(`workspaces/team/accounts/${acct}/tx`).get();
  const rows = snap.docs.map(d => d.data()).filter(t => (t.src === "excel" || t.src === "whatsapp") && !t.excluded);
  const spendByDate = {};
  rows.forEach(t => { if ((t.debit || 0) > 0 && t.nature !== "transfer") (spendByDate[t.date] = spendByDate[t.date] || []).push(t); });
  const days = {};
  idx.filter(p => p.who === who && !p.fromMe).forEach(p => { (days[p.date] = days[p.date] || []).push(p); });
  for (const date of Object.keys(days).sort()) {
    if (!spendByDate[date]) out.push({ who, date, photos: days[date].length, files: days[date].map(p => p.file) });
  }
  const n = Object.keys(days).filter(d => !spendByDate[d]).length;
  console.log(`${who}: ${n} day(s) with a photo but no spending row in the sheet`);
}
writeFileSync("D:/vscode/wa-photos/no-row-days.json", JSON.stringify(out, null, 1));
out.forEach(o => console.log(`  ${o.who} ${o.date} — ${o.photos} photo(s)`));
process.exit(0);
