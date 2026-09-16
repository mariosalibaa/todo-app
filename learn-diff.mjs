// Learn from Mario — step 1 (deterministic): what did he change on worker lines since the last run?
//
// Every account line keeps a change log ({ at, who, txId, line, before, after }). The nightly
// WhatsApp read and the hub's auto-suggestions PROPOSE (partner, analytic, company, kind, car…);
// Mario ✓s, edits or rejects. The gap between what was proposed and what he set is the training
// signal (Warp's "Buzz" loop). This script only collects that gap into a readable digest —
// judgement (turning corrections into principles for the skill) is step 2, learn-nightly.mjs.
//
//   node learn-diff.mjs                  corrections since learn/state.json (first run: since 2026-09-08, the log's birthday)
//   node learn-diff.mjs --since 2026-09-10
//   node learn-diff.mjs --dry-run        print, do not move the cursor
// Output: learn/corrections-<local date>.md, learn/state.json { since }. Prints the count on the last line.
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const DIR = path.join(HERE, 'learn');
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, 'state.json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const SINCE = arg('since', state.since || '2026-09-08T00:00:00.000Z');
const localDay = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(path.join(HERE, 'firebase-service-account.json'), 'utf8'))) });
const db = admin.firestore();
const ws = db.collection('workspaces').doc('team');

// the people whose ledgers the statement round reconciles
const WORKERS = ['georges-cash', 'abed-cash', 'khodr-cash', 'ziad-cash', 'mitri-cash'];
// fields that carry a decision (what the skill can learn from); bookkeeping fields are noise
const LEARN = ['partnerId', 'partnerName', 'analyticId', 'analyticName', 'analyticSplit', 'company', 'kind', 'nature', 'car',
  'excluded', 'dupOf', 'review', 'waAccepted', 'debit', 'credit', 'xlAmount', 'date', 'description', 'note', 'paidBy', 'noBook', 'pendingExcel', 'transferId', 'answer'];
const isHuman = who => /@/.test(String(who || '')) && !/^(local|deadlink|company)/.test(String(who || ''));

const fmt = v => v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

(async () => {
  const out = [];
  let total = 0;
  const byField = {};
  for (const id of WORKERS) {
    const acc = ws.collection('accounts').doc(id);
    const meta = (await acc.get()).data() || {};
    const log = await acc.collection('log').where('at', '>', SINCE).orderBy('at', 'asc').get();
    const perTx = new Map();
    for (const e of log.docs) {
      const d = e.data();
      if (!isHuman(d.who) || d.undo) continue;
      const keys = Object.keys(d.after || {}).filter(k => LEARN.includes(k));
      if (!keys.length) continue;
      const cur = perTx.get(d.txId) || { txId: d.txId, line: d.line, edits: [], first: d.at };
      for (const k of keys) cur.edits.push({ at: d.at, k, from: d.before ? d.before[k] : undefined, to: d.after[k] });
      perTx.set(d.txId, cur);
    }
    if (!perTx.size) continue;
    out.push(`\n## ${meta.name || id} — ${perTx.size} line(s) touched\n`);
    for (const t of perTx.values()) {
      let tx = {};
      try { tx = (await acc.collection('tx').doc(String(t.txId)).get()).data() || {}; } catch {}
      const amt = tx.debit ? `−${tx.debit}` : tx.credit ? `+${tx.credit}` : '';
      const src = tx.src || '?';
      const wa = tx.waFrom ? ` · WhatsApp from ${tx.waFrom}${tx.waAt ? ' ' + String(tx.waAt).slice(0, 16) : ''}` : '';
      out.push(`### ${tx.date || ''} · ${(tx.description || t.line || '').slice(0, 90)} ${amt ? `(${amt} $)` : ''}`);
      out.push(`src: ${src}${wa} · tx ${t.txId}`);
      if (tx.waText) out.push(`> ${String(tx.waText).replace(/\s+/g, ' ').slice(0, 240)}`);
      // collapse a field's edits to first→last
      const seq = {};
      for (const e of t.edits) { if (!seq[e.k]) seq[e.k] = { from: e.from, to: e.to }; else seq[e.k].to = e.to; }
      for (const [k, v] of Object.entries(seq)) {
        const norm = x => (x === undefined || x === null || x === '') ? null : x;   // null, missing and '' are the same 'unset'
        if (JSON.stringify(norm(v.from)) === JSON.stringify(norm(v.to))) continue;
        total++;
        byField[k] = (byField[k] || 0) + 1;
        const tag = k === 'waAccepted' && v.to === false ? ' ← REJECTED proposal' : k === 'excluded' && v.to === true ? ' ← excluded' : '';
        out.push(`- **${k}**: ${fmt(v.from)} → ${fmt(v.to)}${tag}`);
      }
      out.push('');
    }
  }
  const head = [`# Corrections by Mario on worker lines — since ${SINCE.slice(0, 10)} (run ${localDay})`, '',
    `${total} field change(s) on the five worker ledgers. Fields: ${Object.entries(byField).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ') || '—'}.`,
    '', 'Read each line as: what the hub or the nightly read proposed → what Mario set. Look for the *reason* behind a group of edits, not the edit itself.'];
  const file = path.join(DIR, `corrections-${localDay}.md`);
  const text = head.concat(out).join('\n') + '\n';
  if (!DRY) {
    fs.writeFileSync(file, text);
    fs.writeFileSync(STATE, JSON.stringify({ since: new Date().toISOString(), lastRun: localDay, lastCount: total, lastFile: path.basename(file) }, null, 2));
  } else console.log(text);
  console.log(`corrections=${total} file=${path.relative(HERE, file)}`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
