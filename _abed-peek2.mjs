import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
const accs=await db.collection("workspaces/team/accounts").get();
console.log(accs.docs.map(d=>d.id+":"+(d.data().owner||"")).join(" | "));
const s=await db.collection("workspaces/team/accounts/abed-cash/tx").get();
for(const d of s.docs){const t=d.data();const txt=(t.description||"")+" "+(t.partnerName||"");if(/abdo|ibrahim|georges|azzi|return|cpr|melkite/i.test(txt))console.log(t.date,d.id,"D"+(t.debit||0),"C"+(t.credit||0),t.nature,t.partnerName,t.partnerId,t.partnerKind,t.cashAccountId||"",t.analyticName||"",t.company||"","|",(t.description||"").slice(0,80));}
process.exit(0);
