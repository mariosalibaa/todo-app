// Every Georges payment in S DEV: memo = "<who collected> · <detail> · <WHISH ref>" so the Odoo list reads at a glance.
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call, searchRead } from "../odoo/odoo.mjs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const COMMIT = process.argv.includes('--commit');
const ctx = { allowed_company_ids: [10] };
const WHO = { '96171800980': 'Anthony Khalil (Whish)', '96171324324': 'Dib Mokhtar (Whish)' };
const RECEIPT = { '551249072': 'diesel 575L*1.28$/L', '568082106': 'diesel 650L*1.3$/L 24-8', '597314459': 'diesel 600L*1.33$/L 3-9' };
// hub Whish lines from the two collectors → which Odoo payment each is tied to
const q = await db.collection('workspaces/team/whishAccounts/20222279/tx').where('phone', 'in', Object.keys(WHO)).get();
const byMove = {}, byName = {};
for (const d of q.docs) { const t = d.data(); const won = t.odoo && (t.odoo.matches || []).find(m => m.chosen); const who = WHO[t.phone];
  if (won && won.moveId) byMove[won.moveId] = { who, id: d.id }; if (t.booked && t.booked.move) byName[t.booked.move] = { who, id: d.id }; if (won && won.move) byName[won.move.split(' ')[0]] = { who, id: d.id }; }
const pays = await searchRead('account.payment', [['partner_id', '=', 313], ['company_id', '=', 10], ['state', 'in', ['paid', 'in_process', 'posted']]], ['id', 'name', 'date', 'amount', 'memo', 'journal_id', 'move_id', 'payment_type'], { context: ctx, order: 'date, id' });
const out = [];
for (const p of pays) {
  const memo = String(p.memo || '').trim();
  if (/^(Anthony Khalil|Dib Mokhtar)/.test(memo)) { out.push([p.name, 'kept', memo]); continue; }
  const hub = byMove[p.move_id ? p.move_id[0] : 0] || byName[p.name] || null;
  const isWhish = /whish/i.test(p.journal_id[1]);
  const who = hub ? hub.who : !isWhish ? 'Anthony Khalil (cash)' : /diesel/i.test(memo) ? 'Dib Mokhtar (Whish)' : 'Anthony Khalil (Whish)';
  const ref = (memo.match(/WHISH-\d+/) || [])[0] || '';
  const hubId = hub ? hub.id : (ref ? ref.replace('WHISH-', '') : '');
  let detail = memo.replace(/WHISH-\d+/, '').replace(/^[\s·]+|[\s·]+$/g, '');
  if (RECEIPT[hubId]) detail = RECEIPT[hubId];
  if (p.payment_type === 'inbound') detail = (detail ? detail + ' · ' : '') + 'returned to Mario';
  const next = [who, detail, ref].filter(Boolean).join(' · ');
  out.push([p.name, next, memo]);
  if (COMMIT && next !== memo) await call('account.payment', 'write', [[p.id], { memo: next }], { context: ctx });
}
console.table(out.map(([n, a, b]) => ({ name: n, memo: a, was: b })));
console.log(COMMIT ? 'WRITTEN' : 'dry run');
