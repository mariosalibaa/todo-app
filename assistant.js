// ── Ask: the hub's own assistant ─────────────────────────────────────────────────────────────
// Mario, 2026-09-26: a chat box everywhere in the hub, for us and for whoever buys this later.
// It is NOT Claude Code and it never touches the code: the browser talks to /api/assistant, the
// server holds the key, and Claude may only call the few read-only tools written below. Each tool
// runs as the signed-in person — a worker sees his own ledger and nothing else — and every answer
// says which tools were used, so nothing happens invisibly.
//
// v1 (read-only): list_accounts · account_balance · find_lines.
// Writing anything stays where it already is: the accounts grid, the site chat, the statement round.
const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-5';
const MAX_ROUNDS = 4;            // tool → answer → tool …, then it must speak
const MAX_LINES = 60;            // rows handed back to Claude in one go

const money = n => Math.round((+n || 0) * 100) / 100;
const short = (s, n = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

const TOOLS = [
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
    description: 'Search the ledger lines: by words in the description, partner or note, by account, by date range, by amount. Returns the matching lines, newest first. Each line carries its source: a line with source "odoo" is the same purchase read back from Odoo and matched onto a hub line — never add it to the hub line, or the money is counted twice. counted:false means the line does not move the balance.',
    input_schema: { type: 'object', properties: {
      q: { type: 'string', description: 'words to look for (description, partner, note, reference)' },
      accountId: { type: 'string', description: 'limit to one ledger' },
      from: { type: 'string', description: 'yyyy-mm-dd' },
      till: { type: 'string', description: 'yyyy-mm-dd' },
      minAmount: { type: 'number' }, maxAmount: { type: 'number' },
      limit: { type: 'number', description: 'default 30, at most 60' },
    } },
  },
];

const SYSTEM = [
  'You are the assistant inside Shift Hub, the accounting and site hub of Shift Group (steel structures, solar systems, engineering) and Shift Development (villas) in Lebanon.',
  'You answer about what is in the hub: the cash and bank ledgers, who was paid, what a project cost, what is still waiting to be booked in Odoo.',
  'Use the tools to look things up — never guess a figure, and never invent an account, a partner or a date. If the tools do not hold the answer, say so plainly.',
  'You are read-only: you cannot change a line, book anything in Odoo or send a message. When someone asks for that, say where in the hub it is done (the accounts grid, the site chat, the statement round) instead of pretending.',
  'Money is USD unless the ledger says otherwise. Dates are Beirut time, written yyyy-mm-dd.',
  'Answer in a few short lines of plain text. No markdown: no tables, no pipes, no ** — the chat box shows the characters as they are. Several figures go one per line, like "Mario cash: -2,746.92 USD". No preamble, no closing question.',
].join('\n');

// ── the tools, each already scoped to this person ────────────────────────────────────────────
async function runTool(ctx, name, input) {
  const { accounts, ws, access } = ctx;
  const mine = access.admin ? null : (access.account || '');          // a worker sees his own ledger only
  const all = await accounts.listAccounts(ws);
  const allowed = all.filter(a => !mine || a.id === mine);

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
        out.push({ account: a.name, source: t.src || 'manual', date: t.date, out: money(t.debit || 0), in: money(t.credit || 0),
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
  return { error: 'no such tool' };
}

// ── the loop: Claude asks for a tool, we run it, until it answers ────────────────────────────
async function ask(ctx, body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('no Anthropic key on this hub'); e.status = 503; throw e; }
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length) { const e = new Error('nothing to answer'); e.status = 400; throw e; }
  const where = body.page ? `\n\nThe person is looking at ${String(body.page).slice(0, 120)} in the hub.` : '';
  const system = SYSTEM + where + `\n\nSigned in: ${ctx.access.email || 'someone'}${ctx.access.admin ? ' (admin — sees every ledger)' : ctx.access.account ? ' (sees only the ledger ' + ctx.access.account + ')' : ''}.`;
  const messages = history.slice();
  const used = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools: TOOLS, messages }),
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
      used.push({ tool: c.name, input: c.input || {} });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 60000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That needed more looking up than I am allowed in one go — ask it a narrower way.', used };
}

module.exports = { ask, TOOLS };
