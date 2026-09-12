import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const COMMIT = process.argv.includes('--commit');
const ws = db.doc('workspaces/team');
const refs = [...(await ws.collection('accounts').get()).docs, ...(await ws.collection('whishAccounts').get()).docs];
const PHONES = new Set(['96171800980', '96171324324', '+96171800980', '+96171324324']);
let nProj = 0, nConf = 0, by = {};
let batch = db.batch(), inBatch = 0;
const put = (ref, data) => { batch.update(ref, data); if (++inBatch >= 400) { const b = batch; batch = db.batch(); inBatch = 0; return b.commit(); } };
for (const r of refs) {
  const q = await r.ref.collection('tx').where('company', '==', 'SHIFT DEVELOPMENT').get();
  for (const d of q.docs) {
    const t = d.data(); const data = {};
    // 1. project Ajaltoun 4193 on every SHIFT DEVELOPMENT line — unless Odoo's reconciled document already says another project
    if (t.analyticId !== 69 && t.analyticSrc !== 'odoo') { Object.assign(data, { analyticId: 69, analyticName: 'Ajaltoun 4193', analyticSrc: 'manual', analyticText: '' }); nProj++; }
    // 2. Anthony / Dib Mokhtar lines: partner + company confirmed by hand (they were only auto-suggested = blue italic)
    if (PHONES.has(t.phone) && (t.partnerSrc !== 'manual' || t.companySrc !== 'manual')) { Object.assign(data, { partnerId: 313, partnerName: 'Georges EL Hajj', partnerSrc: 'manual', partnerKind: 'partner', companySrc: 'manual', kind: 'work', kindSrc: 'manual', suggestSkip: false }); nConf++; }
    if (Object.keys(data).length) { by[r.id] = (by[r.id] || 0) + 1; if (COMMIT) await put(d.ref, { ...data, updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario 2026-09-12: S DEV lines → Ajaltoun 4193; Anthony/Dib confirmed)' }); }
  }
}
if (COMMIT && inBatch) await batch.commit();
console.log('by account', by, '| project set:', nProj, '| partner/company confirmed:', nConf, COMMIT ? 'COMMITTED' : '(dry run)');
