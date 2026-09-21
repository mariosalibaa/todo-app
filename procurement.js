// Procurement — the price book: what a supplier quoted for an item, when, and where the quote came
// from (a website, a WhatsApp call, a visit). Mario, 2026-09-21: "make a procurement page —
// supplier, item, price, description… so I search by supplier or item I can find it".
// Mounted by server.js under /api/procurement/*; admin only (gated in server.js).
//
// Firestore layout (under workspaces/<team>):
//   procurement/<id>  { id, supplier, contact, item, brand, price, currency, unit, description,
//                       source, date, project, addedBy, addedAt, updatedBy, updatedAt }
// `date` = the day of the quote (yyyy-mm-dd, Beirut); `source` = URL or "WhatsApp call" etc.

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const FIELDS = ['supplier', 'contact', 'item', 'brand', 'unit', 'description', 'source', 'date', 'project', 'currency'];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const parse = require('./site-parse');   // whisper() + anthropic() — the same helpers the site chat uses

// Voice / free-text entry (Mario, 2026-09-21 "add voice AI option for entry"): the spoken sentence
// ("Sakr, Rawad on WhatsApp, Bosch optical level 490 dollars with the staff and tripod") becomes the
// form's fields; the page shows them for a look before Save. Never writes to Firestore itself.
async function extract(text, suppliers) {
  const sys = `You turn one spoken or typed note about a supplier's price into the fields of a procurement record.
Fields: supplier (company/shop name; reuse the exact spelling from the known list when it is the same one), contact (person and/or phone, how we spoke), item (what it is, generic), brand (brand + model), price (number only), currency (USD unless clearly LBP/EUR), unit (per piece, per m², per set, per kit… or ""), description (what is included, conditions, delivery, warranty — the rest of the note, in clean English, keep figures), source ("WhatsApp call", "visit", "phone", "email", a URL… if said), date (yyyy-mm-dd if a date is said, else ""), project (if a project like AJ4193 / Ajaltoun is said, else "").
Lebanese context: "mira" = levelling staff, "cash" prices are in USD, "million" may mean LBP. Arabic or French words are fine — translate to English.
Answer with ONLY a JSON object with those keys; empty string for anything not said.`;
  return parse.anthropic({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: sys,
    messages: [{ role: 'user', content: `Known suppliers: ${suppliers.join(' | ') || '(none yet)'}

Note:
${text.slice(0, 3000)}` }] });
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID } = ctx;
  const col = db.collection('workspaces').doc(TEAM_ID).collection('procurement');
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
    for (const f of FIELDS) if (b[f] != null) doc[f] = String(b[f]).trim();
    if (!doc.currency) doc.currency = 'USD';
    if (b.price != null && b.price !== '') { const p = Number(String(b.price).replace(/[^\d.-]/g, '')); if (!isNaN(p)) doc.price = p; }
    if (!doc.supplier && !doc.item) return json(res, 400, { error: 'supplier or item is required' });
    const ref = col.doc(id); const cur = (await ref.get()).data();
    doc.updatedAt = now(); doc.updatedBy = who;
    if (!cur) { doc.addedAt = doc.updatedAt; doc.addedBy = who; if (!doc.date) doc.date = beirutDay(); }
    await ref.set(doc, { merge: true });
    return json(res, 200, (await ref.get()).data());
  }

  // Voice note → transcript → fields. Body = { audioBase64, mime } (as the site chat sends its voice notes) or { text }
  if (url === '/api/procurement/voice' && req.method === 'POST') {
    const b = await readBody(req, 6e6);
    const suppliers = [...new Set((await col.get()).docs.map(d => d.data().supplier).filter(Boolean))];
    let text = String(b.text || '');
    if (!text && b.audioBase64) {
      const buf = Buffer.from(String(b.audioBase64).replace(/^data:[^,]*,/, ''), 'base64');
      if (buf.length < 1000) return json(res, 400, { error: 'no audio' });
      text = await parse.whisper(buf, String(b.mime || 'audio/webm').replace(/;.*/, ''));
    }
    if (!text.trim()) return json(res, 400, { error: 'nothing heard' });
    const fields = await extract(text, suppliers);
    return json(res, 200, { transcript: text, fields });
  }

  if ((m = url.match(/^\/api\/procurement\/([\w-]+)$/)) && req.method === 'DELETE') {
    await col.doc(m[1]).delete();
    res.writeHead(204); res.end(); return true;
  }

  return false;
}

// yyyy-mm-dd in Beirut, never toISOString() (hub-date-timezone rule)
function beirutDay() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}

module.exports = { handle };
