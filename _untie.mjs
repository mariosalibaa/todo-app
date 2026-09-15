import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ref = db.doc('workspaces/team/whishAccounts/20222279/tx/595445972');
const t = (await ref.get()).data();
console.log(JSON.stringify({ date: t.date, debit: t.debit, phone: t.phone, partnerName: t.partnerName, analyticName: t.analyticName, analyticSrc: t.analyticSrc, odoo: t.odoo }, null, 1).slice(0, 2500));
