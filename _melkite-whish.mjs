import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const col = db.collection('workspaces/team/whishAccounts/20222279/tx');
const q = await col.where('date', '>=', '2026-09-01').where('date', '<=', '2026-09-12').get();
for (const d of q.docs) { const t = d.data(); if (t.credit > 0 || /melkite|liqaa|kamal/i.test(JSON.stringify([t.description, t.note, t.partnerName]))) console.log(d.id, t.date, 'in', t.credit || '', 'out', t.debit || '', t.description, '|', t.partnerName, '|', t.odoo && (t.odoo.matches||[]).filter(m=>m.chosen).map(m=>m.move).join(',')); }
