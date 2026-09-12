// Plan: which WhatsApp photo goes on which document.
import admin from "firebase-admin";
import { readFileSync, writeFileSync } from "node:fs";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const media = JSON.parse(readFileSync("D:/vscode/wa-media-index.json", "utf8"));
const ACC = { ziad: "ziad-cash", abed: "abed-cash", khoder: "khodr-cash", mitri: "mitri-cash" };

const moveOf = t => {
  if (t.bookedMove && t.bookedMove.id) return { id: t.bookedMove.id, name: t.bookedMove.name || t.bookedMove.ref };
  const m = ((t.odoo || {}).matches || []).find(x => x.chosen);
  if (m && m.moveId) return { id: m.moveId, name: m.move };
  return null;
};

const plan = {};
for (const [who, acc] of Object.entries(ACC)) {
  const snap = await db.collection(`workspaces/team/accounts/${acc}/tx`).get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => (t.src === "excel" || t.src === "whatsapp") && !t.excluded);
  const byDate = {};
  rows.forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });
  const items = media[who].filter(x => x.type !== "album");
  const days = {};
  items.forEach(x => { (days[x.date] = days[x.date] || []).push(x); });
  const rep = [];
  for (const date of Object.keys(days).sort()) {
    const dayRows = byDate[date] || [];
    const spend = dayRows.filter(t => (t.debit || 0) > 0);
    const moves = [...new Map(spend.map(t => [moveOf(t) && moveOf(t).id, moveOf(t)]).filter(([k]) => k)).values()];
    const already = dayRows.reduce((n, t) => n + (t.fileIds || []).length + ((t.docs || []).length), 0);
    rep.push({ date, photos: days[date].length, rows: dayRows.length, spendRows: spend.length, moves: moves.length,
      moveNames: moves.map(m => m.name).join(", "), already,
      rowDesc: spend.map(t => `${t.description || ""} $${t.debit}`).join(" | ").slice(0, 110) });
  }
  plan[who] = { account: acc, days: rep };
  const tot = rep.reduce((a, r) => a + r.photos, 0);
  const one = rep.filter(r => r.moves === 1), many = rep.filter(r => r.moves > 1), none = rep.filter(r => r.moves === 0);
  console.log(`${who}: ${tot} photos over ${rep.length} days — one document ${one.length} days (${one.reduce((a, r) => a + r.photos, 0)} photos), several ${many.length} (${many.reduce((a, r) => a + r.photos, 0)}), none ${none.length} (${none.reduce((a, r) => a + r.photos, 0)})`);
}
writeFileSync("D:/vscode/wa-plan.json", JSON.stringify(plan, null, 1));
console.log("written D:/vscode/wa-plan.json");
process.exit(0);
