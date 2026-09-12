// The day's WhatsApp photos are the day's paper, not one entry's receipt: pull every "wa …"
// photo off the Odoo documents it was moved onto and put it back on the worker's own record,
// where the hub rows still point at it. --commit writes; without it, a dry run (Mario, 2026-09-08).
import { call } from "../odoo/odoo.mjs";

const COMMIT = process.argv.includes("--commit");
const ctx = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const PARTNER = { ziad: 41, abed: 366, khodr: 299, mitri: 388 };

const att = await call("ir.attachment", "search_read", [[["name", "like", "wa %"], ["res_model", "=", "account.move"]]],
  { fields: ["id", "name", "res_id"], context: ctx });
const moves = [...new Set(att.map(a => a.res_id))];
const mv = Object.fromEntries((await call("account.move", "read", [moves, ["name", "company_id"]], { context: ctx })).map(m => [m.id, m]));

const byWorker = {};
for (const a of att) {
  const who = (a.name.match(/^wa (\w+) /) || [])[1];
  if (!PARTNER[who]) { console.log("! unknown worker on", a.name); continue; }
  (byWorker[who] = byWorker[who] || []).push(a);
}
for (const [who, list] of Object.entries(byWorker)) {
  console.log(`${who}: ${list.length} photo(s) off ${new Set(list.map(a => mv[a.res_id].name)).size} document(s)`);
  list.forEach(a => console.log(`   ${mv[a.res_id].name}  ←  ${a.name}`));
  if (COMMIT) await call("ir.attachment", "write", [list.map(a => a.id), { res_model: "res.partner", res_id: PARTNER[who] }], { context: ctx });
}
console.log(COMMIT ? "DONE — the photos are back on the worker records" : "DRY RUN — add --commit to write");
process.exit(0);
