// The 31 dead links held on 2026-09-12, decided 2026-09-14 (Mario: GO):
//   re-tie where Odoo has the entry that replaced the deleted one (MISC "ZIADCASH-REPLACES-…", the PSETT
//   "Paid by Ziad Arabe" settlement, the re-created Khodr PCSH), clear the rest so the booking queue
//   rebooks them (bill + settlement / transfer pair) — nothing live matches them anywhere in Odoo.
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const APPLY = process.argv.includes('--apply');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore(); const now = () => new Date().toISOString();
const RETIE = {   // hub row id → live Odoo move name
  'xl-2025-06-30-d30000-ahmad-paint': 'MISC/2025/06/0001', 'xl-2025-07-15-d20000-ahmad-paint': 'MISC/2025/07/0003', 'xl-2025-08-01-d20000-ahmad-paint': 'MISC/2025/08/0003',
  'xl-2025-11-03-c35000-from-bookstop': 'MISC/2025/11/0001', 'xl-2026-01-23-d100000-850-euros-to-kcce': 'MISC/2026/01/0004',
  'xl-2026-03-24-c158000-elie-rizk': 'MISC/2026/03/0001', 'xl-2026-04-15-d2859-attal-official': 'MISC/2026/04/0003', 'xl-2026-05-19-c43300-from-phoenix': 'MISC/2026/05/0002',
  'xl-2026-01-23-d685-gypsum-board-unoff': 'PSETT/2026/00065', 'xl-2026-01-27-d950-nacouzi-unofficial': 'PSETT/2026/00066', 'xl-2026-03-10-d3500-zeenni-unofficial': 'PSETT/2026/00079',
  'xl-2026-03-14-d450-nacouzi-unofficial': 'PSETT/2026/00081', 'xl-2026-05-13-d1480-attal-official': 'PSETT/2026/00110', 'xl-2026-05-20-d666-attal-official': 'PSETT/2026/00119',
  'xl-2026-06-16-c15000-received-from-mari': 'PCSH1/2026/00185', 'xl-2026-06-19-d2869-attal': 'BILL/2026/06/0011',
};
const CLEAR = ['xl-2026-08-07-d861-pharmacy', 'xl-2026-05-06-c400000-from-mario', 'xl-2026-05-18-c100000-from-tony-menassa', 'xl-2026-07-01-c10000-from-mario',
  'xl-2026-01-28-d4500-simon-electric-off', 'xl-2026-02-03-d201082-electromec-officia', 'xl-2026-02-16-d450-attal-official', 'xl-2026-04-02-d51000-kbe-official',
  'xl-2026-05-08-d1611-transport-ketermey', 'xl-2026-05-11-d2000-simon-electric-off', 'xl-2026-05-11-d2700-simon-electric-off', 'xl-2026-05-11-d4900-attal-official',
  'xl-2026-05-14-d667-transport-to-nacca', 'xl-2026-05-14-d760-attal-official', 'xl-2026-05-21-d3900-attal-official'];
// resolve the live moves once (a name can repeat across companies: MISC/2026/04/0003 exists twice — take the one with the ZIADCASH ref)
const names = [...new Set(Object.values(RETIE))];
const MV = await call('account.move', 'search_read', [[['name', 'in', names]]], { fields: ['name', 'ref', 'state', 'company_id', 'amount_total', 'date'], context: CTX, limit: 100 });
const byName = {}; for (const m of MV) (byName[m.name] = byName[m.name] || []).push(m);   // the same name can live in two companies
const pick = (name, amt) => (byName[name] || []).sort((x, y) => Math.abs(x.amount_total - amt) - Math.abs(y.amount_total - amt))[0];
let done = 0;
for (const a of await (await db.collection('workspaces/team/accounts').get()).docs) {
  for (const d of (await a.ref.collection('tx').get()).docs) {
    const t = d.data(), id = d.id; const chosen = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
    if (RETIE[id]) {
      const amt = Math.abs(t.debit || t.credit || 0); const to = pick(RETIE[id], amt); if (!to) { console.log('MISSING', RETIE[id]); continue; }
      if (Math.abs(to.amount_total - amt) > 0.11) { console.log('AMOUNT MISMATCH', id, RETIE[id], to.amount_total, amt); continue; }
      const co = to.company_id[1];
      console.log(`${a.id.padEnd(11)} ${t.date} ${String(t.debit || -(t.credit || 0)).padStart(8)} ${String(t.description || '').slice(0, 30).padEnd(30)} -> ${to.name} ${to.date} ${to.amount_total} [${co.slice(0, 10)}] ${(to.ref || '').slice(0, 40)}`);
      if (!APPLY) continue;
      const before = { company: t.company || '', ref: t.ref || '', bookedMove: t.bookedMove || null, odooMoveId: chosen ? chosen.moveId : null };
      const data = { company: co, service: co, companySrc: 'odoo', ref: to.name,
        bookedMove: { ...(t.bookedMove || {}), id: to.id, name: to.name, ref: to.ref || '', state: to.state, at: now(), retiedAt: now() }, updatedAt: now(), updatedBy: 'deadlink-audit' };
      if (chosen) data.odoo = { ...t.odoo, checkedAt: now(), matches: (t.odoo.matches || []).map(x => x.chosen ? { ...x, moveId: to.id, move: to.name, company: co, state: to.state, docs: [], docIds: {}, why: [...(x.why || []), 'the entry it named was deleted; re-tied to ' + to.name] } : x) };
      await a.ref.collection('tx').doc(id).set(data, { merge: true });
      await a.ref.collection('log').add({ at: now(), who: 'deadlink-audit', txId: id, line: [t.date, t.description].filter(Boolean).join(' · ').slice(0, 80), before, after: { company: co, ref: to.name, odooMoveId: to.id }, undo: false });
      done++;
    } else if (CLEAR.includes(id)) {
      console.log(`${a.id.padEnd(11)} ${t.date} ${String(t.debit || -(t.credit || 0)).padStart(8)} ${String(t.description || '').slice(0, 30).padEnd(30)} -> CLEAR (back to the booking queue)`);
      if (!APPLY) continue;
      const before = { company: t.company || '', ref: t.ref || '', bookedMove: t.bookedMove || null, odooMoveId: chosen ? chosen.moveId : null };
      await a.ref.collection('tx').doc(id).set({ bookedMove: admin.firestore.FieldValue.delete(), ref: '', odoo: { checkedAt: now(), matches: [] }, updatedAt: now(), updatedBy: 'deadlink-audit' }, { merge: true });
      await a.ref.collection('log').add({ at: now(), who: 'deadlink-audit', txId: id, line: [t.date, t.description].filter(Boolean).join(' · ').slice(0, 80), before, after: { bookedMove: null, ref: '', odooMoveId: null }, undo: false });
      done++;
    }
  }
}
console.log(APPLY ? `${done} rows written` : '(dry run — add --apply)');
process.exit(0);
