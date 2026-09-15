// For each held dead-link row: is there a live Odoo document (bill / entry / payment) of the same amount around
// the date, and is it paid? Tells rebook vs re-tie vs noBook. Read-only.
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
const dead = rows.filter(r => !alive.has(r.moveId)).sort((a, b) => (a.acc + a.t.date).localeCompare(b.acc + b.t.date));
const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
for (const r of dead) {
  const t = r.t, amt = Math.abs(t.debit || t.credit || 0), lo = shift(t.date, -20), hi = shift(t.date, 20);
  const dom = [['amount_total', '>=', amt - 0.02], ['amount_total', '<=', amt + 0.02], ['date', '>=', lo], ['date', '<=', hi], ['state', '=', 'posted']];
  if (t.partnerId) dom.push(['partner_id', '=', t.partnerId]);
  const M = await call('account.move', 'search_read', [dom], { fields: ['name', 'date', 'move_type', 'payment_state', 'ref', 'partner_id', 'company_id', 'amount_residual'], context: CTX, limit: 6 });
  const P = await call('account.payment', 'search_read', [[['amount', '>=', amt - 0.02], ['amount', '<=', amt + 0.02], ['date', '>=', lo], ['date', '<=', hi], ['state', 'in', ['paid', 'in_process', 'posted']]]], { fields: ['name', 'date', 'journal_id', 'partner_id', 'memo', 'is_reconciled'], context: CTX, limit: 6 });
  console.log(`\n${r.acc} ${t.date} ${amt} ${t.nature || ''} | ${(t.partnerName || t.partnerText || '')} | ${String(t.description || '').slice(0, 50)} | id ${r.id} noBook=${!!t.noBook}`);
  for (const m of M) console.log(`   DOC ${m.name} ${m.date} ${m.move_type} ${m.payment_state} residual ${m.amount_residual} ${m.partner_id ? m.partner_id[1] : ''} [${m.company_id[1].slice(0, 10)}] ${m.ref || ''}`);
  for (const p of P) console.log(`   PAY ${p.name} ${p.date} ${p.journal_id[1]} ${p.partner_id ? p.partner_id[1] : ''} rec=${p.is_reconciled} ${p.memo || ''}`);
  if (!M.length && !P.length) console.log('   nothing live');
}
process.exit(0);
