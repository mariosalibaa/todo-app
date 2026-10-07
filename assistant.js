// ── Ask: the hub's own assistant ─────────────────────────────────────────────────────────────
// Mario, 2026-09-26: a chat box everywhere in the hub, for us and for whoever buys this later.
// It is NOT Claude Code and it never touches the code: the browser talks to /api/assistant, the
// server holds the key, and Claude may only call the few tools written below. Each tool runs as the
// signed-in person — a worker sees his own ledger and nothing else — and every answer says which
// tools were used, so nothing happens invisibly.
//
// v1 (2026-09-26, everyone, read-only): list_accounts · account_balance · find_lines.
// v2 (2026-10-07, Mario only — "me only"):
//   · it knows Shift (SHIFT.md as context) and what is open on the page (the browser sends it along)
//   · propose_line / fill_line — a proposal on a ledger, exactly like a WhatsApp line: it waits for
//     Mario's ✓ on the grid; the chat never accepts, never books, never touches an accepted line
//   · dev_request — what needs code goes to the queue (/dev); Claude Code picks it up from VS Code
//     (skill hub-dev-queue). The hub assistant itself never changes code.
const fs = require('fs');
const path = require('path');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-5';
const MAX_ROUNDS = 5;            // tool → answer → tool …, then it must speak
const MAX_LINES = 60;            // rows handed back to Claude in one go

const money = n => Math.round((+n || 0) * 100) / 100;
const short = (s, n = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
const nowIso = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };

// SHIFT.md — the one page every Claude session reads first. On the laptop it is the live file next to
// the repo; on Vercel it is the bundled copy (refresh it with `cp ../SHIFT.md shift-context.md`).
let shiftCtx = { at: 0, text: '' };
function shiftContext() {
  if (Date.now() - shiftCtx.at < 300e3) return shiftCtx.text;
  let text = '';
  for (const p of [path.join(__dirname, '..', 'SHIFT.md'), path.join(__dirname, 'shift-context.md')]) {
    try { text = fs.readFileSync(p, 'utf8'); break; } catch {}
  }
  shiftCtx = { at: Date.now(), text: text.slice(0, 12000) };
  return shiftCtx.text;
}

const READ_TOOLS = [
  {
    name: 'list_accounts',
    description: 'The cash, bank and worker ledgers this person may see, with their currency and what they are for. Call this first when you do not know which account is meant.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'account_balance',
    description: 'The balance of one ledger and how it is made up (counted lines, what is still waiting for a ✓, what is not yet in Odoo).',
    input_schema: { type: 'object', properties: { accountId: { type: 'string', description: 'id from list_accounts' } }, required: ['accountId'] },
  },
  {
    name: 'find_lines',
    description: 'Search the ledger lines: by words in the description, partner or note, by account, by date range, by amount. Returns the matching lines, newest first, each with its id and state. A line with source "odoo" is the same purchase read back from Odoo and matched onto a hub line — never add it to the hub line, or the money is counted twice. counted:false means the line does not move the balance. state "waiting" = a proposal not yet ✓-accepted by Mario.',
    input_schema: { type: 'object', properties: {
      q: { type: 'string', description: 'words to look for (description, partner, note, reference)' },
      accountId: { type: 'string', description: 'limit to one ledger' },
      from: { type: 'string', description: 'yyyy-mm-dd' },
      till: { type: 'string', description: 'yyyy-mm-dd' },
      minAmount: { type: 'number' }, maxAmount: { type: 'number' },
      waiting: { type: 'boolean', description: 'only proposals still waiting for a ✓' },
      limit: { type: 'number', description: 'default 30, at most 60' },
    } },
  },
];

// Mario only. Every write here is a PROPOSAL: it lands on the ledger as a line that waits for his ✓
// on the grid, the same gate every WhatsApp line goes through. Nothing is accepted or booked from the chat.
const ADMIN_TOOLS = [
  {
    name: 'lookup_refs',
    description: 'Find the real Odoo partner (supplier), project (analytic account) and company names before proposing or filling a line, so the proposal carries ids and not free text. Returns the closest matches for the words given.',
    input_schema: { type: 'object', properties: { partner: { type: 'string' }, project: { type: 'string' }, company: { type: 'string' } } },
  },
  {
    name: 'propose_line',
    description: 'Put a NEW proposed line on a ledger. It waits for Mario\'s ✓ on the grid — say so in the answer. Use it when Mario tells you about money that is not on any ledger yet. Look up partner and project with lookup_refs first; if nothing matches, pass the words as text.',
    input_schema: { type: 'object', properties: {
      accountId: { type: 'string', description: 'id from list_accounts' },
      date: { type: 'string', description: 'yyyy-mm-dd (Beirut)' },
      side: { type: 'string', enum: ['out', 'in'], description: 'out = money left this ledger, in = money came in' },
      amount: { type: 'number' },
      description: { type: 'string', description: 'what it was, short' },
      partnerId: { type: 'number' }, partnerName: { type: 'string' },
      analyticId: { type: 'number' }, analyticName: { type: 'string', description: 'the project' },
      company: { type: 'string', description: 'exact company name from lookup_refs' },
      note: { type: 'string' },
    }, required: ['accountId', 'date', 'side', 'amount', 'description'] },
  },
  {
    name: 'fill_line',
    description: 'Fill the empty fields of an EXISTING line that is still waiting for a ✓ (partner, project, company, note, description). Refused on a line already accepted or in Odoo — those are changed on the grid. It does not accept the line: Mario presses ✓ himself.',
    input_schema: { type: 'object', properties: {
      accountId: { type: 'string' }, txId: { type: 'string', description: 'id from find_lines' },
      description: { type: 'string' },
      partnerId: { type: 'number' }, partnerName: { type: 'string' },
      analyticId: { type: 'number' }, analyticName: { type: 'string' },
      company: { type: 'string' }, note: { type: 'string' },
    }, required: ['accountId', 'txId'] },
  },
  {
    name: 'dev_request',
    description: 'Queue a change to the hub that needs code (a new column, a page that misbehaves, a feature). You cannot change code yourself — this hands it to Claude Code, which Mario launches from VS Code when the laptop is on. Write the prompt as a precise brief for a developer who knows the hub: which page, what happens now, what should happen, and how to tell it is done. One request per change; do not queue a question you can answer or a line you can propose.',
    input_schema: { type: 'object', properties: {
      title: { type: 'string', description: 'one line, like a commit subject' },
      prompt: { type: 'string', description: 'the brief for Claude Code' },
      page: { type: 'string', description: 'the hub path it concerns, e.g. /site or /accounting/statements' },
    }, required: ['title', 'prompt'] },
  },
];

const SYSTEM = [
  'You are the assistant inside Shift Hub, the accounting and site hub of Shift Group (steel structures, solar systems, engineering) and Shift Development (villas) in Lebanon.',
  'You answer about what is in the hub: the cash and bank ledgers, who was paid, what a project cost, what is still waiting to be booked in Odoo.',
  'Use the tools to look things up — never guess a figure, and never invent an account, a partner or a date. If the tools do not hold the answer, say so plainly.',
  'Money is USD unless the ledger says otherwise. Dates are Beirut time, written yyyy-mm-dd.',
  'Answer in a few short lines of plain text. No markdown: no tables, no pipes, no ** — the chat box shows the characters as they are. Several figures go one per line, like "Mario cash: -2,746.92 USD". No preamble, no closing question.',
].join('\n');

const READ_ONLY_NOTE = 'You are read-only: you cannot change a line, book anything in Odoo or send a message. When someone asks for that, say where in the hub it is done (the accounts grid, the site chat, the statement round) instead of pretending.';

const ADMIN_NOTE = [
  'You are talking with Mario, the owner and the only approver. Three more things you can do for him:',
  '1. Propose a ledger line (propose_line) or fill the blanks of a waiting one (fill_line). Both are PROPOSALS that wait for his ✓ on the grid — never claim a line is accepted, booked or in Odoo. Before proposing, find the real partner / project / company with lookup_refs; when Mario says "this line" or "the 19 dollar one", find it with find_lines using what is open on the page (account, day, amount) and ask only if several match.',
  '2. Queue a code change (dev_request) when what he wants needs the hub itself changed. Tell him it is queued at /dev for Claude Code. Group nothing: one request per change.',
  '3. Everything else in the hub he still does on the pages: accepting (✓), booking in Odoo, sending to a worker. Point him there.',
  'He often dictates: short, sometimes misheard words. Confirm what you understood in the answer, in one line, before the result.',
].join('\n');

// ── the tools, each already scoped to this person ────────────────────────────────────────────
async function runTool(ctx, name, input) {
  const { accounts, ws, access } = ctx;
  const mine = access.admin ? null : (access.account || '');          // a worker sees his own ledger only
  const all = await accounts.listAccounts(ws);
  const allowed = all.filter(a => !mine || a.id === mine);
  const stateOf = t => t.bookedMove ? 'in Odoo' : (t.src === 'whatsapp' || t.src === 'site') ? (t.waAccepted ? 'accepted' : t.excluded && !t.review ? 'dismissed' : 'waiting') : t.excluded ? 'not counted' : 'counted';

  if (name === 'list_accounts') {
    return { accounts: allowed.map(a => ({ id: a.id, name: a.name, currency: a.currency || 'USD', type: a.type || 'cash',
      owner: a.owner || '', daily: !!a.daily, archived: !!a.archived })) };
  }

  if (name === 'account_balance') {
    const a = allowed.find(x => x.id === input.accountId);
    if (!a) return { error: 'no such ledger, or not yours to see' };
    const acc = await accounts.resolve(ws, a.id);
    const snap = await accounts.txCol(acc).get();
    const tx = snap.docs.map(d => d.data());
    const counted = tx.filter(t => !t.excluded);
    // the grid's own rule, so this says exactly what the page says: excluded lines move nothing, an Excel-kept
    // row moves by its sheet amount, and a pinned opening balance is the start
    const mv = t => t.excluded ? 0 : t.xlAmount != null ? -(+t.xlAmount) : (t.credit || 0) - (t.debit || 0);
    const op = acc.opening && acc.opening.date ? acc.opening : null;
    const bal = op ? op.amount + tx.filter(t => t.date >= op.date).reduce((s, t) => s + mv(t), 0)
                   : tx.reduce((s, t) => s + mv(t), 0);
    return { account: a.name, currency: a.currency || 'USD', balance: money(bal), lines: tx.length, counted: counted.length,
      waitingForAccept: tx.filter(t => (t.src === 'whatsapp' || t.src === 'site') && !t.waAccepted && !t.bookedMove).length,
      notInOdoo: counted.filter(t => !t.bookedMove && t.src !== 'odoo').length,
      lastLine: tx.map(t => t.date).sort().pop() || '' };
  }

  if (name === 'find_lines') {
    const words = String(input.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(1, +input.limit || 30), MAX_LINES);
    const out = [];
    for (const a of allowed.filter(x => !input.accountId || x.id === input.accountId)) {
      const acc = await accounts.resolve(ws, a.id);
      if (!acc) continue;
      let q = accounts.txCol(acc);
      if (input.from) q = q.where('date', '>=', String(input.from));
      if (input.till) q = q.where('date', '<=', String(input.till));
      const snap = await q.get();
      for (const d of snap.docs) {
        const t = d.data();
        const hay = [t.description, t.partnerName, t.note, t.ref, t.analyticName, t.company].join(' ').toLowerCase();
        if (words.length && !words.every(w => hay.includes(w))) continue;
        const amt = (t.debit || 0) || (t.credit || 0);
        if (input.minAmount != null && amt < input.minAmount) continue;
        if (input.maxAmount != null && amt > input.maxAmount) continue;
        const state = stateOf(t);
        if (input.waiting && state !== 'waiting') continue;
        out.push({ id: d.id, accountId: a.id, account: a.name, source: t.src || 'manual', state, date: t.date, out: money(t.debit || 0), in: money(t.credit || 0),
          description: short(t.description), partner: short(t.partnerName, 40), project: short(t.analyticName, 40),
          company: short(t.company, 30), note: short(t.note, 80),
          odoo: (t.bookedMove && (t.bookedMove.name || t.bookedMove.ref)) || (t.booked && t.booked.move) || '',
          counted: !t.excluded });
      }
    }
    out.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    return { found: out.length, shown: Math.min(out.length, limit), lines: out.slice(0, limit),
      total: { out: money(out.reduce((s, x) => s + x.out, 0)), in: money(out.reduce((s, x) => s + x.in, 0)) } };
  }

  // ── Mario only from here ──
  if (!access.admin || access.readOnly) return { error: 'not allowed for this person' };

  if (name === 'lookup_refs') {
    const refs = await odooRefs(ctx);
    const pick = (list, q, n = 8) => {
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const score = x => words.reduce((s, w) => s + (x.name.toLowerCase().includes(w) ? 1 : 0), 0);
      return list.map(x => ({ ...x, s: score(x) })).filter(x => x.s).sort((a, b) => b.s - a.s || a.name.length - b.name.length).slice(0, n).map(x => ({ id: x.id, name: x.name }));
    };
    return { partners: pick(refs.partners, input.partner), projects: pick(refs.analytics, input.project), companies: input.company ? pick(refs.companies, input.company) : refs.companies };
  }

  if (name === 'propose_line') {
    const a = allowed.find(x => x.id === input.accountId);
    if (!a) return { error: 'no such ledger' };
    const acc = await accounts.resolve(ws, a.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))) return { error: 'date must be yyyy-mm-dd' };
    const amount = money(input.amount);
    if (!(amount > 0)) return { error: 'amount must be above zero' };
    const id = 'ask-' + newId();
    const by = access.email || 'mario';
    // the same shape site.js writeLine gives a WhatsApp receipt: a proposal, excluded until the ✓
    const t = { id, src: 'site', via: 'ask', date: String(input.date), ref: '', service: 'Ask',
      description: short(input.description, 160),
      debit: input.side === 'out' ? amount : 0, credit: input.side === 'in' ? amount : 0,
      analyticId: input.analyticId || null, analyticName: short(input.analyticName || '', 80), analyticSrc: input.analyticName ? 'ask' : '',
      partnerId: input.partnerId || null, partnerName: short(input.partnerName || '', 80), partnerSrc: input.partnerName ? 'ask' : '',
      company: input.company || '', companySrc: input.company ? 'ask' : '',
      note: short(input.note || '', 300), noteSrc: input.note ? 'ask' : '',
      review: true, excluded: true, waAccepted: false, waFrom: 'mario', waAt: nowIso(),
      docs: [], createdAt: nowIso(), createdBy: by, updatedAt: nowIso(), updatedBy: by };
    await accounts.txCol(acc).doc(id).set(t);
    return { ok: true, txId: id, account: a.name, state: 'waiting for ✓', where: `/accounting/accounts#${a.id}` };
  }

  if (name === 'fill_line') {
    const a = allowed.find(x => x.id === input.accountId);
    if (!a) return { error: 'no such ledger' };
    const acc = await accounts.resolve(ws, a.id);
    const ref = accounts.txCol(acc).doc(String(input.txId || ''));
    const cur = (await ref.get()).data();
    if (!cur) return { error: 'no such line' };
    if (cur.bookedMove) return { error: 'this line is already in Odoo — change it on the grid' };
    if (cur.waAccepted) return { error: 'this line is already accepted — change it on the grid' };
    if (cur.src === 'odoo') return { error: 'an Odoo mirror line cannot be edited' };
    const d = {};
    if (input.description) d.description = short(input.description, 160);
    if (input.partnerName) { d.partnerName = short(input.partnerName, 80); d.partnerId = input.partnerId || null; d.partnerSrc = 'ask'; }
    if (input.analyticName) { d.analyticName = short(input.analyticName, 80); d.analyticId = input.analyticId || null; d.analyticSrc = 'ask'; }
    if (input.company) { d.company = input.company; d.companySrc = 'ask'; }
    if (input.note) { d.note = short(input.note, 300); d.noteSrc = 'ask'; }
    if (!Object.keys(d).length) return { error: 'nothing to fill' };
    d.updatedAt = nowIso(); d.updatedBy = (access.email || 'mario') + ' via Ask';
    await ref.set(d, { merge: true });
    return { ok: true, txId: cur.id || input.txId, filled: Object.keys(d).filter(k => !/At$|By$|Src$/.test(k)), state: 'still waiting for ✓' };
  }

  if (name === 'dev_request') {
    const title = short(input.title, 140), prompt = String(input.prompt || '').slice(0, 6000);
    if (!title || !prompt) return { error: 'title and prompt are needed' };
    const id = newId();
    const page = short(input.page || ctx.page || '', 80);
    const asked = (ctx.history || []).filter(m => m.role === 'user').map(m => m.content).slice(-3).join('\n---\n').slice(0, 3000);
    await ctx.ws.collection('devRequests').doc(id).set({ id, title, prompt, page, asked, status: 'open', createdAt: nowIso(), createdBy: access.email || 'mario', updatedAt: nowIso() });
    return { ok: true, id, where: '/dev', note: 'queued for Claude Code — Mario runs it from VS Code when the laptop is on' };
  }
  return { error: 'no such tool' };
}

// partners / projects / companies from Odoo, cached ten minutes (the same lists the line sheet offers)
let refCache = { at: 0, analytics: [], partners: [], companies: [] };
async function odooRefs(ctx) {
  if (Date.now() - refCache.at < 600e3) return refCache;
  if (!ctx.odooCall) return refCache;
  const [analytics, partners, companies] = await Promise.all([
    ctx.odooCall('account.analytic.account', 'search_read', [[['active', '=', true]]], { fields: ['name'], context: CTX, limit: 500 }),
    ctx.odooCall('res.partner', 'search_read', [[['supplier_rank', '>', 0]]], { fields: ['name'], context: CTX, limit: 2000 }),
    ctx.odooCall('res.company', 'search_read', [[]], { fields: ['name'], context: CTX, limit: 20 }),
  ]);
  refCache = { at: Date.now(), analytics, partners, companies };
  return refCache;
}

// ── the loop: Claude asks for a tool, we run it, until it answers ────────────────────────────
async function ask(ctx, body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('no Anthropic key on this hub'); e.status = 503; throw e; }
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length) { const e = new Error('nothing to answer'); e.status = 400; throw e; }
  const mario = !!ctx.access.admin && !ctx.access.readOnly;
  ctx.page = body.page; ctx.history = history;
  const where = body.page ? `\n\nThe person is looking at ${String(body.page).slice(0, 120)} in the hub.` : '';
  // what the page itself says is open (site: the chat and the day; accounts: the ledger) — sent by the browser
  const open = body.context && typeof body.context === 'object' ? `\nOpen on that page: ${JSON.stringify(body.context).slice(0, 1500)}` : '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const system = [
    SYSTEM, mario ? ADMIN_NOTE : READ_ONLY_NOTE,
    mario && shiftContext() ? '\n## About Shift (SHIFT.md)\n' + shiftContext() : '',
    where + open, `Today is ${today} (Beirut).`,
    `Signed in: ${ctx.access.email || 'someone'}${ctx.access.admin ? ' (admin — sees every ledger)' : ctx.access.account ? ' (sees only the ledger ' + ctx.access.account + ')' : ''}.`,
  ].filter(Boolean).join('\n');
  const tools = mario ? READ_TOOLS.concat(ADMIN_TOOLS) : READ_TOOLS;
  const messages = history.slice();
  const used = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools, messages }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('anthropic ' + r.status)); e.status = 502; throw e; }
    const calls = (j.content || []).filter(c => c.type === 'tool_use');
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!calls.length) return { answer: text || 'I could not find that in the hub.', used };
    messages.push({ role: 'assistant', content: j.content });
    const results = [];
    for (const c of calls) {
      let out;
      try { out = await runTool(ctx, c.name, c.input || {}); }
      catch (e) { out = { error: String(e.message || e).slice(0, 200) }; }
      used.push({ tool: c.name, input: c.input || {}, ok: !(out && out.error), id: out && (out.txId || out.id) || undefined });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 60000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That needed more looking up than I am allowed in one go — ask it a narrower way.', used };
}

module.exports = { ask, TOOLS: READ_TOOLS, ADMIN_TOOLS };
