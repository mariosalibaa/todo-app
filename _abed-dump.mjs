import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("D:/vscode/todo/firebase-service-account.json","utf8")))});
const db=admin.firestore();
const a=await db.doc("workspaces/team/accounts/abed-cash").get();
const d=a.data();
console.log("ACCOUNT", JSON.stringify({statement:d.statement,waLive:d.waLive,waScan:d.waScan,whatsapp:d.whatsapp,excel:d.excel},null,1));
const s=await db.collection("workspaces/team/accounts/abed-cash/tx").get();
const rows=s.docs.map(x=>({id:x.id,...x.data()})).filter(t=>(t.date||"")>="2026-08-25").sort((a,b)=>(a.date||"").localeCompare(b.date||"")||a.id.localeCompare(b.id));
for(const t of rows){
  console.log([t.date,t.id,`D${t.debit||0}`,`C${t.credit||0}`,`xl=${t.xlAmount??""}`,t.period||"",t.excluded?"EXCL":"",t.review?"REV":"",`wa=${t.waAccepted}`,t.dupOf?"dup:"+t.dupOf:"",t.odooOnly?"odooOnly":"",t.waAt||"",t.nature||"",`| ${(t.description||t.label||"").slice(0,70)}`,t.partnerName||t.partner?.name||"",t.analyticName||t.analytic?.name||""].join(" "));
}
process.exit(0);
