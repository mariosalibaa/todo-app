// Bonvin (Sin El Fil 2292 / A5) — keep the hub's /bonvin page equal to the Dropbox folder.
//   node bonvin-sync.mjs            sync (add / replace changed / remove deleted)
//   node bonvin-sync.mjs --dry      show what would change
//
// Reads the whole folder, every subfolder, except the quarantine names (inutile / old / z. …)
// and CAD backups/logs. Originals go to the Storage bucket (bonvin/<id>/<name>), photos also get
// a 1600 px JPEG preview (Pillow, via python) so the page never pulls a 6 MB photo for a thumbnail.
// The dossier text (bonvin-data.json, git-ignored like the files) is pushed whole to bonvinMeta/data.
import admin from 'firebase-admin';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'D:/Dropbox/0. MS/0000. sin el fil 2292 bonvin';
const DRY = process.argv.includes('--dry');
const SKIP_DIR = /^(inutile|old|z\. .*)$/i;
const SKIP_FILE = n => n.startsWith('.') || n.startsWith('~$') || /\.(bak|log|ini|tmp)$/i.test(n) || /^thumbs\.db$/i.test(n);

// Sections on the page, in order: the property papers, the drawings, then every lease folder by date
const GROUPS = [
  { name: 'Title, owners & bills', test: p => !p.includes('/') && !/paid by|bonvin plan/i.test(p) },
  { name: 'Plans & drawings', test: p => /^0\. arch\//i.test(p) || /^bonvin plan/i.test(p) },
  { name: 'Office fit-out (2021, 2026 renders)', test: p => /^SIN EL FIL 2292 BONVIN\/[^/]+$/i.test(p) },
  { name: 'Shop photos (2021)', test: p => /^SIN EL FIL 2292 BONVIN\/bonvin\//i.test(p) },
  { name: 'Shop photos (2016)', test: p => /^BONVIN PHOTOS\//i.test(p) },
  { name: 'Statement of account & payments', test: p => /statement of account|paid by mario/i.test(p) },
];
const leaseGroup = p => {   // CONTRACTS/<yyyymmdd tenant>/… → "Lease · 2013-10 Ousama Nakad"
  const m = /^CONTRACTS\/(\d{4})(\d{2})\d{2}\s*-?\s*(.*?)\//i.exec(p);
  if (!m) return null;
  const who = m[3].replace(/^(OCTOBER|MAY|JUNE|JULY)\s+\d{4}\s*-\s*/i, '').replace(/\b(bonvin|rent)\b/gi, '').replace(/\s+/g, ' ').trim();
  return { name: `Lease · ${m[1]}-${m[2]} · ${who}`, order: 100 + (+m[1] - 2000) * 12 + +m[2] };
};
// The renter's share page (/bonvin/shop, no sign-in) shows ONLY these: the plans, the 2021 shop photos, the
// office drawings and renders — what Mario sent Walid on WhatsApp 2026-10-04. Never owners, IDs, deeds or leases.
const PUBLIC = p => /^SIN EL FIL 2292 BONVIN\/.+\.(jpe?g|jfif|png)$/i.test(p) || /^BONVIN PLAN\.jpg$/i.test(p);
const MIME = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.dwg': 'application/acad', '.skp': 'application/vnd.sketchup.skp' };
const IMG = /\.(jpe?g|jfif|png)$/i;
// ASCII ids only (the route matches [\w-]): the Latin part of the path plus a hash of the whole path
const idOf = p => (p.toLowerCase().replace(/\.[a-z0-9]+$/, '').split('/').slice(-2).join('-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  + '-' + createHash('sha1').update(p).digest('hex').slice(0, 8)).replace(/^-/, '');

function walk(dir, rel = '') {
  const out = [];
  for (const n of readdirSync(dir)) {
    const full = path.join(dir, n), r = rel ? rel + '/' + n : n;
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIR.test(n)) out.push(...walk(full, r)); }
    else if (!SKIP_FILE(n)) out.push({ full, path: r, name: n, st });
  }
  return out;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bonvin-'));
function preview(full) {   // → Buffer of a ≤1600 px JPEG
  const out = path.join(tmp, 'p.jpg');
  const r = spawnSync('python', ['-c', 'import sys;from PIL import Image,ImageOps;im=ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGB");im.thumbnail((1600,1600));im.save(sys.argv[2],quality=82)', full, out]);
  if (r.status !== 0) throw new Error('preview failed for ' + full + ': ' + r.stderr);
  return readFileSync(out);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(new URL('./firebase-service-account.json', import.meta.url), 'utf8'))),
  storageBucket: 'todo-app-f5c0d.firebasestorage.app' });
const ws = admin.firestore().collection('workspaces').doc(process.env.TEAM_ID || 'team');
const col = ws.collection('bonvinFiles');
const bucket = admin.storage().bucket();

const local = walk(ROOT).map(f => {
  const lg = leaseGroup(f.path);
  const gi = GROUPS.findIndex(g => g.test(f.path));
  const group = lg ? lg.name : gi >= 0 ? GROUPS[gi].name : 'Other papers';
  const d = /(?:^|\/)(\d{8})[^/]*$/.exec(f.path);
  const order = (lg ? lg.order : gi >= 0 ? gi : 999) * 1e8 + (d ? +d[1] - 19000000 : 0);
  return { ...f, id: idOf(f.path), group, order, mime: MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream' };
});

const remote = new Map((await col.get()).docs.map(d => [d.id, d.data()]));
let changed = 0;
for (const f of local) {
  const buf = readFileSync(f.full);
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = remote.get(f.id); remote.delete(f.id);
  if (r && r.sha1 === sha1 && r.group === f.group && r.order === f.order && r.name === f.name && !!r.public === PUBLIC(f.path)) { console.log(`ok    ${f.path}`); continue; }
  console.log(`${r ? 'UPD  ' : 'ADD  '} ${f.path}  [${f.group}]  ${(buf.length / 1024).toFixed(0)} KB`);
  changed++;
  if (DRY) continue;
  const key = `bonvin/${f.id}/${f.name}`;
  if (!r || r.sha1 !== sha1) await bucket.file(key).save(buf, { contentType: f.mime, resumable: buf.length > 5e6 });
  let previewKey = r && r.sha1 === sha1 ? r.previewKey || null : null;
  if (IMG.test(f.name) && !previewKey) { previewKey = `bonvin/${f.id}/preview.jpg`; await bucket.file(previewKey).save(preview(f.full), { contentType: 'image/jpeg', resumable: false }); }
  await col.doc(f.id).set({ id: f.id, name: f.name, path: f.path, group: f.group, order: f.order, mime: f.mime, size: buf.length, sha1,
    mtime: f.st.mtime.toISOString(), key, previewKey, public: PUBLIC(f.path), updatedAt: new Date().toISOString(), updatedBy: 'bonvin-sync' });
}
for (const [id, r] of remote) {   // on the hub but no longer in the folder → off the hub
  console.log(`DEL   ${r.path}`); changed++;
  if (DRY) continue;
  await bucket.file(r.key).delete({ ignoreNotFound: true });
  if (r.previewKey) await bucket.file(r.previewKey).delete({ ignoreNotFound: true });
  await col.doc(id).delete();
}
// The dossier text — kept next to this script (git-ignored) and pushed whole
const data = readFileSync(new URL('./bonvin-data.json', import.meta.url), 'utf8');
JSON.parse(data);   // refuse to push a broken file
const meta = ws.collection('bonvinMeta').doc('data');
const cur = (await meta.get()).data();
if (cur && cur.json === data) console.log('ok    dossier');
else { console.log('UPD   dossier'); changed++; if (!DRY) await meta.set({ json: data, updatedAt: new Date().toISOString(), updatedBy: 'bonvin-sync' }); }
console.log(`${DRY ? 'would change' : 'changed'} ${changed} item(s); ${local.length} file(s) on the hub`);
process.exit(0);
