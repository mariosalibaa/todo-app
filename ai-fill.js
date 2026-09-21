// "Dictate" for every hub form (Mario, 2026-09-21: "adding the dictate idea everywhere on the hub").
// One route, POST /api/ai/fill: a voice note (or a typed note) + the form's schema → the form's fields.
// The page describes its fields in words (schema.fields[{key, hint}]) and hands over the names it
// knows (schema.context {label: [names]}) so Claude answers with the exact spelling the form expects.
// shape 'object' → one record; 'array' → a list of records (the Day report: several people in one
// sentence). Extraction only — it never writes anything; the page shows the result and the person
// saves (or not). Whisper for the audio, Haiku for the fields — the same helpers the site chat uses.
// Client side: Admin.dictate(...) in admin-shared.js.

const parse = require('./site-parse');
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function systemPrompt(schema, today) {
  const fields = (schema.fields || []).map(f => `- ${f.key}: ${f.hint || ''}`).join('\n');
  const ctx = Object.entries(schema.context || {}).map(([k, v]) => `${k}: ${(Array.isArray(v) ? v : []).slice(0, 300).join(' | ') || '(none)'}`).join('\n');
  const many = schema.shape === 'array';
  return `You turn one spoken or typed note from Mario (owner of Shift, a steel/solar/real-estate company in Lebanon) into ${many ? 'a list of records' : 'one record'} for the form "${schema.name || 'form'}".
${schema.intro || ''}
Fields of a record:
${fields}
${ctx ? `\nNames the form knows — when the note means one of these, answer with EXACTLY this spelling:\n${ctx}\n` : ''}
Today is ${today} (Beirut). "yesterday", "Monday"… → yyyy-mm-dd. Lebanese context: "mira" = levelling staff, prices are USD unless clearly LBP ("million" = LBP), Arabic or French words are fine — translate to English. Amounts: numbers only.
Answer with ONLY JSON: ${many ? 'an array of objects' : 'one object'} with those keys — empty string for anything the note does not say. Never invent a name that is not in the note.`;
}

function beirutDay() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}

async function handle(req, res) {
  if (req.method !== 'POST') return false;
  const b = await readBody(req, 6e6);
  const schema = b.schema && typeof b.schema === 'object' ? b.schema : null;
  if (!schema || !Array.isArray(schema.fields) || !schema.fields.length) return json(res, 400, { error: 'schema.fields required' });
  let text = String(b.text || '');
  if (!text && b.audioBase64) {
    const buf = Buffer.from(String(b.audioBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length < 1000) return json(res, 400, { error: 'no audio' });
    text = await parse.whisper(buf, String(b.mime || 'audio/webm').replace(/;.*/, ''));
  }
  if (!text.trim()) return json(res, 400, { error: 'nothing heard' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(res, 501, { error: 'no_api_key' });
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1200, system: systemPrompt(schema, beirutDay()),
      messages: [{ role: 'user', content: text.slice(0, 4000) }] }) });
  const j = await r.json();
  if (!r.ok) { console.error('ai-fill claude:', JSON.stringify(j).slice(0, 300)); return json(res, 502, { error: 'Claude: ' + (j.error && j.error.message || r.status) }); }
  const raw = (j.content || []).map(c => c.text || '').join('');
  const m = raw.match(schema.shape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  let fields; try { fields = m ? JSON.parse(m[0]) : (schema.shape === 'array' ? [] : {}); } catch { fields = schema.shape === 'array' ? [] : {}; }
  return json(res, 200, { transcript: text, fields });
}

module.exports = { handle };
