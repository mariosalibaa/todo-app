import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8"))) });
const db = admin.firestore();
const col = db.collection("workspaces/team/accounts/ziad-cash/tx");
const snap = await col.where("date", ">=", "2026-09-08").where("date", "<=", "2026-09-10").get();
console.log("rows", snap.size);
for (const d of snap.docs) {
  const x = d.data();
  console.log(JSON.stringify({ id: d.id, date: x.date, desc: x.description, debit: x.debit, credit: x.credit,
    docs: (x.docs||[]).map(f=>f.name), fileIds: x.fileIds, car: x.car, km: x.km, moveId: x.moveId, analytic: x.analytic||x.analyticSplit }));
}
