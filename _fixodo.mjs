import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8"))) });
const db = admin.firestore();
const ref = db.doc("workspaces/team/accounts/ziad-cash/tx/m-mtuc4oovslbm");
// the page (and the ⛽ Fuel view) read `odometer`, never `km`
await ref.set({ odometer: 285554, odoSrc: "manual", liters: 13.6, km: admin.firestore.FieldValue.delete(),
  updatedAt: new Date().toISOString(), updatedBy: "wa-fix-2026-09-10" }, { merge: true });
const d = (await ref.get()).data();
console.log(JSON.stringify({ car: d.car, odometer: d.odometer, liters: d.liters, km: d.km, files: d.files }));
process.exit(0);
