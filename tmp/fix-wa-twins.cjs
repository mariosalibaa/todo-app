// One-off (2026-10-06): WhatsApp proposals still showing next to the line Mario booked by hand from the same message.
// Same account, same day, same direction, message time within 2 min, amount within 20 % → the proposal becomes a
// linked twin (dupOf, excluded, review false) — exactly what ledgers.js pairUp now does on every read.
//   node tmp/fix-wa-twins.cjs          dry run (lists)
//   node tmp/fix-wa-twins.cjs --write  applies
const admin = require('D:/vscode/todo/node_modules/firebase-admin');
const sa = require('D:/vscode/todo/firebase-service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const WRITE = process.argv.includes('--write');
const amt = t => t.debit || t.credit || 0;
const sameDir = (r, o) => (r.debit > 0 && o.debit > 0) || (r.credit > 0 && o.credit > 0);
const owned = t => !!(t.waAccepted || t.reviewed || t.reviewedAt || t.ref || t.bookedMove || t.dupSrc === 'manual');
(async () => {
  const db = admin.firestore();
  const accs = await db.collection('workspaces').doc('team').collection('accounts').get();
  let total = 0;
  for (const a of accs.docs) {
    const tx = (await a.ref.collection('tx').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const props = tx.filter(t => (t.src === 'whatsapp' || t.src === 'site') && t.review && t.excluded && t.dupSrc !== 'manual' && !owned(t) && t.waAt);
    if (!props.length) continue;
    const targets = tx.filter(t => !t.excluded && (['odoo', 'excel', 'manual', 'telegram', 'transfer'].includes(t.src) || ((t.src === 'whatsapp' || t.src === 'site') && owned(t))));
    const taken = new Set(tx.filter(t => t.dupOf && (t.src === 'whatsapp' || t.src === 'site')).map(t => t.dupOf));   // an Odoo line folded onto an Excel row does not use it up
    const fixes = [];
    for (const p of props) {
      const score = o => Math.abs(Date.parse(p.waAt) - Date.parse(o.waAt)) / 60e3 * 0.1 + Math.abs(amt(p) - amt(o)) / (Math.max(amt(p), amt(o)) || 1);
      // (a) the same message time, amount within 20 %; (b) no message time on the target (Excel / Odoo): the same day
      // and the same amount to 1 % ($0.10 at least) — Arabic words never meet the English Excel text, so the words
      // test of pairUp never fired on those (Ziad: ~40 grey twins from 2025-26)
      const o = targets.filter(o => !taken.has(o.id) && o.date === p.date && sameDir(p, o) && (
        (o.waAt && Math.abs(Date.parse(p.waAt) - Date.parse(o.waAt)) <= 2 * 60e3 && Math.abs(amt(p) - amt(o)) <= Math.max(0.5, Math.max(amt(p), amt(o)) * 0.2))
        || (!o.waAt && Math.abs(amt(p) - amt(o)) <= Math.max(0.1, Math.max(amt(p), amt(o)) * 0.01))))
        .sort((x, y) => (x.waAt ? score(x) : Math.abs(amt(p) - amt(x))) - (y.waAt ? score(y) : Math.abs(amt(p) - amt(y))))[0];
      if (o) { taken.add(o.id); fixes.push([p, o]); continue; }
      // (c) the same movement told twice — Mario writes "100$ from ziad to mitri", Ziad writes "١٠٠ دولار للمعلم متري":
      // the first already sits on the Excel row; the second report, same day / way / amount, joins that row too
      // (only when the sheet has no free row of that amount that day — the sheet is the truth)
      const twinRow = targets.find(o => o.src === 'excel' && o.date === p.date && sameDir(p, o) && Math.abs(amt(p) - amt(o)) <= Math.max(0.1, amt(o) * 0.01)
        && tx.some(w => w.id !== p.id && (w.src === 'whatsapp' || w.src === 'site') && w.dupOf === o.id));
      if (twinRow) { p.second = true; fixes.push([p, twinRow]); }
    }
    if (!fixes.length) continue;
    console.log(`== ${a.data().name || a.id}: ${fixes.length}`);
    for (const [p, o] of fixes) console.log(`  ${p.second ? '2nd ' : '    '}${p.date} ${amt(p)} "${String(p.description).slice(0, 50)}"  →  ${amt(o)} "${String(o.description).slice(0, 50)}" (${o.src} ${o.ref || ''})`);
    total += fixes.length;
    if (WRITE) {
      const b = db.batch();
      for (const [p, o] of fixes) b.set(a.ref.collection('tx').doc(p.id), { dupOf: o.id, excluded: true, review: false, dupSrc: 'auto', twinFix: '2026-10-06', ...(p.second ? { secondReport: true } : {}) }, { merge: true });
      await b.commit();
    }
  }
  console.log(WRITE ? `written: ${total}` : `dry run: ${total} would be linked`);
  process.exit(0);
})();
