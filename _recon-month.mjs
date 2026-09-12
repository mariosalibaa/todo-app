// One month, side by side: what the sheet says the worker spent and received, against what
// Odoo carries for him — the month's LABOUR / EXPENSES bills, the vendor settlements, the
// payments — so a drift lands on a bucket instead of on a 3000-line list. (Mario, 2026-09-08)
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const WHO = arg("worker", "khoder"), MONTH = arg("month", "2026-08");
const W = { ziad: { acct: "ziad-cash", partner: 41 }, abed: { acct: "abed-cash", partner: 366 },
            khoder: { acct: "khodr-cash", partner: 299 }, mitri: { acct: "mitri-cash", partner: 388 } }[WHO];
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ctx = { allowed_company_ids: [2, 7, 10, 8, 9, 4] };
const snap = await db.collection(`workspaces/team/accounts/${W.acct}/tx`).get();
const H = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.excluded && t.date.slice(0, 7) === MONTH);
const L = await call("account.move.line", "search_read", [[["partner_id", "=", W.partner], ["parent_state", "=", "posted"],
  ["account_id.account_type", "in", ["liability_payable", "asset_receivable"]], ["date", ">=", MONTH + "-01"], ["date", "<=", MONTH + "-31"]]],
  { fields: ["date", "balance", "move_name", "name"], context: ctx, order: "date" });

const r2 = n => +n.toFixed(2);
const hub = { labour: 0, expense: 0, vendor: 0, refund: 0, transfer: 0, other: 0 };
H.forEach(t => { const k = hub[t.nature] !== undefined ? t.nature : "other"; hub[k] += (t.credit || 0) - (t.debit || 0); });
const odoo = { labour: 0, expense: 0, vendor: 0, refund: 0, transfer: 0, other: 0 };
for (const l of L) {
  const n = (l.move_name || "") + " " + (l.name || "");
  const k = /LABOUR/.test(n) ? "labour" : /EXPENSES/.test(n) ? "expense"
    : /^TRANS/.test(l.move_name) ? (l.balance > 0 ? "refund" : "vendor")
    : /^PCSH|^CSH/.test(l.move_name) ? "transfer" : "other";
  odoo[k] += l.balance;
}
console.log(`${WHO} ${MONTH}`);
console.log("bucket      sheet/hub      odoo       diff");
let dh = 0, dodoo = 0;
for (const k of Object.keys(hub)) {
  dh += hub[k]; dodoo += odoo[k];
  console.log(k.padEnd(10), r2(hub[k]).toFixed(2).padStart(10), r2(odoo[k]).toFixed(2).padStart(10), r2(odoo[k] - hub[k]).toFixed(2).padStart(10));
}
console.log("TOTAL".padEnd(10), r2(dh).toFixed(2).padStart(10), r2(dodoo).toFixed(2).padStart(10), r2(dodoo - dh).toFixed(2).padStart(10));
console.log("\nhub rows:");
H.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => console.log(`  ${t.date} ${(t.nature || "?").padEnd(8)} ${String(r2((t.credit || 0) - (t.debit || 0))).padStart(9)}  ${(t.description || "").slice(0, 60)}`));
console.log("\nodoo lines:");
L.forEach(l => console.log(`  ${l.date} ${l.balance.toFixed(2).padStart(9)}  ${l.move_name} · ${(l.name || "").slice(0, 60)}`));
process.exit(0);
