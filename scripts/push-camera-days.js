// Push the Tapo day report to the hub (Mario 2026-10-12): Firestore workspaces/<team>/cameraDays/<date> + the event
// photos to Firebase Storage excavation/camdays/. Read by /api/ajaltoun/machines/daily (Ajaltoun → Cameras → Day report).
// Called by D:\vscode\phone-sync\tapo_sync.py after every plug-in run; no deploy needed.
//   node scripts/push-camera-days.js <days.json> <photos dir>
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const sa = require(path.join(__dirname, '..', 'firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: process.env.STORAGE_BUCKET || (sa.project_id + '.firebasestorage.app') });
const TEAM_ID = process.env.TEAM_ID || 'team';

(async () => {
  const [file, photos] = process.argv.slice(2);
  const days = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bucket = admin.storage().bucket();
  const [existing] = await bucket.getFiles({ prefix: 'excavation/camdays/' });
  const have = new Set(existing.map(f => f.name));
  const todo = fs.readdirSync(photos).filter(f => f.endsWith('.jpg') && !have.has('excavation/camdays/' + f));
  let up = 0;
  const worker = async () => {
    while (todo.length) {
      const f = todo.shift();
      try {
        await bucket.upload(path.join(photos, f), { destination: 'excavation/camdays/' + f, resumable: false,
          metadata: { contentType: 'image/jpeg', cacheControl: 'private, max-age=86400' } });
        up++;
      } catch (e) { console.error('upload failed', f, e.message); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const col = admin.firestore().collection('workspaces').doc(TEAM_ID).collection('cameraDays');
  const batch = admin.firestore().batch();
  for (const d of days) batch.set(col.doc(d.date), d);
  await batch.commit();
  console.log(`hub: ${days.length} days, ${up} photos uploaded`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
