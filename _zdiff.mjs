import admin from "firebase-admin";import {readFileSync,writeFileSync} from "node:fs";
admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json","utf8")))});
const db=admin.firestore();
const s=await db.collection("workspaces/team/accounts/ziad-cash/tx").get();
const all=s.docs.map(d=>({id:d.id,...d.data()}));
const byId=Object.fromEntries(all.map(t=>[t.id,t]));
const mv=t=>((t.credit||0)-(t.debit||0));
const diffs=[];
for(const o of all.filter(t=>t.src==="odoo"&&t.dupOf)){
  const r=byId[o.dupOf]; if(!r) continue;
  const d=+(mv(r)-mv(o)).toFixed(2);
  if(Math.abs(d)>0.02) diffs.push({date:r.date,sheet:mv(r),odoo:mv(o),diff:d,desc:(r.description||"").slice(0,50),ref:o.ref||"",oDesc:(o.description||"").slice(0,50)});
}
diffs.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
const tot=+diffs.reduce((a,x)=>a+x.diff,0).toFixed(2);
console.log(`${diffs.length} tied pairs where his sheet and Odoo disagree by more than a cent, netting ${tot}`);
console.log("\ntop 25:");
diffs.slice(0,25).forEach(x=>console.log(`  ${x.date} sheet ${String(x.sheet).padStart(9)} vs odoo ${String(x.odoo).padStart(9)} = ${String(x.diff).padStart(8)} | ${x.desc} | ${x.ref}`));
const byYear={};diffs.forEach(x=>{const y=x.date.slice(0,4);byYear[y]=(byYear[y]||0)+x.diff;});
console.log("\nby year:",JSON.stringify(Object.fromEntries(Object.entries(byYear).map(([k,v])=>[k,+v.toFixed(2)]))));
const big=diffs.filter(x=>Math.abs(x.diff)>=5);
console.log(`${big.length} of them are $5 or more, netting ${+big.reduce((a,x)=>a+x.diff,0).toFixed(2)}`);
writeFileSync("D:/vscode/odoo/out/ziad-sheet-vs-odoo.json",JSON.stringify(diffs,null,1));
process.exit(0);
