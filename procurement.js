// Procurement — the price book: what a supplier quoted for an item, when, and where the quote came
// from (a website, a WhatsApp call, a visit). Mario, 2026-09-21: "make a procurement page —
// supplier, item, price, description… so I search by supplier or item I can find it".
// Mounted by server.js under /api/procurement/*; admin only (gated in server.js).
//
// Firestore layout (under workspaces/<team>):
//   procurement/<id>  { id, supplier, contact, item, brand, price, currency, unit, description,
//                       source, date, project, trade (topography, ppr, sanitary…), division (Mechanical,
//                       Electrical, Civil, Steel, Solar…), photos [{ id, name, mime, size, key, store, at, by }],
//                       addedBy, addedAt, updatedBy, updatedAt }
// `date` = the day of the quote (yyyy-mm-dd, Beirut); `source` = URL or "WhatsApp call" etc.
// `photos` = the offer itself — the handwritten note, the WhatsApp screenshot, the supplier's PDF
// (Mario 2026-10-07: "attach the photo"); bytes live in the Storage bucket via hub-files,
// key procurement/<rowId>/<photoId>.<ext>, served back on GET (cookie auth works for <img>).
//
// Contacts (Mario 2026-10-18: "business cards should be linked to Google Contacts, not procurement"):
// the same handler serves /api/contacts/* off workspaces/<team>/contacts/<id>
//   { id, name, company, title, phone, email, website, social, trade, division, address, notes, source, date,
//     project, sharedBy, inPhone, photos [...], google { resourceName, etag, syncedAt } }
// sharedBy = who passed us the contact (Mario 2026-10-23: "contacts shared" tab — e.g. Richard Beeld's suppliers);
// inPhone = already saved on the phone through WhatsApp's sync, so it is in Google without a resourceName here.
// — the card's people, with the card photos; the page writes each one to Mario's Google Contacts from the
// browser (People API, his own Google token) and stores the resourceName back here.

const files = require('./hub-files');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
// trade + division (Mario 2026-09-22: "add trade column: topography", "supplier list for ppr; division mechanical")
const KINDS = {
  procurement: { fields: ['supplier', 'contact', 'item', 'brand', 'unit', 'description', 'source', 'date', 'project', 'currency', 'trade', 'division'], need: ['supplier', 'item'], label: r => r.supplier || 'offer' },
  contacts: { fields: ['name', 'company', 'title', 'phone', 'email', 'website', 'social', 'trade', 'division', 'address', 'notes', 'source', 'date', 'project', 'sharedBy'], need: ['name', 'company'], label: r => r.name || r.company || 'contact' },
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID } = ctx;
  const kind = /^\/api\/contacts(\/|$)/.test(url) ? 'contacts' : 'procurement', K = KINDS[kind], base = '/api/' + kind;
  url = url.replace(base, '/api/procurement');   // one set of routes below, either collection
  const col = db.collection('workspaces').doc(TEAM_ID).collection(kind);
  const who = (user && user.email) || 'unknown';
  let m;

  // The whole book — the page filters client-side (a few hundred rows at most)
  if (url === '/api/procurement' && req.method === 'GET') {
    const snap = await col.get();
    const list = snap.docs.map(d => d.data());
    list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return json(res, 200, list);
  }

  // Add or edit one row (id present → edit)
  if (url === '/api/procurement' && req.method === 'POST') {
    const b = await readBody(req, 64e3);
    const id = (typeof b.id === 'string' && /^[\w-]{1,40}$/.test(b.id)) ? b.id : newId();
    const doc = { id };
    for (const f of K.fields) if (b[f] != null) doc[f] = String(b[f]).trim();
    if (kind === 'procurement') {
      if (!doc.currency) doc.currency = 'USD';
      if (b.price != null && b.price !== '') { const p = Number(String(b.price).replace(/[^\d.-]/g, '')); if (!isNaN(p)) doc.price = p; }
      else if (b.price === '') doc.price = null;
    }
    // the Google Contacts link the page got back from the People API
    if (kind === 'contacts' && b.google && typeof b.google === 'object') doc.google = { resourceName: String(b.google.resourceName || ''), etag: String(b.google.etag || ''), syncedAt: now() };
    if (kind === 'contacts' && b.google === null) doc.google = null;
    if (!K.need.some(f => doc[f])) return json(res, 400, { error: K.need.join(' or ') + ' is required' });
    const ref = col.doc(id); const cur = (await ref.get()).data();
    doc.updatedAt = now(); doc.updatedBy = who;
    if (!cur) { doc.addedAt = doc.updatedAt; doc.addedBy = who; if (!doc.date) doc.date = beirutDay(); }
    await ref.set(doc, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  // Read a business card (front + back photos) into the contact's fields — extraction only, the page fills
  // the empty boxes and Mario saves (Mario 2026-10-18: cards → Google Contacts)
  if (kind === 'contacts' && url === '/api/procurement/read' && req.method === 'POST') {
    const b = await readBody(req, 4.4e6);
    const imgs = (b.images || []).filter(x => x && x.dataBase64).slice(0, 2);
    if (!imgs.length) return json(res, 400, { error: 'images required' });
    const out = await parse.anthropic({ model: 'claude-sonnet-5', max_tokens: 600,
      system: 'These are the front and back of one business card. Return JSON only: {"name":string,"title":string,"company":string,"phone":string,"email":string,"website":string,"social":string,"address":string,"trade":string,"notes":string}. name = the person (empty if none). phone = every number, as printed, joined by " · ", with its label when printed (M, T, F, WhatsApp). email/website/social likewise joined by " · " (social = @handles). trade = 2-3 words for what the company does (e.g. "window film", "steel", "solar software"). notes = one line: brands, distributorships, slogans worth remembering. Empty string when absent.',
      messages: [{ role: 'user', content: imgs.map(x => ({ type: 'image', source: { type: 'base64', media_type: /png|webp/.test(x.mime || '') ? x.mime : 'image/jpeg', data: String(x.dataBase64).replace(/^data:[^,]*,/, '') } })) }] });
    const f = {}; for (const k of KINDS.contacts.fields) if (out[k]) f[k] = String(out[k]).slice(0, 400);
    return json(res, 200, f);
  }

  if ((m = url.match(/^\/api\/procurement\/([\w-]+)$/)) && req.method === 'DELETE') {
    const cur = (await col.doc(m[1]).get()).data();
    for (const ph of (cur && cur.photos) || []) { try { await files.deleteFile(ctx, ph); } catch (e) { console.warn(kind + ' photo delete:', e.message); } }
    await col.doc(m[1]).delete();
    res.writeHead(204); res.end(); return true;
  }

  // Photos of the offer: add one (base64 body), read one back, remove one
  if ((m = url.match(/^\/api\/procurement\/([\w-]+)\/photo$/)) && req.method === 'POST') {
    const ref = col.doc(m[1]); const cur = (await ref.get()).data();
    if (!cur) return json(res, 404, { error: 'row not found' });
    const b = await readBody(req, 12e6);
    if (!b.dataBase64) return json(res, 400, { error: 'dataBase64 required' });
    const buf = Buffer.from(String(b.dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 8e6) return json(res, 400, { error: 'photo over 8 MB' });
    const mime = /^image\/|pdf$/.test(b.mime || '') ? String(b.mime) : 'image/jpeg';
    const ext = /pdf$/.test(mime) ? 'pdf' : /png$/.test(mime) ? 'png' : /webp$/.test(mime) ? 'webp' : 'jpg';
    const pid = newId();
    const saved = await files.saveFile(ctx, { buf, mime, name: b.name || `${K.label(cur)} ${cur.date || ''}.${ext}`.trim(), key: `${kind}/${m[1]}/${pid}.${ext}`, who, meta: { [kind]: m[1] } });
    const photo = { ...saved, id: pid };
    await ref.set({ photos: [...(cur.photos || []), photo], updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }
  if ((m = url.match(/^\/api\/procurement\/([\w-]+)\/photo\/([\w-]+)$/)) && req.method === 'GET') {
    const cur = (await col.doc(m[1]).get()).data();
    const ph = cur && (cur.photos || []).find(p => p.id === m[2]);
    if (!ph) { res.writeHead(404); res.end('no such photo'); return true; }
    await files.streamFile(ctx, ph, res, req); return true;
  }
  if ((m = url.match(/^\/api\/procurement\/([\w-]+)\/photo\/([\w-]+)$/)) && req.method === 'DELETE') {
    const ref = col.doc(m[1]); const cur = (await ref.get()).data();
    const ph = cur && (cur.photos || []).find(p => p.id === m[2]);
    if (!ph) return json(res, 404, { error: 'no such photo' });
    try { await files.deleteFile(ctx, ph); } catch (e) { console.warn(kind + ' photo delete:', e.message); }
    await ref.set({ photos: cur.photos.filter(p => p.id !== m[2]), updatedAt: now(), updatedBy: who }, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  return false;
}

// yyyy-mm-dd in Beirut, never toISOString() (hub-date-timezone rule)
function beirutDay() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}

module.exports = { handle };
