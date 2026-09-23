import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
for(const id of ["wa-p-2026-09-03-benzine","wa-p-2026-09-03-received","wal-3EB06E5E2E5D8A41B2D27E","xl-2026-09-03-d2000-benzine-odometer-2"]){
  const d=await db.doc(`workspaces/team/accounts/abed-cash/tx/${id}`).get();
  console.log("=== "+id); console.log(JSON.stringify(d.data(),null,1));
}
process.exit(0);
