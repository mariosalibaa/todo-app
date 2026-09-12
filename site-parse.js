// A post on /site → the pieces of a ledger line. Deterministic first (the same money reader the
// WhatsApp import uses), Claude only for Mario's General thread where the text names a partner,
// a project and sometimes the paying account. Every result is a SUGGESTION; nothing here books.
const { parseMoney } = require('./ledgers');

function quickParse(text, { fromMe, owner, lbpRate }) {
  const p = parseMoney(text, owner || '', !!fromMe, lbpRate);
  if (!p || p.skip || !p.amount) return p && p.skip ? { amount: 0, currency: '', side: null, skip: p.skip } : null;
  return { amount: p.amount, currency: p.currency || 'USD', side: p.side || null };
}

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function matchName(text, list) {
  const t = ' ' + norm(text) + ' ';
  let best = null;
  for (const x of list || []) {
    const n = norm(x.name);
    if (n && t.includes(' ' + n + ' ') && (!best || n.length > norm(best.name).length)) best = x;
  }
  return best;
}

async function anthropic(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('Claude: ' + (j.error && j.error.message || r.status));
  const txt = (j.content || []).map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

async function claudeParse(text, { analytics, partners, accounts }) {
  const names = l => (l || []).map(x => x.name).slice(0, 300).join(' | ');
  const sys = `You read one short note Mario (owner of Shift, Lebanon) wrote about a payment and return JSON only:
{"amount":number|null,"currency":"USD"|"LBP"|null,"partner":string|null,"project":string|null,"paidFrom":string|null,"note":string}
partner = the supplier/person paid, chosen from PARTNERS when one matches (else the name as written). project = one of PROJECTS or null.
paidFrom = one of ACCOUNTS only when the note says where the money came from (whish, neo, wise, ziad...), else null. note = what it was for, short.
PARTNERS: ${names(partners)}
PROJECTS: ${names(analytics)}
ACCOUNTS: ${names(accounts)}`;
  const out = await anthropic({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: sys, messages: [{ role: 'user', content: text }] });
  return { amount: +out.amount || null, currency: out.currency || null, partner: out.partner || null, project: out.project || null, paidFrom: out.paidFrom || null, note: String(out.note || '').slice(0, 160) };
}

async function visionRead(buf, mime) {
  const out = await anthropic({ model: 'claude-sonnet-5', max_tokens: 300,
    system: 'Look at the image. If it is a receipt, invoice or payment proof return {"receipt":true,"vendor":string,"amount":number,"currency":"USD"|"LBP","date":"yyyy-mm-dd"|null,"note":string}. If it is a photo of a construction site or work in progress return {"receipt":false,"note":one line describing the work}. JSON only.',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } }] }] });
  return { receipt: !!out.receipt, vendor: out.vendor || '', amount: +out.amount || 0, currency: out.currency || 'USD', date: out.date || null, note: String(out.note || '').slice(0, 160) };
}

async function whisper(buf, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('no OPENAI_API_KEY — voice notes cannot be transcribed');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), 'voice.' + (mime.split('/')[1] || 'webm').replace(/;.*/, ''));
  fd.append('model', 'whisper-1');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error('Whisper: ' + (j.error && j.error.message || r.status));
  return String(j.text || '').trim();
}

module.exports = { quickParse, matchName, claudeParse, visionRead, whisper };
