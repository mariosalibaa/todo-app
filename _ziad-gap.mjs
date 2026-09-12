// The Ziad gap, itemised. Matches his sheet rows against his Odoo partner lines (exact amount first,
// then the sheet's rounding, then one row against the sum of two or three Odoo lines, then a wide
// date window for the big ones), and prints what is genuinely left on each side (Mario, 2026-09-08).
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";
const UPTO = "2026-09-01";
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const ctx = { allowed_company_ids: [2, 7, 10, 8, 9, 4] };
const snap = await db.collection("workspaces/team/accounts/ziad-cash/tx").get();
const H = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.excluded && t.date <= UPTO)
  .map(t => ({ date: t.date, amt: +(((t.credit || 0) - (t.debit || 0)).toFixed(2)), desc: (t.description || t.ref || "").slice(0, 45) })).filter(x => x.amt);
const L = await call("account.move.line", "search_read", [[["partner_id", "=", 41], ["parent_state", "=", "posted"],
  ["account_id.account_type", "in", ["liability_payable", "asset_receivable"]], ["date", "<=", UPTO]]],
  { fields: ["id", "date", "balance", "move_name", "name", "company_id"], context: ctx });
const O = L.map(l => ({ id: l.id, date: l.date, amt: +l.balance.toFixed(2), move: l.move_name,
  desc: (l.name || "").slice(0, 70), co: l.company_id[1] })).filter(x => x.amt);

const used = new Array(O.length).fill(false);
const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
const grab = (h, tol, win) => {                      // one Odoo line for one sheet row
  let best = -1, bd = 1e9;
  O.forEach((o, i) => {
    if (used[i] || Math.abs(o.amt - h.amt) > tol || o.amt * h.amt < 0) return;
    const d = days(o.date, h.date); if (d > win || d >= bd) return;
    bd = d; best = i;
  });
  if (best < 0) return null; used[best] = true; return [O[best]];
};
const grabSplit = (h, win) => {                      // one sheet row = two or three Odoo lines
  const near = O.map((o, i) => ({ o, i })).filter(({ o, i }) => !used[i] && o.amt * h.amt > 0 && days(o.date, h.date) <= win);
  for (let a = 0; a < near.length; a++) {
    for (let b = a + 1; b < near.length; b++) {
      if (Math.abs(near[a].o.amt + near[b].o.amt - h.amt) < 0.02) { used[near[a].i] = used[near[b].i] = true; return [near[a].o, near[b].o]; }
      for (let c = b + 1; c < near.length; c++)
        if (Math.abs(near[a].o.amt + near[b].o.amt + near[c].o.amt - h.amt) < 0.02) {
          used[near[a].i] = used[near[b].i] = used[near[c].i] = true; return [near[a].o, near[b].o, near[c].o];
        }
    }
  }
  return null;
};
const leftH = [];
for (const h of H) if (!grab(h, 0.005, 45)) leftH.push(h);
for (const h of [...leftH]) if (grab(h, 1.5, 45)) leftH.splice(leftH.indexOf(h), 1);        // the sheet rounds
for (const h of [...leftH]) if (grabSplit(h, 75)) leftH.splice(leftH.indexOf(h), 1);        // split in Odoo
for (const h of [...leftH]) if (Math.abs(h.amt) > 300 && grab(h, 1.5, 90)) leftH.splice(leftH.indexOf(h), 1);
const leftO = O.filter((o, i) => !used[i]);
const round = leftO.filter(o => /written .* in the sheet/.test(o.desc));
const real = leftO.filter(o => !/written .* in the sheet/.test(o.desc));
const s = a => a.reduce((x, y) => x + y.amt, 0);
console.log(`hub ${s(H).toFixed(2)}   odoo ${s(O).toFixed(2)}   drift ${(s(O) - s(H)).toFixed(2)}`);
console.log(`\nIN ODOO, NOT ON THE SHEET — ${real.length} entries, ${s(real).toFixed(2)}`);
real.sort((a, b) => a.date.localeCompare(b.date)).forEach(o => console.log(`  ${o.date} ${String(o.amt).padStart(9)}  ${o.move}  ${o.desc}`));
console.log(`\n(cent corrections already booked in Odoo: ${round.length}, ${s(round).toFixed(2)})`);
console.log(`\nON THE SHEET, NOT IN ODOO — ${leftH.length} rows, ${s(leftH).toFixed(2)}`);
leftH.sort((a, b) => a.date.localeCompare(b.date)).forEach(h => console.log(`  ${h.date} ${String(h.amt).padStart(9)}  ${h.desc}`));
console.log(`\ncheck: ${s(real).toFixed(2)} + ${s(round).toFixed(2)} - ${s(leftH).toFixed(2)} = ${(s(real) + s(round) - s(leftH)).toFixed(2)}`);
process.exit(0);
