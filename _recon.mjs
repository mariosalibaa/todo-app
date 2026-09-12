// Where a worker's Odoo partner balance and his hub/Excel ledger drift apart.
//   node _recon.mjs --worker khoder [--upto 2026-09-01] [--tol 1.5]
// Matches hub rows to Odoo partner lines on amount (exact first, then within tolerance,
// nearest date), and prints what is left over on each side — that leftover is the drift.
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const WHO = arg("worker", "khoder");
const UPTO = arg("upto", "2026-09-01");
const TOL = +arg("tol", 1.5);            // the sheet rounds to the dollar; 1.5 covers that
const W = { ziad: { acct: "ziad-cash", partner: 41 }, abed: { acct: "abed-cash", partner: 366 },
            khoder: { acct: "khodr-cash", partner: 299 }, mitri: { acct: "mitri-cash", partner: 388 } }[WHO];
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ctx = { allowed_company_ids: [2, 7, 10, 8, 9, 4] };

const snap = await db.collection(`workspaces/team/accounts/${W.acct}/tx`).get();
const H = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.excluded && t.date <= UPTO)
  .map(t => ({ date: t.date, amt: +(((t.credit || 0) - (t.debit || 0)).toFixed(2)), desc: (t.description || t.ref || "").slice(0, 45), src: t.src }));
const L = await call("account.move.line", "search_read", [[["partner_id", "=", W.partner], ["parent_state", "=", "posted"],
  ["account_id.account_type", "in", ["liability_payable", "asset_receivable"]], ["date", "<=", UPTO]]],
  { fields: ["date", "balance", "move_name", "name", "company_id"], context: ctx });
const O = L.map(l => ({ date: l.date, amt: +l.balance.toFixed(2), desc: (l.move_name + " · " + (l.name || "")).slice(0, 70), co: l.company_id[1] }));

const sum = a => a.reduce((s, x) => s + x.amt, 0);
console.log(`${WHO}: hub ${sum(H).toFixed(2)}   odoo ${sum(O).toFixed(2)}   drift ${(sum(O) - sum(H)).toFixed(2)}   (hub ${H.length} rows, odoo ${O.length} lines)`);

const used = new Array(O.length).fill(false);
const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
const take = (h, tol) => {
  let best = -1, bestD = 1e9;
  for (let i = 0; i < O.length; i++) {
    if (used[i]) continue;
    if (Math.abs(O[i].amt - h.amt) > tol) continue;
    if (h.amt * O[i].amt < 0) continue;                    // never pair a debit with a credit
    const d = days(O[i].date, h.date); if (d > 45) continue;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  used[best] = true; return O[best];
};
const leftH = [], rounding = [];
for (const h of H.filter(x => x.amt)) { const m = take(h, 0.005); if (m) continue; leftH.push(h); }
for (const h of [...leftH]) {                                // second pass: the sheet's rounding
  const m = take(h, TOL);
  if (m) { rounding.push({ h, m, diff: +(m.amt - h.amt).toFixed(2) }); leftH.splice(leftH.indexOf(h), 1); }
}
const leftO = O.filter((o, i) => !used[i] && o.amt);
console.log(`rounded pairs: ${rounding.length}, they account for ${rounding.reduce((s, r) => s + r.diff, 0).toFixed(2)}`);
console.log(`left on hub only: ${leftH.length}, sum ${sum(leftH).toFixed(2)}`);
leftH.sort((a, b) => a.date.localeCompare(b.date)).forEach(h => console.log(`   HUB  ${h.date} ${String(h.amt).padStart(9)}  ${h.desc}`));
console.log(`left in Odoo only: ${leftO.length}, sum ${sum(leftO).toFixed(2)}`);
leftO.sort((a, b) => a.date.localeCompare(b.date)).forEach(o => console.log(`   ODOO ${o.date} ${String(o.amt).padStart(9)}  ${o.co} ${o.desc}`));
console.log(`check: rounding ${rounding.reduce((s, r) => s + r.diff, 0).toFixed(2)} + odooOnly ${sum(leftO).toFixed(2)} - hubOnly ${sum(leftH).toFixed(2)} = ${(rounding.reduce((s, r) => s + r.diff, 0) + sum(leftO) - sum(leftH)).toFixed(2)}`);
if (process.argv.includes("--rounding")) rounding.filter(r => Math.abs(r.diff) > 0.02).sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff)).slice(0, 30)
  .forEach(r => console.log(`   ROUND ${r.h.date} hub ${r.h.amt} vs odoo ${r.m.amt} (${r.diff > 0 ? "+" : ""}${r.diff})  ${r.h.desc}  |  ${r.m.desc}`));
process.exit(0);
