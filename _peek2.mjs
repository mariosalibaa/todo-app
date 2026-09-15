import admin from "firebase-admin";
import { readFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
for (const id of ['571164009','567119154','568082106','560832877','551249072','577128646']) {
  const t = (await db.doc('workspaces/team/whishAccounts/20222279/tx/'+id).get()).data();
  console.log(id, t.date, t.debit, 'bookWanted', !!t.bookWanted, 'booked', t.booked && t.booked.move, 'bookedMove', t.bookedMove && t.bookedMove.name, 'matches', (t.odoo&&t.odoo.matches||[]).map(m=>(m.chosen?'*':'')+m.move+'('+m.amount+','+m.date+',s'+m.score+')').join(' '));
}
