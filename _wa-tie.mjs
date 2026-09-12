// Tie each WhatsApp photo to the line it actually belongs to — the amount on the paper against the
// amount on the row, the shop against the description — instead of hanging the whole day's photos on
// every row of the day. What cannot be matched with confidence stays off the rows, on the worker's
// Odoo record. Reads D:/vscode/wa-photos/read.json (what Claude read on each photo, read-photos.mjs).
// Dry run by default; --commit writes the rows (Mario, 2026-09-08).
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { call } from "../odoo/odoo.mjs";

const COMMIT = process.argv.includes("--commit");
const ONLY = (process.argv.indexOf("--worker") > -1) ? process.argv[process.argv.indexOf("--worker") + 1] : null;
const VERBOSE = process.argv.includes("--all");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync("./firebase-service-account.json", "utf8"))) });
const db = admin.firestore();

const W = {
  ziad:   { acct: "ziad-cash",  partner: 41,  label: "ziad" },
  abed:   { acct: "abed-cash",  partner: 366, label: "abed" },
  khoder: { acct: "khodr-cash", partner: 299, label: "khodr" },
  mitri:  { acct: "mitri-cash", partner: 388, label: "mitri" },
};
const ctx = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const read = JSON.parse(readFileSync("D:/vscode/wa-photos/read.json", "utf8"));
const idx = JSON.parse(readFileSync("D:/vscode/wa-photos/index.json", "utf8"));
const meta = Object.fromEntries(idx.map(p => [p.id, p]));

// the attachment already in Odoo for a photo, by the name _waattach.mjs gave it
const attOf = {};
for (const w of Object.values(W)) {
  const have = await call("ir.attachment", "search_read", [[["res_id", "=", w.partner], ["name", "like", "wa %"]]],
    { fields: ["id", "name"], context: ctx });
  have.forEach(a => { attOf[a.name] = a.id; });
}
const nameOf = p => `wa ${W[p.who].label} ${p.date} ${p.time.replace(":", "h")}${p.fromMe ? " (mario)" : ""} ${p.id.slice(0, 6)}.jpg`;

const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = s => norm(s).split(" ").filter(w => w.length > 3);
// the paper says a shop; the row says what it was for — one shared word of 4+ letters is a real signal
const vendorHit = (vendor, row) => {
  const v = words(vendor); if (!v.length) return false;
  const hay = norm([row.description, row.partnerName, row.partnerText, row.note, row.ref].filter(Boolean).join(" "));
  return v.some(w => hay.includes(w));
};

const PAPER = new Set(["receipt", "invoice", "payment_proof", "document"]);
const report = { tied: 0, loose: 0, skipped: 0, rows: 0, perWorker: {} };

for (const [who, w] of Object.entries(W)) {
  if (ONLY && who !== ONLY) continue;
  const col = db.collection(`workspaces/team/accounts/${w.acct}/tx`);
  const snap = await col.get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => (t.src === "excel" || t.src === "whatsapp" || t.src === "manual") && !t.excluded);
  const photos = Object.entries(read).filter(([, r]) => r.who === who && !r.error);
  const ties = {};            // rowId → [photo names]
  const per = { paper: 0, tied: 0, loose: 0, context: 0 };

  for (const [id, r] of photos) {
    const p = meta[id]; if (!p) continue;
    if (!PAPER.has(r.kind)) { per.context++; report.skipped++; continue; }
    per.paper++;
    const amt = typeof r.total === "number" ? (r.currency === "LBP" ? r.total / 89000 : r.total) : null;
    const cand = [];
    for (const t of rows) {
      const spend = (t.debit || 0);
      if (!spend) continue;
      const dd = days(t.date, p.date);                       // the paper is sent on or after the day
      if (dd < -2 || dd > 10) continue;
      // the paper carries its own date: trust it over the day it was sent
      if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date !== t.date && Math.abs(days(t.date, r.date)) > 1) continue;
      let s = 0, why = [];
      if (amt != null) {
        const rel = Math.abs(spend - amt) / Math.max(spend, amt);
        if (rel < 0.005) { s += 6; why.push(`amount ${spend}`); }
        else if (rel < 0.03) { s += 3; why.push(`amount ~${spend}`); }
      }
      if (r.vendor && vendorHit(r.vendor, t)) { s += 4; why.push(`vendor ${r.vendor}`); }
      if (r.date && r.date === t.date) { s += 2; why.push("date on paper"); }
      if (dd === 0) s += 2; else if (dd <= 2) s += 1;
      if (s >= 6) cand.push({ t, s, why });
    }
    cand.sort((a, b) => b.s - a.s);
    const best = cand[0];
    const clear = best && (!cand[1] || best.s > cand[1].s || cand.filter(c => c.s === best.s).length === 1);
    if (best && clear) {
      (ties[best.t.id] = ties[best.t.id] || []).push({ name: nameOf(p), why: best.why.join(", "), r });
      per.tied++; report.tied++;
      if (VERBOSE) console.log(`   ${p.date} ${r.kind} ${r.vendor || ""} ${r.total || ""} → ${best.t.date} ${best.t.description || best.t.ref} (${best.why.join(", ")})`);
    } else {
      per.loose++; report.loose++;
      if (VERBOSE) console.log(`   ${p.date} ${r.kind} ${r.vendor || ""} ${r.total || ""} → no line (${cand.length} candidates)`);
    }
  }

  // write: every row of this worker carries exactly the photos that were tied to it
  let touched = 0;
  for (const t of rows) {
    const want = (ties[t.id] || []).map(x => ({ id: attOf[x.name], name: x.name })).filter(x => x.id);
    const cur = t.fileIds || [];
    const same = cur.length === want.length && cur.every(c => want.some(x => x.id === c.id));
    if (same) continue;
    touched++;
    if (COMMIT) await col.doc(t.id).set({
      fileIds: want, files: want.map(f => f.name), waPhotos: want.length > 0,
      updatedAt: new Date().toISOString(), updatedBy: "wa-tie-2026-09-08",
    }, { merge: true });
  }
  report.rows += touched;
  report.perWorker[who] = { ...per, rowsChanged: touched };
  console.log(`${who}: ${per.paper} paper photo(s) — ${per.tied} tied to a line, ${per.loose} left on his record; ${per.context} not paper (screenshots, site photos); ${touched} row(s) ${COMMIT ? "written" : "would change"}`);
}
console.log("\n" + (COMMIT ? "DONE" : "DRY RUN") + ":", JSON.stringify(report.perWorker));
process.exit(0);
