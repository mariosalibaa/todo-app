// CPR diesel fills — Kamal's receipts for filling the generators (Mario, 2026-09-26: "a place where Kamal can
// upload the bill for filling the generator, amount, dollar and litre"). Photos go through the same scanner as the
// Shift WhatsApp chat (scan-editor.js) and are stored by hub-files (Storage bucket, key cpr-fuel/<id>.jpg).
// Mounted by server.js ahead of the sign-in gate:
//   GET    /api/cpr/fuel                list (newest first)
//   POST   /api/cpr/fuel                { date, gen, litres, usd, note, who, dataBase64?, mime?, name? }
//   GET    /api/cpr/fuel/<id>/file      the photo
//   DELETE /api/cpr/fuel/<id>           admin only
// Who may: the 6-digit code (CPR_FUEL_KEY; Kamal types it once on /cpr → ⛽ Diesel fills, the browser keeps it;
// sent as ?k= or x-cpr-key) or a hub admin. A wrong code waits 2 s, so guessing six digits is slow.

const files = require('./hub-files');
const GENS = { big: 'Generator big', church: 'Generator church', small: 'Generator small', other: 'Other' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const readBody = (req, max = 8e6) => new Promise((resolve, reject) => {
  let b = '', size = 0;
  req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); return; } b += c; });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});

async function handle(req, res, url, ctx) {
  const { db, TEAM_ID, isAdmin } = ctx;
  const q = new URL(req.url, 'http://x').searchParams;
  const key = q.get('k') || req.headers['x-cpr-key'] || '';
  const keyOk = !!process.env.CPR_FUEL_KEY && key === process.env.CPR_FUEL_KEY;
  if (!keyOk && !isAdmin) { if (key) await new Promise(r => setTimeout(r, 2000)); return json(res, 401, { error: key ? 'Wrong code.' : 'code', needCode: true }); }
  const col = db.collection('workspaces').doc(TEAM_ID).collection('cprFuel');
  const p = url.split('?')[0];
  let m;

  if (p === '/api/cpr/fuel' && req.method === 'GET') {
    const snap = await col.orderBy('date', 'desc').limit(500).get();
    return json(res, 200, { gens: GENS, admin: !!isAdmin, list: snap.docs.map(d => { const x = d.data(); return { ...x, file: x.file ? { name: x.file.name, mime: x.file.mime } : null }; }) });
  }
  if (p === '/api/cpr/fuel' && req.method === 'POST') {
    const b = await readBody(req);
    const date = String(b.date || '').slice(0, 10);
    const litres = +b.litres, usd = +b.usd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'date' });
    if (!(litres > 0) && !(usd > 0)) return json(res, 400, { error: 'Litres or amount needed' });
    const id = newId(), who = String(b.who || (isAdmin ? 'admin' : 'Kamal')).slice(0, 60);
    const doc = { id, date, gen: GENS[b.gen] ? b.gen : 'big', litres: litres > 0 ? litres : null, usd: usd > 0 ? usd : null,
      note: String(b.note || '').slice(0, 300), who, at: new Date().toISOString() };
    if (b.dataBase64) {
      const buf = Buffer.from(String(b.dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
      if (buf.length > 4e6) return json(res, 400, { error: 'photo over 4 MB' });
      const mime = /^image\/|pdf$/.test(b.mime || '') ? b.mime : 'image/jpeg';
      doc.file = await files.saveFile(ctx, { buf, mime, name: b.name || `diesel ${date}.jpg`, key: `cpr-fuel/${id}.${/pdf$/.test(mime) ? 'pdf' : 'jpg'}`, who, meta: { cprFuel: id } });
    }
    await col.doc(id).set(doc);
    return json(res, 200, { ...doc, file: doc.file ? { name: doc.file.name, mime: doc.file.mime } : null });
  }
  // read the bill (Mario 2026-09-26: "allow to read the image") — the page fills the boxes, Kamal checks and saves
  if (p === '/api/cpr/fuel/read' && req.method === 'POST') {
    const b = await readBody(req);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json(res, 501, { error: 'no_api_key' });
    const data = String(b.dataBase64 || '').replace(/^data:[^,]*,/, '');
    const mime = /^image\/(jpeg|png|webp|gif)$/.test(b.mime || '') ? b.mime : 'image/jpeg';
    if (!data) return json(res, 400, { error: 'no image' });
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const system = `You read a diesel (mazout) bill or a handwritten note for filling a generator in Lebanon. Today is ${today}. ` +
      'Answer ONLY with JSON: {"litres": number|null, "usd": number|null, "date": "YYYY-MM-DD"|null, "gen": "big"|"church"|"small"|null, "note": string}. ' +
      'usd = the total in US dollars (if only LBP is written, put null and the LBP total in note). litres = total litres. ' +
      'gen from words like "Gen Big", "church", "small". note: the supplier and the price per litre if written, a few words. Unknown → null.';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: 'Read this bill.' }] }] }) });
    const out = await r.json();
    if (!r.ok) return json(res, 502, { error: 'Claude: ' + (out.error && out.error.message || r.status) });
    const raw = (out.content || []).map(c => c.text || '').join(''); const mm = raw.match(/\{[\s\S]*\}/);
    let f = {}; try { f = mm ? JSON.parse(mm[0]) : {}; } catch (e) {}
    return json(res, 200, { litres: +f.litres > 0 ? +f.litres : null, usd: +f.usd > 0 ? +f.usd : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : null, gen: GENS[f.gen] ? f.gen : null, note: String(f.note || '').slice(0, 200) });
  }
  if ((m = /^\/api\/cpr\/fuel\/([\w-]+)\/file$/.exec(p)) && req.method === 'GET') {
    const d = await col.doc(m[1]).get();
    if (!d.exists || !d.data().file) { res.writeHead(404); res.end('not found'); return true; }
    await files.streamFile(ctx, d.data().file, res, req);
    return true;
  }
  if ((m = /^\/api\/cpr\/fuel\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
    if (!isAdmin) return json(res, 403, { error: 'admin only' });
    const d = await col.doc(m[1]).get();
    if (d.exists && d.data().file) { try { await files.deleteFile(ctx, d.data().file); } catch (e) {} }
    await col.doc(m[1]).delete();
    return json(res, 200, { ok: true });
  }
  return false;
}

module.exports = { handle, GENS };
