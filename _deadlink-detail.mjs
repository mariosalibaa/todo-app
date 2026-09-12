// what the 120 "clear" + 3 "ambiguous" dead links actually are — before anything is applied
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { call } from 'file:///D:/vscode/odoo/odoo.mjs';
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const purged = new Set(JSON.parse(readFileSync('C:/Users/MARIO_~1/AppData/Local/Temp/claude/d--vscode/8cbf8a89-790f-4dab-810c-c7b57ead7dda/scratchpad/purged-ids.json', 'utf8')));
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync('./firebase-service-account.json', 'utf8'))) });
const db = admin.firestore();
const accs = await db.collection('workspaces/team/accounts').get();
const rows = [];
for (const a of accs.docs) {
  const snap = await a.ref.collection('tx').get();
  for (const d of snap.docs) {
    const t = d.data();
    const chosen = t.odoo && (t.odoo.matches || []).find(m => m.chosen);
    const moveId = (t.bookedMove && t.bookedMove.id) || (chosen && chosen.moveId) || null;
    if (!Number.isInteger(moveId)) continue;
    rows.push({ acc: a.id, id: d.id, t, moveId, chosen });
  }
}
const ids = [...new Set(rows.map(r => r.moveId))];
const alive = new Set();
for (let i = 0; i < ids.length; i += 400) (await call('account.move', 'read', [ids.slice(i, i + 400), ['name']], { context: CTX })).forEach(m => alive.add(m.id));
const dead = rows.filter(r => !alive.has(r.moveId));
const kind = n => (String(n || '').match(/^[A-Z]+/) || ['?'])[0];
const by = {};
for (const r of dead) {
  const name = (r.chosen && r.chosen.move) || (r.t.bookedMove && r.t.bookedMove.name) || '?';
  const k = `${r.acc} | ${kind(name)} | ${purged.has(r.moveId) ? 'purged 10 Sep (cancelled)' : 'deleted some other way'} | src=${r.t.src}${r.t.excluded ? ' excluded' : ''}${r.t.noBook ? ' noBook' : ''}`;
  (by[k] = by[k] || []).push(r);
}
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
  const sum = v.reduce((s, r) => s + (r.t.debit || 0) - (r.t.credit || 0), 0);
  console.log(`${String(v.length).padStart(4)}  ${k}   net ${sum.toFixed(2)}   ${v.map(r => r.t.date).sort()[0]} → ${v.map(r => r.t.date).sort().pop()}`);
}
console.log('\nziad-cash sample (first 15 by date):');
dead.filter(r => r.acc === 'ziad-cash').sort((a, b) => a.t.date < b.t.date ? -1 : 1).slice(0, 15).forEach(r =>
  console.log(`  ${r.t.date} ${String(r.t.debit || -(r.t.credit || 0)).padStart(8)} | ${String((r.chosen && r.chosen.move) || (r.t.bookedMove || {}).name || '').padEnd(20)} | src=${r.t.src} ${r.t.nature || ''} | ${String(r.t.description || '').slice(0, 50)}`));
process.exit(0);
