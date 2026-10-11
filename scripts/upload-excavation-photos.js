// Upload public/excavation/** to Firebase Storage (excavation/<folder>/<file>) so the photos stay out of the
// Vercel function bundle (449 MB made every deploy 453 MB and filled the free 10 GB Function Storage, 2026-10-11).
// machines.js serves the local file when it exists (dev) and otherwise streams it from the bucket.
// Re-run after adding photos: files already in the bucket are skipped.  node scripts/upload-excavation-photos.js
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const sa = require(path.join(__dirname, '..', 'firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: process.env.STORAGE_BUCKET || (sa.project_id + '.firebasestorage.app') });
const bucket = admin.storage().bucket();
const ROOT = path.join(__dirname, '..', 'public', 'excavation');

(async () => {
  const [existing] = await bucket.getFiles({ prefix: 'excavation/' });
  const have = new Set(existing.map(f => f.name));
  const todo = [];
  for (const dir of fs.readdirSync(ROOT)) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const name = `excavation/${dir}/${f}`;
      if (!have.has(name)) todo.push([path.join(ROOT, dir, f), name]);
    }
  }
  console.log(`${have.size} already in bucket, ${todo.length} to upload`);
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const [src, dest] = todo.shift();
      for (let i = 0; ; i++) {
        try { await bucket.upload(src, { destination: dest, resumable: false, metadata: { contentType: 'image/jpeg', cacheControl: 'private, max-age=86400' } }); break; }
        catch (e) { if (i >= 2) { console.error('FAILED', dest, e.message); break; } }
      }
      if (++done % 200 === 0) console.log(done);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log('done', done);
})();
