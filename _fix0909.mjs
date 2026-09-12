import admin from "firebase-admin";
import { readFileSync } from "node:fs";
const COMMIT = process.argv.includes("--commit");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8"))) });
const db = admin.firestore();
const col = db.collection("workspaces/team/accounts/ziad-cash/tx");

// 1. the 13:09 shop slip (785,000 LBP) is not the paper for a 800,000 LBP taxi fare —
//    _wa-tie matched it on the 2% amount gap alone. Take it back off that row.
const a = col.doc("m-mtu0pu6uf6th");
const ad = (await a.get()).data();
const keep = (ad.fileIds || []).filter(f => f.name !== "wa ziad 2026-09-09 13h09 AC642F.jpg");
console.log("transport row fileIds:", (ad.fileIds||[]).map(f=>f.name), "->", keep.map(f=>f.name));

// 2. the odometer Ziad photographed at 17:35/17:36, minutes before the Chrisso fill
const b = col.doc("m-mtuc4oovslbm");
const bd = (await b.get()).data();
console.log("laredo row km:", bd.km, "-> 285554  (car", bd.car + ")");

if (COMMIT) {
  await a.set({ fileIds: keep, files: keep.map(f=>f.name), waPhotos: keep.length>0,
    updatedAt: new Date().toISOString(), updatedBy: "wa-fix-2026-09-10" }, { merge: true });
  await b.set({ km: 285554, updatedAt: new Date().toISOString(), updatedBy: "wa-fix-2026-09-10" }, { merge: true });
  console.log("written");
} else console.log("DRY RUN");
process.exit(0);
