// One-off: align project statuses with the agreed list:
// Lead, In Progress (renamed from Active), On Hold, Done, Lost (new)
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, 'firebase-service-account.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();

async function main() {
  const col = db.collection('workspaces').doc('team').collection('statuses');
  await col.doc('active').set({ id: 'active', name: 'In Progress', color: '#a6e3a1' });
  await col.doc('lost').set({ id: 'lost', name: 'Lost', color: '#f38ba8' });
  const snap = await col.get();
  snap.docs.forEach(d => console.log(d.data().id, '→', d.data().name, d.data().color));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
