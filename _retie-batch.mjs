// After fix-xl-scan-dupes: every sheet row whose S LB twin was deleted now points at the invoice
// that survived, carries its scan and its analytic, and is never booked again.
import admin from "firebase-admin";
import { readFileSync, writeFileSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";

const COMMIT = process.argv.includes("--commit");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();
const D = admin.firestore.FieldValue.delete();
const ACC = { ZIAD: "ziad-cash", KHODR: "khodr-cash", ABED: "abed-cash", MITRI: "mitri-cash", GEORGES: "georges-cash" };
const WHO = { ZIAD: "ziad", KHODR: "khodr", ABED: "abed", MITRI: "mitri", GEORGES: "georges" };
const ctxOf = co => ({ allowed_company_ids: [co], company_id: co });
const now = new Date().toISOString();

const pairs = JSON.parse(readFileSync("D:/vscode/odoo/out/xl-vs-scan-duplicates.json", "utf8"));
const seen = new Set();
let fixed = 0, missing = 0, notDone = 0;
const touched = [];
for (const p of pairs) {
  const wkey = (p.xl.ref.match(/^([A-Z]+)CASH-xl-/) || [])[1];
  const rowId = (p.xl.ref.match(/-(xl-.+)$/) || [])[1];
  if (!wkey || !rowId || seen.has(p.xl.id)) continue;
  // did the twin actually go?
  const still = await call("account.move", "search_read", [[["id", "=", p.xl.id]]], { fields: ["name"], context: ctxOf(7) });
  if (still.length) { notDone++; continue; }
  seen.add(p.xl.id);
  const co = p.scan.company === "S LB" ? 7 : 2;
  const scan = (await call("account.move", "search_read", [[["id", "=", p.scan.id]]],
    { fields: ["name", "ref", "amount_total", "invoice_date", "partner_id", "payment_state", "invoice_line_ids"], context: ctxOf(co) }))[0];
  if (!scan) { missing++; continue; }
  const lines = await call("account.move.line", "read", [scan.invoice_line_ids, ["analytic_distribution"]], { context: ctxOf(co) });
  const anId = lines.map(l => Object.keys(l.analytic_distribution || {})[0]).filter(Boolean)[0];
  let anName = "";
  if (anId) { const [a] = await call("account.analytic.account", "read", [[+anId], ["name"]], { context: ctxOf(co) }); anName = a ? a.name : ""; }
  const att = await call("ir.attachment", "search_read", [[["res_model", "=", "account.move"], ["res_id", "=", scan.id]]], { fields: ["id", "name"], context: ctxOf(co) });

  const ref = db.doc(`workspaces/team/accounts/${ACC[wkey]}/tx/${rowId}`);
  const cur = (await ref.get()).data();
  if (!cur) { missing++; continue; }
  const files = [...(cur.fileIds || [])];
  att.forEach(a => { if (!files.some(f => f.id === a.id)) files.push({ id: a.id, name: a.name }); });
  const data = {
    bookedMove: D, noBook: true,
    noBookNote: `Same purchase as ${scan.name} (${p.scan.company}${scan.ref ? ", invoice " + scan.ref : ""}, $${scan.amount_total}). The S LB twin booked from this row was deleted 2026-09-08 and the invoice is now settled paid-by ${WHO[wkey]}.`,
    ref: scan.name, service: p.scan.company, company: p.scan.company, companySrc: "odoo",
    partnerId: scan.partner_id ? scan.partner_id[0] : null, partnerName: scan.partner_id ? scan.partner_id[1] : "", partnerSrc: "odoo",
    paidBy: WHO[wkey], paidBySrc: "odoo",
    fileIds: files, files: files.map(f => f.name),
    updatedAt: now, updatedBy: "xl-scan-dupes-2026-09-08",
  };
  if (anId) Object.assign(data, { analyticId: +anId, analyticName: anName, analyticSrc: "odoo", analyticFrom: scan.name });
  if (COMMIT) await ref.set(data, { merge: true });
  touched.push({ acct: ACC[wkey], rowId, ref: scan.name, amount: scan.amount_total, files: files.length, analytic: anName });
  fixed++;
}
writeFileSync("D:/vscode/odoo/out/xl-scan-rows.json", JSON.stringify(touched, null, 1));
console.log(`${COMMIT ? "re-tied" : "would re-tie"} ${fixed} rows | twin still there ${notDone} | row or invoice missing ${missing}`);
const per = {};
touched.forEach(t => per[t.acct] = (per[t.acct] || 0) + 1);
console.log(JSON.stringify(per));
process.exit(0);
