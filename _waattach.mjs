// The paper behind the worker rows: every photo the four accounting groups carry goes into Odoo
// as an attachment on that worker's supplier record, then onto the rows of the day it was sent —
// and onto the document itself when the day points at exactly one. Scans already on a bill stay
// where they are: a camera photo is added beside them, never instead of them (Mario, 2026-09-08).
import admin from "firebase-admin";
import { readFileSync, existsSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";

const COMMIT = process.argv.includes("--commit");
const ONLY = (process.argv.indexOf("--worker") > -1) ? process.argv[process.argv.indexOf("--worker") + 1] : null;
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();

const W = {
  ziad:   { acct: "ziad-cash",   partner: 41,  co: 7, label: "ziad" },
  abed:   { acct: "abed-cash",   partner: 366, co: 7, label: "abed" },
  khoder: { acct: "khodr-cash",  partner: 299, co: 7, label: "khodr" },
  mitri:  { acct: "mitri-cash",  partner: 388, co: 7, label: "mitri" },
};
const ctxOf = co => ({ allowed_company_ids: [co], company_id: co });
const idx = JSON.parse(readFileSync("D:/vscode/wa-photos/index.json", "utf8"));
const moveOf = t => {
  if (t.bookedMove && t.bookedMove.id) return { id: t.bookedMove.id, name: t.bookedMove.name || t.bookedMove.ref, ref: (t.bookedMove.ref || "") };
  const m = ((t.odoo || {}).matches || []).find(x => x.chosen);
  if (m && m.moveId) return { id: m.moveId, name: m.move, ref: m.odooRef || "" };
  return null;
};
const isMonthBill = mv => mv && /-(LABOUR|EXPENSES)$/.test(mv.ref || "");

const report = { uploaded: 0, reused: 0, rowsTouched: 0, movedOnto: {}, perWorker: {} };

for (const [who, w] of Object.entries(W)) {
  if (ONLY && who !== ONLY) continue;
  const photos = idx.filter(p => p.who === who);
  if (!photos.length) continue;
  const col = db.collection(`workspaces/team/accounts/${w.acct}/tx`);
  const snap = await col.get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => (t.src === "excel" || t.src === "whatsapp") && !t.excluded);
  const byDate = {};
  rows.forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });

  // what is already on this partner, so a re-run adds nothing twice
  const have = await call("ir.attachment", "search_read", [[["res_model", "=", "res.partner"], ["res_id", "=", w.partner], ["name", "like", "wa "]]],
    { fields: ["id", "name"], context: ctxOf(w.co) });
  const byName = Object.fromEntries(have.map(a => [a.name, a.id]));

  const days = {};
  photos.forEach(p => { (days[p.date] = days[p.date] || []).push(p); });
  const perDay = [];
  for (const date of Object.keys(days).sort()) {
    const dayRows = byDate[date] || [];
    const spend = dayRows.filter(t => (t.debit || 0) > 0 && t.nature !== "transfer");
    const targets = [...new Map(spend.map(t => [moveOf(t) && moveOf(t).id, moveOf(t)]).filter(([k]) => k)).values()].filter(mv => !isMonthBill(mv));
    const files = [];
    for (const p of days[date]) {
      const name = `wa ${w.label} ${p.date} ${p.time.replace(":", "h")}${p.fromMe ? " (mario)" : ""} ${p.id.slice(0, 6)}.jpg`;
      let aid = byName[name];
      if (aid) report.reused++;
      else if (COMMIT) {
        const path = "D:/vscode/wa-photos/" + p.file;
        if (!existsSync(path)) continue;
        aid = await call("ir.attachment", "create", [{
          name, res_model: "res.partner", res_id: w.partner, mimetype: "image/jpeg",
          datas: readFileSync(path).toString("base64"),
          description: `WhatsApp "${p.who}" group, ${p.date} ${p.time}${p.caption ? " — " + p.caption : ""}`,
        }], { context: ctxOf(w.co) });
        byName[name] = aid; report.uploaded++;
      } else { report.uploaded++; aid = 0; }
      files.push({ id: aid, name });
    }
    // The day's photos stay on the worker's record: they are the day's paper, and a day holds
    // several purchases — putting them on the one document that happens to be booked made that
    // entry claim receipts that are not its own (undone 2026-09-08, _wa-untie.mjs). The rows below
    // still point at every photo of their day; --onto-document brings the old behaviour back.
    let onto = null;
    if (process.argv.includes('--onto-document') && targets.length === 1 && files.length && COMMIT) {
      onto = targets[0];
      const ids = files.map(f => f.id).filter(Boolean);
      if (ids.length) {
        try {
          // the document may live in another company — read it there, and write in its own context
          const [mv] = await call("account.move", "read", [[onto.id], ["company_id", "name"]], { context: { allowed_company_ids: [2, 7, 8, 9, 10, 4] } });
          const mctx = ctxOf(mv.company_id[0]);
          await call("ir.attachment", "write", [ids, { res_model: "account.move", res_id: onto.id }], { context: mctx });
          await call("mail.message", "create", [{
            model: "account.move", res_id: onto.id, message_type: "comment",
            body: `${ids.length} photo${ids.length > 1 ? "s" : ""} ${w.label} sent on WhatsApp on ${date}`,
            attachment_ids: [[6, 0, ids]],
          }], { context: mctx });
          report.movedOnto[mv.name] = ids.length;
        } catch (e) {
          console.log(`   ! ${date}: could not put the photos on ${onto.name} (${String(e.message || e).slice(0, 60)}) — they stay on the worker's record`);
          onto = null;
        }
      }
    }
    // the rows of the day keep a reference to the paper, existing files first
    const touch = spend.length ? spend : dayRows;
    if (COMMIT) for (const t of touch) {
      const cur = t.fileIds || [];
      const add = files.filter(f => f.id && !cur.some(c => c.id === f.id));
      if (!add.length) continue;
      const fileIds = [...cur, ...add];
      await col.doc(t.id).set({ fileIds, files: fileIds.map(f => f.name), waPhotos: true, updatedAt: new Date().toISOString(), updatedBy: "wa-photos-2026-09-08" }, { merge: true });
      report.rowsTouched++;
    }
    perDay.push({ date, photos: files.length, rows: touch.length, target: onto ? onto.name : (targets.length ? targets.length + " documents" : "no document") });
  }
  report.perWorker[who] = { photos: photos.length, days: perDay.length,
    oneDoc: perDay.filter(d => /^BILL|^RBILL|^PCSH|^PSETT|^CSH/.test(d.target)).length,
    several: perDay.filter(d => /documents$/.test(d.target)).length,
    none: perDay.filter(d => d.target === "no document").length };
  console.log(`${who}: ${photos.length} photos over ${perDay.length} days →`, JSON.stringify(report.perWorker[who]));
  perDay.forEach(d => console.log(`   ${d.date}  ${String(d.photos).padStart(2)} photo(s) → ${d.rows} row(s), ${d.target}`));
}
console.log("\n" + (COMMIT ? "DONE" : "DRY RUN") + ":", JSON.stringify({ uploaded: report.uploaded, reused: report.reused, rowsTouched: report.rowsTouched, ontoDocuments: Object.keys(report.movedOnto).length }));
process.exit(0);
