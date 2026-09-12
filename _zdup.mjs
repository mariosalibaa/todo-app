import admin from "firebase-admin";import {readFileSync,writeFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
const s=await db.collection("workspaces/team/accounts/ziad-cash/tx").get();
const all=s.docs.map(d=>({id:d.id,...d.data()}));
const byId=Object.fromEntries(all.map(t=>[t.id,t]));
const mv=t=>((t.credit||0)-(t.debit||0));
const groups={};
all.filter(t=>t.src==="odoo"&&t.dupOf).forEach(o=>{(groups[o.dupOf]=groups[o.dupOf]||[]).push(o);});
const multi=Object.entries(groups).filter(([,v])=>v.length>1);
let extra=0;
console.log(`${multi.length} sheet rows carry MORE THAN ONE Odoo line:`);
const rep=[];
for(const [rid,lines] of multi.sort((a,b)=>b[1].length-a[1].length)){
  const r=byId[rid]; if(!r) continue;
  const e=+(lines.reduce((a,l)=>a+mv(l),0)-mv(r)).toFixed(2); extra+=e;
  rep.push({row:rid,date:r.date,desc:r.description,sheet:mv(r),lines:lines.map(l=>({ref:l.ref,amount:mv(l),desc:l.description,company:l.company})),extra:e});
}
console.log("extra value Odoo carries beyond the sheet:",+extra.toFixed(2));
rep.slice(0,20).forEach(x=>{
  console.log(`\n  ${x.date} sheet ${x.sheet} "${(x.desc||"").slice(0,45)}" extra ${x.extra}`);
  x.lines.forEach(l=>console.log(`      ${String(l.amount).padStart(9)} ${l.ref} | ${(l.desc||"").slice(0,45)} | ${l.company||""}`));
});
writeFileSync("D:/vscode/odoo/out/ziad-multi-odoo-rows.json",JSON.stringify(rep,null,1));
process.exit(0);
