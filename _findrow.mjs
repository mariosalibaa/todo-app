import admin from "firebase-admin";
import { readFileSync } from "node:fs";
const sa=JSON.parse(readFileSync("./firebase-service-account.json","utf8"));
admin.initializeApp({credential:admin.credential.cert(sa)});
const db=admin.firestore();
const accs=await db.collection("workspaces/team/accounts").get();
console.log("accounts:",accs.docs.map(d=>d.id).join(", "));
for(const a of accs.docs){
  const snap=await db.collection(`workspaces/team/accounts/${a.id}/tx`).where("date",">=","2026-08-28").where("date","<=","2026-09-03").get();
  snap.forEach(d=>{const t=d.data(); if(/kanaan/i.test(JSON.stringify(t))) console.log(a.id, d.id, JSON.stringify(t));});
}
process.exit(0);
