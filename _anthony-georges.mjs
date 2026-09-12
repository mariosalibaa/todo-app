import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const COMMIT = process.argv.includes('--commit');
const PHONES = ['96171800980', '96171324324', '+96171800980', '+96171324324'];   // Anthony Khalil (Hrajel Hafer excavation), Dib Mokhtar (diesel anthony)
const ws = db.doc('workspaces/team');
const refs = [...(await ws.collection('accounts').get()).docs, ...(await ws.collection('whishAccounts').get()).docs];
const docs = [];
for (const r of refs) { const q = await r.ref.collection('tx').where('phone', 'in', PHONES).get(); docs.push(...q.docs); }
const snap = { docs };
let n = 0, by = {};
const batch = db.batch();
for (const d of snap.docs) {
  const t = d.data(); const acc = d.ref.parent.parent.id;
  by[acc] = (by[acc] || 0) + 1;
  const same = t.partnerId === 313 && t.company === 'SHIFT DEVELOPMENT';
  if (same) continue;
  n++;
  if (COMMIT) batch.update(d.ref, {
    partnerId: 313, partnerName: 'Georges EL Hajj', partnerSrc: 'manual', partnerKind: 'partner',
    cashJournalId: null, cashJournalName: '', cashJournalCompany: '', cashAccountId: null,
    company: 'SHIFT DEVELOPMENT', companySrc: 'manual', kind: 'work', kindSrc: 'manual', suggestSkip: false,
    updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario 2026-09-12: Anthony + Dib Mokhtar lines = Georges EL Hajj / SHIFT DEVELOPMENT)',
  });
}
console.log('lines by account', by, '| to change:', n, COMMIT ? '(committing)' : '(dry run)');
if (COMMIT && n) { await batch.commit(); console.log('done'); }
