import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call, searchRead } from "../odoo/odoo.mjs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const COMMIT = process.argv.includes('--commit');
const ctx = { allowed_company_ids: [2,4,7,8,9,10] };
const canc = await searchRead('account.payment',[['state','=','canceled']],['id','name','date','amount','partner_id','journal_id','company_id','move_id','memo'],{context:ctx,order:'company_id, date'});
const byCo = {}; for (const p of canc) { const k = p.company_id[1]; byCo[k] = (byCo[k]||0)+1; }
console.log('cancelled payments:', canc.length, byCo);
const withMove = canc.filter(p => p.move_id);
const moves = withMove.length ? await call('account.move','read',[withMove.map(p=>p.move_id[0]),['state','name']],{context:ctx}) : [];
const moveState = Object.fromEntries(moves.map(m=>[m.id,m.state]));
const names = new Set(canc.map(p=>p.name).filter(Boolean));
// hub rows still naming a cancelled payment?
const ws = db.doc('workspaces/team');
const refs = [...(await ws.collection('accounts').get()).docs, ...(await ws.collection('whishAccounts').get()).docs];
const hits = [];
for (const r of refs) { const q = await r.ref.collection('tx').get(); for (const d of q.docs) { const t = d.data();
  const named = [t.bookedMove && t.bookedMove.name, t.booked && t.booked.move, t.ref, ...((t.odoo && t.odoo.matches) || []).filter(m=>m.chosen).map(m=>String(m.move||'').split(' ')[0])].filter(Boolean);
  for (const nm of named) for (const part of String(nm).split(/\s*\+\s*/)) if (names.has(part)) hits.push({ acc: r.id, row: d.id, name: part, src: t.src }); } }
console.log('hub rows naming a cancelled payment:', hits.length); if (hits.length) console.table(hits.slice(0,30));
const blockedNames = new Set(hits.map(h=>h.name));
const safe = canc.filter(p => !blockedNames.has(p.name) && (!p.move_id || moveState[p.move_id[0]] === 'cancel'));
const unsafe = canc.filter(p => !safe.includes(p));
console.log('safe to delete:', safe.length, '| held back:', unsafe.length, unsafe.map(p=>`${p.name} (${p.move_id?moveState[p.move_id[0]]:'no move'}${blockedNames.has(p.name)?', hub':''})`).join(', '));
if (COMMIT && safe.length) {
  const mids = safe.filter(p=>p.move_id).map(p=>p.move_id[0]);
  if (mids.length) { try { await call('account.move','unlink',[mids],{context:ctx}); } catch(e) { console.log('moves:', e.message.slice(0,200)); } }
  for (let i = 0; i < safe.length; i += 50) await call('account.payment','unlink',[safe.slice(i,i+50).map(p=>p.id)],{context:ctx});
  console.log('DELETED', safe.length);
}
