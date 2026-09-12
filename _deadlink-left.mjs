import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();
const rows = [];
for (const a of await (await db.collection('workspaces/team/accounts').get()).docs) {
  for (const d of (await a.ref.collection('tx').get()).docs) {
    const t = d.data(); const chosen = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
    const moveId = (t.bookedMove && t.bookedMove.id) || (chosen && chosen.moveId) || null;
    if (Number.isInteger(moveId)) rows.push({ acc: a.id, id: d.id, t, moveId, chosen });
  }
}
const ids = [...new Set(rows.map(r => r.moveId))]; const alive = new Set();
for (let i = 0; i < ids.length; i += 400) (await call('account.move', 'read', [ids.slice(i, i + 400), ['name']], { context: CTX })).forEach(m => alive.add(m.id));
for (const r of rows.filter(r => !alive.has(r.moveId)).sort((a, b) => (a.acc + a.t.date).localeCompare(b.acc + b.t.date)))
  console.log(`${r.acc.padEnd(11)} ${r.t.date} ${String(r.t.debit || -(r.t.credit || 0)).padStart(8)} | was ${String((r.chosen && r.chosen.move) || (r.t.bookedMove || {}).name || '').padEnd(19)} | ${(r.t.nature || '').padEnd(8)} ${r.t.excluded ? 'EXCL ' : ''}| ${String(r.t.description || '').replace(/\s+/g, ' ').slice(0, 55)}`);
process.exit(0);
