// One-time import of the old local JSON data files into the shared
// Firestore workspace ('team'). Safe to re-run: it upserts by id.
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const keyFile = process.env.FIREBASE_KEY_FILE || 'firebase-service-account.json';
const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, keyFile), 'utf8'));
console.log('Using key file:', keyFile, '| key id:', serviceAccount.private_key_id.slice(0, 8));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();

const TEAM_ID = 'team';

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

async function main() {
  const ws = db.collection('workspaces').doc(TEAM_ID);

  const wsDoc = await ws.get();
  if (!wsDoc.exists) {
    await ws.set({
      id: TEAM_ID,
      name: 'Shift Team',
      type: 'shared',
      createdAt: new Date().toISOString(),
      members: []
    });
    console.log('Created workspace "team"');
  }

  const batch = db.batch();
  let count = 0;

  for (const task of readJson('tasks.json')) {
    batch.set(ws.collection('tasks').doc(task.id), { ...task, workspaceId: TEAM_ID });
    count++;
  }

  for (const [name, data] of Object.entries(readJson('projects.json'))) {
    batch.set(ws.collection('projects').doc(name), { name, ...data });
    count++;
  }

  for (const col of ['users', 'departments', 'companies', 'statuses', 'priorities', 'changelog']) {
    for (const item of readJson(col + '.json')) {
      const id = item.id || ws.collection(col).doc().id;
      batch.set(ws.collection(col).doc(id), { ...item, id });
      count++;
    }
  }

  await batch.commit();
  console.log(`Imported ${count} documents into workspaces/${TEAM_ID}`);

  const tasksSnap = await ws.collection('tasks').get();
  console.log(`Tasks now in Firestore: ${tasksSnap.size}`);
  tasksSnap.docs.forEach(d => console.log(' -', d.data().title, '/', d.data().project));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
