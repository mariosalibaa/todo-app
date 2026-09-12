import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
for (const id of ['YFULlVTv2i5KcQL65DXc', 'r6d4wTtODAu89Noo96zf']) {
  await db.doc('workspaces/team/whishRules/' + id).update({ book: 'payment', analyticId: 69, analyticName: 'Ajaltoun 4193', updatedAt: new Date().toISOString(), updatedBy: 'claude (Mario 2026-09-13: payment mode, project 4193)' });
  console.log('rule', id, (await db.doc('workspaces/team/whishRules/' + id).get()).data().label, '→ book: payment');
}
