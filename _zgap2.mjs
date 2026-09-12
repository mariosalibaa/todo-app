import admin from "firebase-admin";import {readFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
const s=await db.collection("workspaces/team/accounts/ziad-cash/tx").get();
const all=s.docs.map(d=>({id:d.id,...d.data()}));
const mv=t=>((t.credit||0)-(t.debit||0));
const od=all.filter(t=>t.src==="odoo"), xl=all.filter(t=>t.src==="excel");
console.log("ALL odoo lines in hub:",od.length,"net(credit-debit)",+od.reduce((x,t)=>x+mv(t),0).toFixed(2));
console.log("  cash-journal lines:",od.filter(t=>/Cash Ziad|Cash ZIAD/i.test((t.odoo?.matches?.[0]?.journal)||"")).length);
console.log("ALL excel rows:",xl.length,"net",+xl.reduce((x,t)=>x+mv(t),0).toFixed(2));
console.log("excel debit total",+xl.reduce((x,t)=>x+(t.debit||0),0).toFixed(2),"credit total",+xl.reduce((x,t)=>x+(t.credit||0),0).toFixed(2));
console.log("odoo debit total",+od.reduce((x,t)=>x+(t.debit||0),0).toFixed(2),"credit total",+od.reduce((x,t)=>x+(t.credit||0),0).toFixed(2));
// how many excel rows carry an odoo tie at all
console.log("excel rows tied:",xl.filter(t=>t.matchedOdoo||t.bookedMove).length,"of",xl.length);
process.exit(0);
