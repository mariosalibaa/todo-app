import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const col = db.collection('workspaces/team/whishAccounts/20222279/tx');
// the mistaken transfer was tied to the diesel payment (move of PCSH2/2026/00029): untie, never re-tie, let the check find PCSH2/2026/00045
const d = await col.doc('511159650').get(); const t = d.data();
const dieselMove = (t.odoo.matches || []).find(m => m.chosen)?.moveId;
await col.doc('511159650').set({ odoo: { checkedAt: new Date().toISOString(), matches: [], rejected: [...new Set([...(t.odoo.rejected || []), dieselMove].filter(Boolean))] }, note: 'sent to Anthony by mistake on 27-7, returned the same day (tr:511350926)', noteSrc: 'manual', updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario GO 2026-09-13)' }, { merge: true });
await col.doc('511350926').set({ note: 'the $636 sent by mistake, returned by Anthony', noteSrc: 'manual', updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario GO 2026-09-13)' }, { merge: true });
console.log('untied 511159650 from move', dieselMove);
