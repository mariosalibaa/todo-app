// Audit (Mario, 2026-09-21): "200$ from mario" = money received from Mario's cash, no project.
// Lists every worker-ledger credit line naming Mario (or another of our people) that is NOT
// booked that way: a project/analytic set, or the cash account missing / wrong. Read-only.
import admin from "firebase-admin";
import { readFileSync, writeFileSync } from "node:fs";
const sa = JSON.parse(readFileSync("./firebase-service-account.json", "utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const PEOPLE = { mario: 'mario-cash', abed: 'abed-cash', georges: 'georges-cash', ziad: 'ziad-cash', mitri: 'mitri-cash', khodr: 'khodr-cash', khoder: 'khodr-cash' };
const NAME = { mario: /\bmario\b|ماريو/i, abed: /\babed\b|\babdo\b|عبد/i, georges: /\bgeorges?\b|جورج/i, ziad: /\bziad\b|زياد/i, mitri: /\bmitri\b|متري|مطري/i, khodr: /\bkh[ou]d[eo]?r\b|\bkhudr\b|خضر/i };
const accs = await db.collection("workspaces/team/accounts").get();
const rows = [];
for (const a of accs.docs) {
  const acc = a.data(); const owner = String(acc.owner || '').toLowerCase();
  if (!owner || owner === 'mario' || !PEOPLE[owner]) continue;   // workers' ledgers only
  const snap = await db.collection(`workspaces/team/accounts/${a.id}/tx`).get();
  snap.forEach(d => {
    const t = d.data();
    if (!(+t.credit > 0) || t.excluded) return;
    const text = `${t.partnerName || ''} ${t.partnerRaw || ''} ${t.description || ''}`;
    let who = '';
    for (const k of Object.keys(NAME)) if (NAME[k].test(text) && PEOPLE[k] !== PEOPLE[owner]) { who = k; break; }
    if (!who && /\bfrom\b|من/i.test(text) && !/attal|tchag|solaris|khoury|kbm|khc|njk|simon|narinco|medco|ayoub|karam|mrad|fahed|refund|return/i.test(text)) who = 'mario';   // "from" nobody = from Mario
    if (!who) return;
    const want = PEOPLE[who];
    const hasProject = !!(t.project && String(t.project).trim() && String(t.project).trim() !== '-') || !!(t.analytic && t.analytic.id) || (Array.isArray(t.analyticSplit) && t.analyticSplit.length);
    const cashOk = t.cashAccountId === want && t.nature === 'transfer';
    if (!hasProject && cashOk) return;
    rows.push({ account: a.id, owner, txId: d.id, date: t.date, src: t.src, credit: +t.credit, text: text.trim().replace(/\s+/g, ' ').slice(0, 60),
      project: t.project || (t.analytic && t.analytic.name) || '', nature: t.nature || '', cashAccountId: t.cashAccountId || '', want, fix: [hasProject ? 'project → -' : '', !cashOk ? `cash → ${want}, nature → transfer` : ''].filter(Boolean).join('; ') });
  });
}
rows.sort((x, y) => x.owner.localeCompare(y.owner) || String(x.date).localeCompare(String(y.date)));
writeFileSync('_from-mario-audit.json', JSON.stringify(rows, null, 1));
console.log(rows.length, 'rows');
for (const r of rows) console.log([r.owner, r.date, r.credit, r.text, r.project, r.nature, r.cashAccountId, r.fix].join(' | '));
process.exit(0);
