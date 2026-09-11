// Partners app — keep the hub's documents equal to the Dropbox folder.
//   node partners-sync.mjs            sync (add / replace changed / remove deleted)
//   node partners-sync.mjs --dry      show what would change
//
// Reads the TOP LEVEL of the agreement folder only. Subfolders are never read: `not on hub`
// is where Mario keeps the drafts, IDs and spreadsheets that must stay off the hub, and the
// quarantine names (inutile / old / z. do not use) never ship anywhere. Writes straight to
// Firestore with the service account, the same way the other laptop scripts do.
import admin from 'firebase-admin';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const FOLDER = 'D:/Dropbox/0. SHIFT/00. DEVELOPMENT/AJALTOUN 4193/0. CLIENTS/D3 mario-antoine char agreement';
const DRY = process.argv.includes('--dry');
const MAX = 700 * 1024;   // Firestore holds one document per file; 1 MiB cap minus base64 overhead

// Which section a file sits in on the page, and the order of the sections
const GROUPS = [
  { name: 'Villa D3 agreement', test: n => /villa d3 agreement/i.test(n) },
  { name: 'Partnership & development fees', test: n => /partnership|development fee/i.test(n) },
  { name: 'Professional services', test: n => /professional services/i.test(n) },
  { name: 'History (2020)', test: n => /^20\d{6} char\+mario/i.test(n) },
  { name: 'OEA references (for reference only)', test: n => /^OEA/i.test(n) },   // Mario: references stay at the back
  { name: 'Other documents', test: () => true },
];
const MIME = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
// ASCII ids only (the route matches [\w-]): an Arabic name keeps its Latin part plus a hash of the whole name
const idOf = n => (n.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '-' + createHash('sha1').update(n).digest('hex').slice(0, 6)).replace(/^-/, '');

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(new URL('./firebase-service-account.json', import.meta.url), 'utf8'))) });
const col = admin.firestore().collection('workspaces').doc(process.env.TEAM_ID || 'team').collection('partnersFiles');

const local = readdirSync(FOLDER).filter(n => !n.startsWith('.') && !n.startsWith('~$') && statSync(path.join(FOLDER, n)).isFile())
  .sort().map(name => {
    const full = path.join(FOLDER, name);
    const buf = readFileSync(full);
    const gi = GROUPS.findIndex(g => g.test(name));
    return { id: idOf(name), name, buf, sha1: createHash('sha1').update(buf).digest('hex'), mtime: statSync(full).mtime.toISOString(),
      group: GROUPS[gi].name, order: gi * 1e8 + local_order(name), mime: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' };
  });
// inside a group: newest date prefix first, then the name
function local_order(name) { const d = /^(\d{8})/.exec(name); return d ? 99999999 - +d[1] : 0; }

const remote = new Map((await col.get()).docs.map(d => [d.id, d.data()]));
let changed = 0;
for (const f of local) {
  if (f.buf.length > MAX) { console.log(`SKIP  ${f.name} — ${(f.buf.length / 1024).toFixed(0)} KB is over the ${MAX / 1024} KB Firestore limit`); continue; }
  const r = remote.get(f.id); remote.delete(f.id);
  const same = r && r.sha1 === f.sha1 && r.group === f.group && r.order === f.order && r.name === f.name;
  if (same) { console.log(`ok    ${f.name}`); continue; }
  console.log(`${r ? 'UPD  ' : 'ADD  '} ${f.name}  [${f.group}]  ${(f.buf.length / 1024).toFixed(0)} KB`);
  changed++;
  if (!DRY) await col.doc(f.id).set({ id: f.id, name: f.name, group: f.group, order: f.order, mime: f.mime, size: f.buf.length, sha1: f.sha1,
    mtime: f.mtime, b64: f.buf.toString('base64'), updatedAt: new Date().toISOString(), updatedBy: 'partners-sync' });
}
for (const [id, r] of remote) {   // on the hub but no longer in the folder → off the hub
  console.log(`DEL   ${r.name}`); changed++;
  if (!DRY) await col.doc(id).delete();
}
console.log(`${DRY ? 'would change' : 'changed'} ${changed} file(s); ${local.length} on the hub`);
process.exit(0);
