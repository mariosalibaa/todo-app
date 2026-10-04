// The paper of a hub line follows it into Odoo (Mario, 2026-10-04: "the photo attached in the hub should
// also be attached to Odoo for related entries — fix this everywhere").
//
// A line's papers are of two kinds:
//   fileIds  Odoo attachments already (a WhatsApp photo staged on the worker's partner record, a scan…)
//   docs     files uploaded on the hub itself (camera, scanner, site chat), kept in the Storage bucket
// A line's entries in Odoo are the document(s) it stands for: the bill the hub booked (bookedMove), the
// bill a payment settled (match billId / docIds). Only when there is no document, the matched entry itself.
//
// For each such entry, every paper must be on it. Presence is judged by the file's checksum (Odoo's
// sha1 of the bytes), so a paper is never attached twice, whatever its name. A staged attachment (not on
// any entry yet) is MOVED onto the first entry; one that already sits on another entry is COPIED, so it
// stays where it was too. Each entry that receives something gets one chatter note naming the files.
// Writes happen in the entry's own company (Odoo refuses cross-company attachment writes otherwise).
const crypto = require('crypto');

const ALL_CO = [2, 4, 7, 8, 9, 10];
const int = v => (Number.isInteger(+v) && +v > 0 ? +v : null);

// the Odoo entries a line belongs to
function targetsOf(t) {
  const ch = ((t.odoo && t.odoo.matches) || []).find(m => m.chosen) || null;
  const own = ch ? int(ch.moveId) : null;
  const ids = new Set([int(t.bookedMove && t.bookedMove.id), ch && int(ch.billId), ...Object.values((ch && ch.docIds) || {}).map(int)].filter(Boolean));
  if (own) ids.delete(own);                       // the cash/payment entry itself: only when there is no document
  if (!ids.size && own) ids.add(own);
  return [...ids];
}
const hasPapers = t => ((t.fileIds || []).some(f => f && f.id) || (t.docs || []).length > 0);

// bytes of a hub-uploaded doc (same two places the docs route reads)
async function docBytes(deps, d) {
  if (d.store === 'firestore') {
    const x = (await deps.ws.collection('txDocs').doc(d.id).get()).data();
    return x ? Buffer.from(x.b64, 'base64') : null;
  }
  const [buf] = await deps.admin.storage().bucket().file(d.key).download();
  return buf;
}

// sync one line. deps = { odooCall, admin, ws }; t = the line (with id). Returns what was done.
async function syncLine(deps, t, opts = {}) {
  const { odooCall } = deps;
  const targets = targetsOf(t);
  const out = { id: t.id, targets, moved: 0, copied: 0, uploaded: 0, present: 0, errors: [] };
  if (!targets.length) return out;
  const ctxAll = { allowed_company_ids: ALL_CO };
  const moves = await odooCall('account.move', 'read', [targets, ['id', 'name', 'ref', 'company_id', 'state']], { context: ctxAll });
  const live = moves.filter(m => m && m.id);
  if (!live.length) { out.errors.push('entries not found in Odoo'); return out; }
  const coOf = Object.fromEntries(live.map(m => [m.id, m.company_id ? m.company_id[0] : 2]));
  // what each entry already carries
  const have = {}, named = {};
  for (const m of live) { have[m.id] = new Set(); named[m.id] = {}; }
  const onMoves = await odooCall('ir.attachment', 'search_read', [[['res_model', '=', 'account.move'], ['res_id', 'in', live.map(m => m.id)]]],
    { fields: ['res_id', 'checksum', 'name'], context: ctxAll });
  for (const a of onMoves) if (have[a.res_id]) { have[a.res_id].add(a.checksum); named[a.res_id][a.name] = a.id; }
  const added = {};   // moveId → [names]
  const note = (mid, name) => { (added[mid] = added[mid] || []).push(name); };

  // 1. Odoo attachments named on the line
  const fids = (t.fileIds || []).map(f => int(f && f.id)).filter(Boolean);
  const A = fids.length ? await odooCall('ir.attachment', 'read', [fids, ['id', 'name', 'res_model', 'res_id', 'checksum']], { context: ctxAll }) : [];
  for (const a of A) {
    let staged = !(a.res_model === 'account.move' && a.res_id);   // still on a partner record (or nowhere)
    for (const m of live) {
      if (have[m.id].has(a.checksum)) { out.present++; continue; }
      if (opts.dry) { out[staged ? 'moved' : 'copied']++; staged = false; continue; }
      const C = { allowed_company_ids: [coOf[m.id]] };
      try {
        if (staged) {
          await odooCall('ir.attachment', 'write', [[a.id], { res_model: 'account.move', res_id: m.id }], { context: { allowed_company_ids: ALL_CO } });
          staged = false; out.moved++;
        } else {
          await odooCall('ir.attachment', 'copy', [[a.id]], { default: { res_model: 'account.move', res_id: m.id }, context: C });
          out.copied++;
        }
        have[m.id].add(a.checksum); note(m.id, a.name);
      } catch (e) { out.errors.push(`${a.name} → ${m.name}: ${String(e.message || e).slice(0, 140)}`); }
    }
  }
  // 2. files uploaded on the hub
  let docsChanged = false;
  for (const d of t.docs || []) {
    let buf = null;
    try { buf = await docBytes(deps, d); } catch (e) { out.errors.push(`${d.name}: ${String(e.message || e).slice(0, 100)}`); continue; }
    if (!buf || !buf.length) continue;
    const sum = crypto.createHash('sha1').update(buf).digest('hex');
    for (const m of live) {
      // Odoo shrinks big photos on upload, so the copy's checksum is not the file's: the upload is
      // remembered on the doc itself (doc.odoo[moveId] = attachment id) and never repeated
      if (have[m.id].has(sum) || (d.odoo && d.odoo[m.id])) { out.present++; continue; }
      if (d.name && named[m.id][d.name]) {   // uploaded before the marker existed: same name on the entry = that upload
        d.odoo = { ...(d.odoo || {}), [m.id]: named[m.id][d.name] }; docsChanged = true; out.present++; continue;
      }
      if (opts.dry) { out.uploaded++; continue; }
      try {
        const attId = await odooCall('ir.attachment', 'create', [{ name: d.name || ('hub ' + t.date + '.' + ((d.mime || '').split('/')[1] || 'bin')), datas: buf.toString('base64'),
          mimetype: d.mime || 'application/octet-stream', res_model: 'account.move', res_id: m.id }], { context: { allowed_company_ids: [coOf[m.id]] } });
        have[m.id].add(sum); out.uploaded++; note(m.id, d.name);
        d.odoo = { ...(d.odoo || {}), [m.id]: Array.isArray(attId) ? attId[0] : attId }; docsChanged = true;
      } catch (e) { out.errors.push(`${d.name} → ${m.name}: ${String(e.message || e).slice(0, 140)}`); }
    }
  }
  if (docsChanged && opts.ref) await opts.ref.set({ docs: t.docs }, { merge: true });
  // 3. the other way: what Odoo holds on those entries shows on the hub line too (Mario, 2026-10-04:
  //    "bring photo from Odoo and attach it here") — added to fileIds, never removing anything
  // Not from a month bill (…-LABOUR / …-EXPENSES): it carries every paper of the month, and one line's
  // paper is not the others' (Mario, 2026-09-08: never hang a day's photos on every row).
  const known = new Set(fids);
  const single = new Set(live.filter(m => !/-(LABOUR|EXPENSES)$/.test(String(m.ref || ''))).map(m => m.id));
  const fromOdoo = onMoves.filter(x => !known.has(x.id) && single.has(x.res_id));
  if (fromOdoo.length && !opts.dry) {
    const meta = await odooCall('ir.attachment', 'read', [fromOdoo.map(x => x.id), ['id', 'name', 'mimetype']], { context: ctxAll });
    const keep = meta.filter(x => !/^(text\/|application\/(xml|json))/.test(x.mimetype || ''));   // papers, not Odoo's generated XML
    if (keep.length) {
      t.fileIds = [...(t.fileIds || []), ...keep.map(x => ({ id: x.id, name: x.name }))];
      out.pulled = keep.length;
      if (opts.ref) await opts.ref.set({ fileIds: t.fileIds, files: t.fileIds.map(f => f.name) }, { merge: true });
    }
  } else if (fromOdoo.length) out.pulled = fromOdoo.length;
  // 3. one chatter note per entry that received something
  for (const [mid, names] of Object.entries(added)) {
    try {
      await odooCall('mail.message', 'create', [{ model: 'account.move', res_id: +mid, message_type: 'comment',
        body: 'Paper' + (names.length > 1 ? 's' : '') + ' from the Shift Hub line of ' + t.date + ' — ' + String(t.description || '').slice(0, 120) + ': ' + names.join(', ') }],
        { context: { allowed_company_ids: [coOf[mid]] } });
    } catch (e) { out.errors.push('chatter: ' + String(e.message || e).slice(0, 100)); }
  }
  return out;
}

// every line of every account (or those changed since `since`). For runs from the laptop and the daily cron.
async function sweep(deps, { listAccounts, resolve, txCol }, opts = {}) {
  const res = { lines: 0, synced: 0, moved: 0, copied: 0, uploaded: 0, errors: [] };
  const accounts = await listAccounts(deps.ws);
  const t0 = Date.now();
  for (const x of accounts) {
    if (opts.only && x.id !== opts.only) continue;
    const a = await resolve(deps.ws, x.id); if (!a) continue;
    let q = txCol(a);
    if (opts.since) q = q.where('updatedAt', '>=', opts.since);
    const docs = (await q.get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.excluded && (t.src !== 'odoo' || (t.docs || []).length) && targetsOf(t).length);
    for (const t of docs) {
      if (opts.deadline && Date.now() - t0 > opts.deadline) { res.stopped = 'time'; return res; }
      res.lines++;
      try {
        const r = await syncLine(deps, t, { ...opts, ref: txCol(a).doc(t.id) });
        if (r.moved || r.copied || r.uploaded || r.pulled) { res.synced++; res.pulled = (res.pulled || 0) + (r.pulled || 0); if (opts.list) (res.changed = res.changed || []).push({ account: a.id, date: t.date, text: String(t.description || '').slice(0, 60), ...r }); }
        res.moved += r.moved; res.copied += r.copied; res.uploaded += r.uploaded;
        for (const e of r.errors) res.errors.push(`${a.id} ${t.date} ${t.id}: ${e}`);
      } catch (e) { res.errors.push(`${a.id} ${t.id}: ${String(e.message || e).slice(0, 160)}`); }
    }
  }
  return res;
}

module.exports = { syncLine, sweep, targetsOf, hasPapers };
