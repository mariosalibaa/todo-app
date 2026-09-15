import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const D = admin.firestore.FieldValue.delete();
for (const id of ['595445972', '592140404']) {
  const ref = db.doc('workspaces/team/whishAccounts/20222279/tx/' + id);
  const t = (await ref.get()).data();
  const matches = (t.odoo.matches || []).map(m => ({ ...m, chosen: false }));
  const rejected = [...new Set([...(t.odoo.rejected || []), ...matches.map(m => m.moveId)])];
  const data = { odoo: { ...t.odoo, matches, rejected }, odooPartner: D, updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario 2026-09-13: PCSH12/2026/00056 is a Melkite Liqaa receipt, not this payment)' };
  // what the wrong match had written follows it out
  if (t.partnerSrc === 'odoo') Object.assign(data, { partnerId: null, partnerName: '', partnerSrc: '', partnerKind: '' });
  if (t.companySrc === 'odoo') Object.assign(data, { company: '', companySrc: '', kind: '', kindSrc: '' });
  if (t.analyticSrc === 'odoo') Object.assign(data, { analyticId: null, analyticName: '', analyticSrc: '', analyticFrom: '' });
  await ref.set(data, { merge: true });
  console.log(id, t.date, t.debit, t.description, '| partner was', t.partnerName, t.partnerSrc, '| untied from', matches.map(m => m.move).join(','));
}
