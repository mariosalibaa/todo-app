// Seed the procurement book with the two optical-level quotes (Mario, 2026-09-21)
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const col = db.collection('workspaces/team/procurement');
const now = new Date().toISOString(), by = 'mario.salibaa@gmail.com';
const rows = [
  { id: 'sakr-bosch-gol32d', supplier: 'Sakr LB (SAKR Building Materials)', contact: 'Rawad Sakr — WhatsApp call', item: 'Optical level', brand: 'Bosch GOL 32 D',
    price: 490, currency: 'USD', unit: 'per set',
    description: 'Quoted $490 by Rawad on a WhatsApp call, including staff (mira) 5 m or 2.5 m and tripod. Website lists the level alone at $353. 32x, IP54 dust/splash protection.',
    source: 'https://www.sakrlb.com/product/optical-level-bosch-gol-32-d/', date: '2026-09-21', project: 'general' },
  { id: 'sakr-dewalt-dw096pk', supplier: 'Sakr LB (SAKR Building Materials)', contact: 'Rawad Sakr', item: 'Optical auto level 26x', brand: 'DeWalt DW096PK-XJ',
    price: 510, currency: 'USD', unit: 'per kit',
    description: 'Website price $510 (Google ad, 2026-09-21). PK kit = level + tripod + staff. 26x, 100 m range, 2 mm accuracy.',
    source: 'https://www.sakrlb.com/product/26x-optical-auto-level-dewalt-dw096pk-xj/', date: '2026-09-21', project: 'general' },
];
for (const r of rows) {
  const ref = col.doc(r.id); const cur = (await ref.get()).data();
  await ref.set({ ...r, updatedAt: now, updatedBy: by, ...(cur ? {} : { addedAt: now, addedBy: by }) }, { merge: true });
  console.log(cur ? 'updated' : 'added', r.id, r.price);
}
