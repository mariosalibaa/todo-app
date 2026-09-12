import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
for(const a of ["ziad-cash","khodr-cash","abed-cash","mitri-cash"]){
  const s=await db.collection(`workspaces/team/accounts/${a}/tx`).get();
  const rows=s.docs.map(d=>d.data()).filter(t=>!t.excluded);
  const mv=t=>t.xlAmount!=null?-(+t.xlAmount):((t.credit||0)-(t.debit||0));
  const bal=rows.reduce((x,t)=>x+mv(t),0);
  console.log(a.padEnd(11),"hub balance",bal.toFixed(2),"| rows",rows.length,"| with photos",rows.filter(t=>(t.fileIds||[]).length).length,"| noBook",rows.filter(t=>t.noBook).length);
}
process.exit(0);
