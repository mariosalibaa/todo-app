import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
for (const acc of ["ziad-cash", "abed-cash", "khodr-cash", "mitri-cash"]) {
  const snap = await db.collection(`workspaces/team/accounts/${acc}/tx`).get();
  const rows = snap.docs.map(d => d.data()).filter(t => t.src === "excel" || t.src === "whatsapp");
  const withF = rows.filter(t => (t.fileIds || []).length);
  const booked = rows.filter(t => t.bookedMove);
  const by = {};
  rows.forEach(t => { const m = (t.date || "").slice(0, 7); by[m] = by[m] || [0, 0]; by[m][0]++; if ((t.fileIds || []).length) by[m][1]++; });
  const months = Object.keys(by).sort();
  console.log(`${acc}: rows ${rows.length}, with photos ${withF.length}, booked ${booked.length}, ${months[0]} → ${months[months.length - 1]}`);
  console.log("   recent:", months.slice(-8).map(m => `${m} ${by[m][1]}/${by[m][0]}`).join("  "));
}
process.exit(0);
