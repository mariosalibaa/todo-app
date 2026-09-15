import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call, searchRead } from "../odoo/odoo.mjs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ctx = { allowed_company_ids: [2,4,7,8,9,10] };
const canc = await searchRead('account.payment',[['state','=','canceled'],['move_id','=',false]],['id','name'],{context:ctx});
const ziadNames = new Set(canc.filter(p=>/^PCSH5\//.test(p.name)).map(p=>p.name));
// Ziad's rows: the ref named a booking that was cancelled — clear it so the row reads as unbooked again
const q = await db.collection('workspaces/team/accounts/ziad-cash/tx').where('src','==','excel').get();
let cleared = 0;
for (const d of q.docs) { const t = d.data(); if (t.ref && ziadNames.has(t.ref) && !(t.bookedMove && t.bookedMove.id)) { await d.ref.set({ ref: '', staleRef: t.ref, updatedAt: new Date().toISOString(), updatedBy: 'claude (2026-09-13: cancelled payment deleted, ref cleared)' }, { merge: true }); cleared++; } }
await call('account.payment','unlink',[canc.map(p=>p.id)],{context:ctx});
console.log('deleted', canc.length, 'cancelled payments | Ziad refs cleared:', cleared, '| cancelled left:', (await searchRead('account.payment',[['state','=','canceled']],['id'],{context:ctx})).length);
