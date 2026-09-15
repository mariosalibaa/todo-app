import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ws = db.doc('workspaces/team');
const refs = [...(await ws.collection('accounts').get()).docs, ...(await ws.collection('whishAccounts').get()).docs];
let n = 0, seen = 0; const by = {};
for (const r of refs) {
  const q = await r.ref.collection('tx').where('phone', 'in', ['96171909092', '+96171909092']).get();
  for (const d of q.docs) { const t = d.data(); seen++;
    if (t.partnerId === 330 && t.partnerSrc === 'manual') continue;
    await d.ref.set({ partnerId: 330, partnerName: 'Melkite Liqaa', partnerSrc: 'manual', partnerKind: 'partner', cashJournalId: null, cashJournalName: '', cashJournalCompany: '', cashAccountId: null,
      updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario 2026-09-13: every Kamal Bekassini payment = Melkite Liqaa; company left for Mario)' }, { merge: true });
    n++; by[r.id] = (by[r.id] || 0) + 1; }
}
console.log('Kamal lines', seen, 'set to Melkite Liqaa:', n, by);
