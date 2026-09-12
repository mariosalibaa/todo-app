// The lines Ziad sent on WhatsApp between 1 and 3 September, which never reached the sheet.
// They land on the hub as proposals — not counted until Mario presses ✓ accept on the row —
// and the sheet and Odoo follow only after that (Mario, 2026-09-08).
// Rate: 90,000 LBP to the dollar, the rate his own 1,400,000 = 15.56 rows are written at.
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
const COMMIT = process.argv.includes("--commit");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const col = db.collection("workspaces/team/accounts/ziad-cash/tx");
const R = 90000;
const lbp = n => Math.round(n / R * 100) / 100;

const L = [
  { d: "2026-09-01", t: "16:22", key: "benzine-tacoma", desc: "benzine Tacoma — 20 $", debit: 20, nature: "expense", partner: "Benzine" },
  { d: "2026-09-02", t: "09:04", key: "transport-ketermeya-naccache", desc: "transport ketermeya (31/8) 800,000 + naccache 600,000 LBP", debit: lbp(1400000), nature: "expense", partner: "Transportation" },
  { d: "2026-09-02", t: "10:03", key: "from-mario", desc: "received from Mario — \"100$ from mario\" (WhatsApp, Mario)", credit: 100, nature: "transfer" },
  { d: "2026-09-03", t: "08:36", key: "transport-ketermeya-naccache", desc: "transport ketermeya (Wed) 800,000 + naccache (Thu) 600,000 LBP", debit: lbp(1400000), nature: "expense", partner: "Transportation" },
  { d: "2026-09-03", t: "12:31", key: "water-ajaltoun", desc: "water for the Ajaltoun site — 100,000 LBP", debit: lbp(100000), nature: "expense" },
  { d: "2026-09-03", t: "13:50", key: "jeep-milade-wash", desc: "wash, Miladé jeep — 550,000 LBP", debit: lbp(550000), nature: "expense" },
  { d: "2026-09-03", t: "13:52", key: "benzine-jeep-milade", desc: "benzine, Miladé jeep — 4,300,000 LBP", debit: lbp(4300000), nature: "expense", partner: "Benzine" },
  { d: "2026-09-03", t: "14:50", key: "supplies-sin-el-fil", desc: "supplies for the Sin el Fil site — 500,000 LBP", debit: lbp(500000), nature: "expense" },
];

const now = new Date().toISOString();
for (const x of L) {
  const id = `wa-p-${x.d}-${x.key}`;
  const row = {
    id, src: "whatsapp", date: x.d, ref: "", service: "", phone: "",
    description: x.desc, debit: x.debit || 0, credit: x.credit || 0,
    nature: x.nature, natureSrc: "whatsapp", kind: "work", kindSrc: "whatsapp",
    company: "S LB", waFrom: "ziad", waAt: `${x.d}T${x.t}:00.000Z`, waCurrency: x.debit && x.key.includes("benzine-tacoma") ? "USD" : "LBP",
    ...(x.partner ? { partnerName: x.partner, partnerSrc: "whatsapp" } : {}),
    excluded: true, review: true,          // a proposal: not counted until he presses ✓ accept
    importedAt: now, createdAt: now, createdBy: "wa-read-2026-09-08", updatedAt: now, updatedBy: "wa-read-2026-09-08",
  };
  const cur = await col.doc(id).get();
  console.log(`${cur.exists ? "exists " : "new    "} ${x.d} ${String(row.debit || -row.credit).padStart(8)}  ${x.desc.slice(0, 60)}`);
  if (COMMIT && !cur.exists) await col.doc(id).set(row);
}
console.log(COMMIT ? "written — they show on the hub as ❓ not in Excel / Odoo, waiting for ✓ accept" : "DRY RUN — add --commit");
process.exit(0);
