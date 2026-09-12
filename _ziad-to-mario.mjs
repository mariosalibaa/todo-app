// Twelve vendor settlements and two hand-overs to Khoder sit in Odoo against Ziad, but appear
// nowhere on his sheet — his sheet is the balance he knows about. So the money was Mario's, not
// his: move each of those lines off Ziad's payable and onto Mario's cash box in the same company
// (Mario, 2026-09-08). A posted line's account can be written directly — the clearing side stays
// reconciled. Dry run unless --commit.
import { call } from "../odoo/odoo.mjs";
const COMMIT = process.argv.includes("--commit");
const ctx = { allowed_company_ids: [2, 7, 10, 8, 9, 4] };
const MARIO_CASH = { 2: 1073, 7: 5954, 10: 8815 };     // company id → Cash Mario USD account

// Ziad's payable lines that his sheet never showed (from _ziad-gap.mjs, 2026-09-08)
const LINES = [23212, 23272, 23320, 26305, 26309, 26341, 26401, 26405, 26465, 26517, 13674, 13678];
const EXTRA = { "TRANS/2023/12/0003": 30.38, "TRANS/2024/03/0004": 17.01 };   // found by name below

const L = await call("account.move.line", "read", [LINES,
  ["id", "move_id", "date", "account_id", "partner_id", "debit", "credit", "company_id", "name", "reconciled"]], { context: ctx });
// the two oldest ones were listed by move name only
// entry names repeat across companies — pin these two to the SARL and to their exact amount
const old = await call("account.move.line", "search_read", [[["move_id.name", "in", Object.keys(EXTRA)],
  ["partner_id", "=", 41], ["company_id", "=", 2], ["credit", "in", Object.values(EXTRA)],
  ["account_id.account_type", "=", "liability_payable"]]],
  { fields: ["id", "move_id", "date", "account_id", "partner_id", "debit", "credit", "company_id", "name", "reconciled"], context: ctx });
const all = [...L, ...old.filter(o => !LINES.includes(o.id))];

let total = 0;
for (const l of all) {
  const co = l.company_id[0], acct = MARIO_CASH[co];
  const amt = l.credit - l.debit;
  total += amt;
  console.log(`${l.date}  ${String(-amt).padStart(8)}  ${l.move_id[1].slice(0, 45).padEnd(45)} ${l.company_id[1].slice(0, 12).padEnd(12)} ${l.reconciled ? "RECONCILED — skipped" : "Ziad payable → Cash Mario USD"}`);
  if (!acct) { console.log("   ! no Mario cash account for this company"); continue; }
  if (l.reconciled) continue;                       // never touch a reconciled line
  if (COMMIT) await call("account.move.line", "write", [[l.id], { account_id: acct, partner_id: false }], { context: ctx });
}
console.log(`\n${all.length} line(s), ${total.toFixed(2)} moved off Ziad — ${COMMIT ? "WRITTEN" : "DRY RUN (add --commit)"}`);
process.exit(0);
