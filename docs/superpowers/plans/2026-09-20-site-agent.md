# Shift agent in the site chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Shift" member in the hub site chat (hub.shift-group.co/site) that answers Mario from Odoo + hub data and drafts three kinds of actions (Odoo payment, worker ledger line, to-do) that execute only after his ✓ on a card in the chat.

**Architecture:** The hub (Vercel, `D:\vscode\todo`) stores Mario's post, forwards it to the Render service `shift-hub` (`D:\vscode\shift-hub`), and gets replies back through machine routes (`/api/site/agent/reply|done|settle|exec`). Render reuses the Telegram agent's Claude tool-use loop (`bots/agent/agent.mjs`) with two additions: session-scoped extra tools (the two hub writes) and an `onPending` hook that turns a held write batch into an action card instead of a "reply ✅" text. Cards carry their full write payload, so ✓ works after a Render restart.

**Tech Stack:** Node 20, plain `http` (both repos), Firestore (hub), Anthropic Messages API tool-use (Render, model `claude-sonnet-4-6`), `node --test`, Playwright via `verify-hub.mjs`.

Spec: `docs/superpowers/specs/2026-09-20-site-agent-design.md`.

## Global Constraints

- Users: **Mario only** (`access.admin` / `post.byAdmin`). A non-admin `@shift` is ignored silently.
- Agent identity: thread id **`shift`**, display name **"Shift"**, every agent post has `by: 'shift'`.
- Trigger: post in thread `shift`, or text starting with `@shift` / `@s` (case-insensitive) in any thread.
- Gated writes only: `odoo_register_payment` (+ the generic Odoo write tools already in `tools.mjs`), `hub_worker_line`, `hub_todo`. Nothing is written without ✓.
- Hub worker lines from the agent: `src: 'agent'`, `review: true`, `excluded: true` (they join the statement-round ✓ queue).
- Hub dates: Beirut local (`toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' })`), never `toISOString().slice(0,10)` in browser code.
- Env — Vercel: `SITE_AGENT_URL`, `SITE_AGENT_SECRET`, existing `ACCOUNTING_API_KEY` (reused as the machine key). Render: `HUB_URL`, `HUB_MACHINE_KEY` (= hub `ACCOUNTING_API_KEY`), `SITE_AGENT_SECRET`; `ANTHROPIC_KEY`/`ODOO_*` already there. Model override `AGENT_MODEL`.
- Timeouts: hub waits ≤ 25 s for Render's **ack** (202); the turn itself runs after the ack. Front end polls every 2 s for ≤ 60 s.
- Commit rule: `D:\vscode\todo` — never two Claude sessions committing at once; `cd /d/vscode/todo` in the same command as any git/vercel call. Both repos: commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Deploy: Render = `git push origin main` in `D:\vscode\shift-hub` then check `GET https://shift-hub.onrender.com/`; hub = `hub-verify` skill first, then `cd /d/vscode/todo && npx vercel deploy --prod --yes`.
- Deleting Odoo entries (the $1 test payment) waits for Mario's explicit ok.
- Untracked `_abed-*.mjs` scratch files in `todo` belong to another session — never `git add .`; add files by name.

## File structure

**Render — `D:\vscode\shift-hub`**
| file | responsibility |
|---|---|
| Modify `bots/agent/agent.mjs` | session-scoped `extraTools` (with `write` flag), `systemExtra`, `runExtra`, `onPending`; export `applyWrites`, `isConfirm`, `isNo` |
| Create `bots/agent-site/card.mjs` | pure: `cardFromWrites`, `receiptOf`, `checkBearer`, `systemExtra`, `userContent` |
| Create `bots/agent-site/hub.mjs` | hub machine-route client: `reply`, `done`, `settle`, `exec` |
| Create `bots/agent-site/hub-tools.mjs` | `HUB_TOOLS` defs (`hub_worker_line`, `hub_todo`) + `runHubTool` |
| Create `bots/agent-site/run.mjs` | `makeRunner` → `ask(body)`, `confirm(body)`; per-thread session + queue |
| Create `bots/agent-site/server.mjs` | `agentSite` handler: bearer, `POST /site-agent`, `POST /site-agent/confirm`, ack-then-run |
| Create `bots/agent-site/local.mjs` | terminal harness with an in-process mock hub |
| Create `test/*.test.js` | node:test |
| Modify `server.mjs`, `package.json`, `README.md` | load + route the new handler; `npm test`; docs |

**Hub — `D:\vscode\todo`**
| file | responsibility |
|---|---|
| Create `site-agent.js` | trigger detection, context, `/ask`, `/confirm`, machine routes `reply/done/settle/exec`, `todoDoc` |
| Modify `site.js` | `shift` thread for admins, mount site-agent first, `writeLine` src override + export, agent-aware `/digest`, preview for action posts |
| Modify `server.js` | machine bearer opens `/api/site/agent/*` as `{ agent: true }` |
| Modify `site.html` | Shift row, agent bubbles, action cards, ask/poll/confirm, `?demo=agent` fixture |
| Create `test/site-agent.test.js` | node:test for the pure parts |

---

### Task 1: agent.mjs — session-scoped tools and the `onPending` hook

**Files:**
- Modify: `D:\vscode\shift-hub\bots\agent\agent.mjs` (lines 96–107 `callClaude`, 134–135 `isConfirm`/`isNo`, 182–260 `resolvePending`/`runLoop`)
- Test: `D:\vscode\shift-hub\test\agent-session.test.js`

**Interfaces:**
- Produces (used by Task 4): `getSession(key)` (exists) whose object may carry `extraTools: [{...anthropicToolDef, write?: true}]`, `systemExtra: string`, `runExtra: async (name, input) => string`, `onPending: async (writeBlocks, text) => void`, `_apiKey`; `export async function applyWrites(session, writes, approve, feedback, send) → [{ name, ok, out?, error? }]`; `export const isConfirm`, `export const isNo`.
- Telegram behaviour unchanged when none of the new session fields are set.

- [ ] **Step 1: Write the failing test**

```js
// D:\vscode\shift-hub\test\agent-session.test.js
// node --test test/agent-session.test.js — needs ~/.odoo-creds.json (agent.mjs imports the Odoo client)
import test from "node:test";
import assert from "node:assert";
import { getSession, applyWrites, isConfirm, isNo } from "../bots/agent/agent.mjs";

test("applyWrites runs extra tools through session.runExtra and reports receipts", async () => {
  const s = getSession("t:extra");
  s.extraTools = [{ name: "hub_todo", write: true, description: "x", input_schema: { type: "object", properties: {} } }];
  const calls = [];
  s.runExtra = async (name, input) => { calls.push([name, input]); return JSON.stringify({ ok: true, receipt: "to-do t1" }); };
  const sent = [];
  const receipts = await applyWrites(s, [{ id: "tu_1", name: "hub_todo", input: { title: "call Roger" } }], true, "", async (t) => sent.push(t));
  assert.deepStrictEqual(calls, [["hub_todo", { title: "call Roger" }]]);
  assert.strictEqual(receipts.length, 1); assert.strictEqual(receipts[0].ok, true);
  assert.strictEqual(sent.length, 0, "no session.pending → no loop continuation → nothing sent");
});

test("applyWrites with approve=false runs nothing", async () => {
  const s = getSession("t:decline");
  s.extraTools = [{ name: "hub_todo", write: true, description: "x", input_schema: { type: "object", properties: {} } }];
  let ran = 0; s.runExtra = async () => { ran++; return "{}"; };
  const receipts = await applyWrites(s, [{ id: "tu_2", name: "hub_todo", input: {} }], false, "declined", async () => {});
  assert.strictEqual(ran, 0); assert.deepStrictEqual(receipts, []);
});

test("confirm / no vocabulary is exported", () => {
  assert.ok(isConfirm("yes")); assert.ok(isConfirm("تمام")); assert.ok(isNo("no")); assert.ok(!isConfirm("add 40$ diesel"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /d/vscode/shift-hub && node --test test/agent-session.test.js`
Expected: FAIL — `does not provide an export named 'applyWrites'`.

- [ ] **Step 3: Implement**

(a) Replace `callClaude` (lines 96–107):

```js
// ---- Anthropic call (tool-use). A session may add tools (hub writes) and prompt text. ----
const toolDefs = (session) => [...TOOLS, ...(session?.extraTools || []).map(({ write, ...t }) => t)];
async function callClaude(messages, apiKey, session) {
  const system = SYSTEM() + (session?.systemExtra ? "\n\n" + session.systemExtra : "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, system, tools: toolDefs(session), messages: trimHistory(messages) }),
  });
  const data = await res.json();
  if (data.type === "error") throw new Error(`Anthropic: ${data.error?.message || JSON.stringify(data)}`);
  if (!data.content) throw new Error(`Anthropic: unexpected response ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// A session's extra tools run through its own runner; everything else is an Odoo tool.
const isExtra = (session, name) => (session?.extraTools || []).some((t) => t.name === name);
const isWriteFor = (session, name) => isWrite(name) || (session?.extraTools || []).some((t) => t.name === name && t.write);
const runFor = (session, name, input) => (isExtra(session, name) && session.runExtra) ? session.runExtra(name, input) : runTool(name, input);
```

(b) Line 134–135: `const isConfirm` → `export const isConfirm`; `const isNo` → `export const isNo`.

(c) `resolvePending` line 191: `runTool(w.name, w.input)` → `runFor(session, w.name, w.input)`.

(d) `runLoop`: line 214 `callClaude(session.messages, apiKey)` → `callClaude(session.messages, apiKey, session)`; lines 225–226 `isWrite(b.name)` → `isWriteFor(session, b.name)` (both); line 231 `runTool(r.name, r.input)` → `runFor(session, r.name, r.input)`. Replace the `if (writeBlocks.length) {` block (lines 235–253) with:

```js
    if (writeBlocks.length) {
      if (text) await send(text);
      session.pending = { readResults, writeBlocks };
      // the hub draws a card with ✓/✗ — no "reply ✅" prompt there
      if (session.onPending) { await session.onPending(writeBlocks, text); return; }

      // For multiple writes, use "confirm & post?" format with summary
      if (writeBlocks.length > 1) {
        const summaries = writeBlocks
          .map((w) => w.input.summary || describeWrite(w.name, w.input))
          .join("\n• ");
        await send(`✅ Summary:\n• ${summaries}\n\nConfirm & post? Reply ✅ to apply, ❌ to cancel, or tell me what to change.`);
      } else {
        const line = describeWrite(writeBlocks[0].name, writeBlocks[0].input);
        await send(`⚠️ Proposed change:\n• ${line}\n\nReply ✅ to apply, ❌ to cancel, or tell me what to change.`);
      }
      return;
    }
```

(e) Add after `resolvePending`, before `runLoop`:

```js
// Apply (or decline) a write batch given by the CALLER — the hub's action card carries the
// writes, so this works after a restart emptied the session. When the session still holds the
// same pending batch, the results are fed back and the loop continues (Claude says "done").
export async function applyWrites(session, writes, approve, feedback, send) {
  const results = [], receipts = [];
  for (const w of writes) {
    if (!approve) { results.push(toolResult(w.id, feedback)); continue; }
    try { const out = await runFor(session, w.name, w.input); results.push(toolResult(w.id, out)); receipts.push({ name: w.name, ok: true, out }); }
    catch (e) { results.push(toolResult(w.id, `ERROR: ${e.message}`, true)); receipts.push({ name: w.name, ok: false, error: e.message }); }
  }
  const p = session.pending;
  const same = p && p.writeBlocks.length === writes.length && p.writeBlocks.every((b, i) => b.id === writes[i].id);
  if (same && session._apiKey) {
    session.pending = null;
    session.messages.push({ role: "user", content: [...p.readResults, ...results] });
    await runLoop(session, send);
  }
  return receipts;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /d/vscode/shift-hub && node --test test/agent-session.test.js` → `pass 3`.

- [ ] **Step 5: Commit**

```bash
cd /d/vscode/shift-hub && git add bots/agent/agent.mjs test/agent-session.test.js && git commit -m "agent: session-scoped extra tools, onPending hook, applyWrites for caller-held write batches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: card.mjs — the pure helpers

**Files:**
- Create: `D:\vscode\shift-hub\bots\agent-site\card.mjs`
- Test: `D:\vscode\shift-hub\test\agent-site.test.js`

**Interfaces:**
- Produces: `cardFromWrites(writeBlocks) → { summary, detail, writes: [{ id, name, input }] }`; `receiptOf(name, outJson) → string`; `checkBearer(req, secret) → boolean`; `systemExtra(ctx) → string`; `userContent(ctx) → string` where `ctx = { thread, postId, text, date, context: string[], ledger: { current: {id,name,owner,odooPartnerId}|null, people: [...] } }` (the body the hub sends, Task 8).

- [ ] **Step 1: Write the failing test**

```js
// D:\vscode\shift-hub\test\agent-site.test.js
import test from "node:test";
import assert from "node:assert";
import { cardFromWrites, receiptOf, checkBearer, systemExtra, userContent } from "../bots/agent-site/card.mjs";

const ledger = { current: { id: "georges", name: "Georges", owner: "georges", odooPartnerId: 77 }, people: [{ id: "georges", name: "Georges", odooPartnerId: 77 }, { id: "abed", name: "Abed", odooPartnerId: null }] };

test("cardFromWrites: one write = its summary; several = first + count, all in detail", () => {
  const one = cardFromWrites([{ id: "a", name: "hub_todo", input: { title: "x", summary: "To-do: call Roger" } }]);
  assert.strictEqual(one.summary, "To-do: call Roger");
  assert.deepStrictEqual(one.writes, [{ id: "a", name: "hub_todo", input: { title: "x", summary: "To-do: call Roger" } }]);
  const two = cardFromWrites([{ id: "a", name: "odoo_create", input: { summary: "Bill ATTAL $120" } }, { id: "b", name: "odoo_call", input: { summary: "Post it" } }]);
  assert.strictEqual(two.summary, "Bill ATTAL $120 (+1 more)");
  assert.match(two.detail, /1\. Bill ATTAL \$120\n2\. Post it/);
});

test("receiptOf reads the tool output", () => {
  assert.strictEqual(receiptOf("hub_todo", JSON.stringify({ ok: true, receipt: "to-do ag-1: call Roger", url: "https://hub/todo" })), "to-do ag-1: call Roger https://hub/todo");
  assert.strictEqual(receiptOf("odoo_register_payment", JSON.stringify({ ok: true, paid_bill: 1234, result: [567] })), "paid bill 1234 → payment [567]");
  assert.strictEqual(receiptOf("odoo_create", JSON.stringify({ ok: true, created_id: 9, model: "account.move" })), "account.move #9");
  assert.strictEqual(receiptOf("odoo_call", "not json"), "odoo_call done");
});

test("checkBearer", () => {
  const req = (a) => ({ headers: a ? { authorization: a } : {} });
  assert.ok(checkBearer(req("Bearer 0123456789abcdef"), "0123456789abcdef"));
  assert.ok(!checkBearer(req("Bearer wrong-wrong-wrong"), "0123456789abcdef"));
  assert.ok(!checkBearer(req(), "0123456789abcdef"));
  assert.ok(!checkBearer(req("Bearer short"), "short"), "a short secret never opens");
});

test("systemExtra names the ledgers and the current worker", () => {
  const s = systemExtra({ thread: "georges", ledger });
  assert.match(s, /georges → Georges \(Odoo partner 77\)/);
  assert.match(s, /abed → Abed/);
  assert.match(s, /This is Georges's chat/);
  assert.match(systemExtra({ thread: "shift", ledger: { current: null, people: [] } }), /Shift thread/);
});

test("userContent carries the thread, the recent lines and the question", () => {
  const u = userContent({ thread: "georges", date: "2026-09-20", text: "how much does he owe", context: ["2026-09-19 Georges: 40$ diesel"], ledger });
  assert.match(u, /\[thread: georges — Georges's chat; date 2026-09-20\]/);
  assert.match(u, /2026-09-19 Georges: 40\$ diesel/);
  assert.match(u, /Mario says: how much does he owe$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /d/vscode/shift-hub && node --test test/agent-site.test.js` → FAIL, `Cannot find module '.../card.mjs'`.

- [ ] **Step 3: Implement**

```js
// D:\vscode\shift-hub\bots\agent-site\card.mjs
// The pure parts of the site agent: the action card the hub draws, the receipt line after ✓,
// the bearer check, and the two prompt pieces. No I/O here so it tests without creds.

// A held write batch → the card the hub draws (summary line, numbered detail, the writes verbatim
// so ✓ can execute them even after a Render restart emptied the session).
export function cardFromWrites(writeBlocks) {
  const lines = writeBlocks.map((w) => w.input?.summary || `${w.name} ${JSON.stringify(w.input)}`);
  return {
    summary: lines[0] + (lines.length > 1 ? ` (+${lines.length - 1} more)` : ""),
    detail: lines.map((l, i) => `${i + 1}. ${l}`).join("\n"),
    writes: writeBlocks.map((w) => ({ id: w.id, name: w.name, input: w.input })),
  };
}

// One short line per executed write, for the card's receipt.
export function receiptOf(name, outJson) {
  let o; try { o = JSON.parse(outJson); } catch { return `${name} done`; }
  if (o.receipt) return [o.receipt, o.url].filter(Boolean).join(" ");
  if (name === "odoo_register_payment") return `paid bill ${o.paid_bill} → payment ${JSON.stringify(o.result)}`;
  if (name === "odoo_create") return `${o.model} #${o.created_id}`;
  if (name === "odoo_write") return `${o.model} ${JSON.stringify(o.ids)} updated`;
  return `${name} done`;
}

export function checkBearer(req, secret) {
  const b = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return !!secret && secret.length >= 16 && b === secret;
}

// Appended to the Telegram agent's system prompt (all the Odoo ids live there).
export function systemExtra(ctx) {
  const people = ctx.ledger?.people || [];
  const cur = ctx.ledger?.current || null;
  return `SITE CHAT MODE
You are "Shift", a member of the Shift hub site chat (hub.shift-group.co/site), talking to Mario on his phone. Keep answers short — a few plain lines, no markdown tables, no headings.
The hub draws every write as a CARD with ✓ / ✗ buttons. Never ask him to "reply ✅" and never explain how to confirm: say in one line what you will do, then call the write tool(s).
Two hub tools exist beside the Odoo ones:
- hub_worker_line — a line on a worker's cash ledger in the hub (NOT an Odoo bill). Use it for "add X to Georges", "Abed spent…", "I gave Khoder…", diesel, hours, small purchases. side=debit when Shift owes the worker (he spent or worked), side=credit when the worker received money from Mario.
- hub_todo — a task in the hub To-Do app: reminders, "remind me", "task for Christa".
Use odoo_register_payment only to pay an existing Odoo vendor bill. Never create vendors, analytic accounts or Odoo bills from this chat unless Mario says so explicitly.
LEDGERS (hub account id → worker): ${people.map((p) => `${p.id} → ${p.name}${p.odooPartnerId ? ` (Odoo partner ${p.odooPartnerId})` : ""}`).join("; ") || "(none)"}.
${cur ? `This is ${cur.name}'s chat: "he", "him", "his" mean ${cur.name}; his ledger is ${cur.id}.` : `This is the Shift thread: name the worker when a ledger is needed; ask in one line if unclear.`}
When you cannot tell which worker, ledger, bill or amount is meant, ask in one line instead of guessing.`;
}

// The user turn: where we are, what was said lately, what Mario asks now.
export function userContent(ctx) {
  const cur = ctx.ledger?.current;
  const head = `[thread: ${ctx.thread}${cur ? ` — ${cur.name}'s chat` : ""}; date ${ctx.date}]`;
  const recent = (ctx.context || []).join("\n") || "(none)";
  return `${head}\nRecent messages:\n${recent}\n\nMario says: ${ctx.text}`;
}
```

- [ ] **Step 4: Run** → `pass 5`.

- [ ] **Step 5: Commit**

```bash
cd /d/vscode/shift-hub && git add bots/agent-site/card.mjs test/agent-site.test.js && git commit -m "agent-site: card, receipt, bearer and prompt helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: hub.mjs + hub-tools.mjs — the hub client and the two hub write tools

**Files:**
- Create: `D:\vscode\shift-hub\bots\agent-site\hub.mjs`, `D:\vscode\shift-hub\bots\agent-site\hub-tools.mjs`
- Test: append to `D:\vscode\shift-hub\test\agent-site.test.js`

**Interfaces:**
- Produces: `makeHub({ url, key }) → { reply(thread, body), done(thread, postId), settle(thread, postId, body), exec(write, postId) }` — every call `POST ${url}/api/site/agent/<name>` with `Authorization: Bearer <key>`, resolves the JSON, throws `hub /path <status>: <error>` on non-2xx.
- Produces: `HUB_TOOLS` (two Anthropic tool defs with `write: true`), `isHubTool(name)`, `runHubTool(hub, name, input, postId) → string`.
- Consumes (Task 8): hub exec reply `{ ok: true, receipt, url }` or `{ error }`.

- [ ] **Step 1: Write the failing test** (append)

```js
import http from "node:http";
import { makeHub } from "../bots/agent-site/hub.mjs";
import { HUB_TOOLS, isHubTool, runHubTool } from "../bots/agent-site/hub-tools.mjs";

// a hub that records what it was asked and answers like the real machine routes
function mockHub(answer) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(answer.status || 200, { "content-type": "application/json" }); res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() })));
}

test("makeHub posts JSON with the bearer to the machine routes", async () => {
  const m = await mockHub({ body: { id: "p1" } });
  try {
    const hub = makeHub({ url: m.url + "/", key: "k".repeat(40) });
    const r = await hub.reply("georges", { kind: "text", text: "hi", replyTo: "q1" });
    assert.deepStrictEqual(r, { id: "p1" });
    assert.strictEqual(m.calls[0].path, "/api/site/agent/reply");
    assert.strictEqual(m.calls[0].auth, "Bearer " + "k".repeat(40));
    assert.deepStrictEqual(m.calls[0].body, { thread: "georges", kind: "text", text: "hi", replyTo: "q1" });
    await hub.done("georges", "q1"); await hub.settle("georges", "c1", { status: "done", receipt: "r" }); await hub.exec({ name: "hub_todo", input: {} }, "c1");
    assert.deepStrictEqual(m.calls.map((c) => c.path), ["/api/site/agent/reply", "/api/site/agent/done", "/api/site/agent/settle", "/api/site/agent/exec"]);
  } finally { m.close(); }
});

test("makeHub throws on a non-2xx with the hub's error", async () => {
  const m = await mockHub({ status: 400, body: { error: "a title is needed" } });
  try { await assert.rejects(makeHub({ url: m.url, key: "k".repeat(40) }).exec({ name: "hub_todo", input: {} }, "c"), /hub \/api\/site\/agent\/exec 400: a title is needed/); }
  finally { m.close(); }
});

test("runHubTool returns the exec reply as JSON text", async () => {
  const m = await mockHub({ body: { ok: true, receipt: "to-do ag-1: call Roger", url: "https://hub/todo" } });
  try {
    const out = await runHubTool(makeHub({ url: m.url, key: "k".repeat(40) }), "hub_todo", { title: "call Roger" }, "card9");
    assert.deepStrictEqual(JSON.parse(out), { ok: true, receipt: "to-do ag-1: call Roger", url: "https://hub/todo" });
    assert.deepStrictEqual(m.calls[0].body, { write: { name: "hub_todo", input: { title: "call Roger" } }, postId: "card9" });
  } finally { m.close(); }
});

test("HUB_TOOLS are writes with summaries", () => {
  assert.deepStrictEqual(HUB_TOOLS.map((t) => t.name), ["hub_worker_line", "hub_todo"]);
  assert.ok(HUB_TOOLS.every((t) => t.write === true && t.input_schema.required.includes("summary")));
  assert.ok(isHubTool("hub_todo")); assert.ok(!isHubTool("odoo_create"));
});
```

- [ ] **Step 2: Run** → FAIL, `Cannot find module '.../hub.mjs'`.

- [ ] **Step 3: Implement**

```js
// D:\vscode\shift-hub\bots\agent-site\hub.mjs
// The hub as the agent sees it: four machine routes on hub.shift-group.co, all opened by
// "Authorization: Bearer $HUB_MACHINE_KEY" (= the hub's ACCOUNTING_API_KEY).
export function makeHub({ url = process.env.HUB_URL, key = process.env.HUB_MACHINE_KEY } = {}) {
  if (!url || !key) throw new Error("HUB_URL and HUB_MACHINE_KEY are required");
  const base = url.replace(/\/+$/, "");
  async function post(path, body) {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`hub ${path} ${r.status}: ${data.error || ""}`.trim());
    return data;
  }
  return {
    reply: (thread, body) => post("/api/site/agent/reply", { thread, ...body }),          // a text or action post by "shift"
    done: (thread, postId) => post("/api/site/agent/done", { thread, postId }),           // the asked post is answered
    settle: (thread, postId, body) => post("/api/site/agent/settle", { thread, postId, ...body }),   // card → done / declined / error
    exec: (write, postId) => post("/api/site/agent/exec", { write, postId }),             // run a hub write (worker line, to-do)
  };
}
```

```js
// D:\vscode\shift-hub\bots\agent-site\hub-tools.mjs
// The two writes that live in the hub, not in Odoo. Both are gated like every other write
// (write: true) and execute through the hub's /api/site/agent/exec route.
export const HUB_TOOLS = [
  {
    name: "hub_worker_line", write: true,
    description:
      "Add a line on a worker's cash ledger in the Shift hub (Georges, Abed, Khoder, Ziad, Mitri…). WRITE — Mario confirms on a card. " +
      "The line joins the statement-round review queue; it is NOT an Odoo bill. side='debit' = Shift owes the worker (he spent or worked); " +
      "side='credit' = the worker received money from Mario. `account` is the ledger id from the LEDGERS list.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "hub ledger id, e.g. 'georges'" },
        date: { type: "string", description: "YYYY-MM-DD; default today (Beirut)" },
        description: { type: "string", description: "what it is, as Mario would write it on the sheet" },
        amount: { type: "number", description: "USD" },
        side: { type: "string", enum: ["debit", "credit"] },
        analytic: { type: "string", description: "project name as Mario says it (optional)" },
        nature: { type: "string", enum: ["labour", "expense", "vendor", "transfer"] },
        summary: { type: "string", description: "One short line for the card, e.g. 'Georges ledger: +$40 diesel, 20 Sep'" },
      },
      required: ["account", "description", "amount", "side", "summary"],
    },
  },
  {
    name: "hub_todo", write: true,
    description: "Create a task in the hub To-Do app. WRITE — Mario confirms on a card.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        assignee: { type: "string", description: "a person's name (optional)" },
        due: { type: "string", description: "YYYY-MM-DD (optional)" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        notes: { type: "string" },
        summary: { type: "string", description: "One short line for the card, e.g. 'To-do for Christa: send D3 drawings — due Mon'" },
      },
      required: ["title", "summary"],
    },
  },
];

export const isHubTool = (name) => HUB_TOOLS.some((t) => t.name === name);

// Returns the exec reply as text — the tool_result Claude reads, and what receiptOf parses.
export async function runHubTool(hub, name, input, postId) {
  return JSON.stringify(await hub.exec({ name, input }, postId));
}
```

- [ ] **Step 4: Run** → `pass 9`.

- [ ] **Step 5: Commit**

```bash
cd /d/vscode/shift-hub && git add bots/agent-site/hub.mjs bots/agent-site/hub-tools.mjs test/agent-site.test.js && git commit -m "agent-site: hub machine-route client and the two hub write tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: run.mjs — ask / confirm orchestration

**Files:**
- Create: `D:\vscode\shift-hub\bots\agent-site\run.mjs`
- Test: `D:\vscode\shift-hub\test\agent-site-run.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `makeRunner({ hub, apiKey, turn = handleTurn }) → { ask(body), confirm(body) }`.
  - `ask` body: `{ thread, postId, text, date, context, ledger }`; `confirm` body: `{ thread, postId, ok, note, writes, date, ledger }` (`postId` = the card).
- Behaviour: replies → `hub.reply(thread, { kind:'text', text, replyTo })`; a held batch → `hub.reply(thread, { kind:'action', action: card, replyTo })`; `ask` always ends with `hub.done`; `confirm` always ends with `hub.settle(thread, postId, { status, receipt?, error? })`. If a card is pending in the session and Mario types "yes"/"no" instead of tapping, it is routed as confirm/decline of that card; other text declines the card and is fed back as a correction. Turns on one thread run one at a time.

- [ ] **Step 1: Write the failing test**

```js
// D:\vscode\shift-hub\test\agent-site-run.test.js — needs ~/.odoo-creds.json (agent.mjs import). No network.
import test from "node:test";
import assert from "node:assert";
import { makeRunner } from "../bots/agent-site/run.mjs";
import { getSession } from "../bots/agent/agent.mjs";

function fakeHub() {
  const log = [];
  return { log,
    reply: async (thread, b) => { log.push(["reply", thread, b]); return { id: "card-" + log.length }; },
    done: async (thread, postId) => { log.push(["done", thread, postId]); },
    settle: async (thread, postId, b) => { log.push(["settle", thread, postId, b]); },
    exec: async (write, postId) => { log.push(["exec", write, postId]); return { ok: true, receipt: `did ${write.name}`, url: "https://hub/x" }; },
  };
}
const body = { thread: "georges", postId: "q1", text: "add 40$ diesel for him", date: "2026-09-20", context: [], ledger: { current: { id: "georges", name: "Georges" }, people: [{ id: "georges", name: "Georges" }] } };

test("ask: a text answer is relayed and the post is marked done", async () => {
  const hub = fakeHub();
  const turn = async (key, content, send) => { assert.match(content, /Mario says: add 40\$ diesel for him/); await send("Georges owes nothing"); };
  await makeRunner({ hub, apiKey: "k", turn }).ask(body);
  assert.deepStrictEqual(hub.log, [["reply", "georges", { kind: "text", text: "Georges owes nothing", replyTo: "q1" }], ["done", "georges", "q1"]]);
});

test("ask: a held write becomes an action card", async () => {
  const hub = fakeHub();
  const turn = async (key) => {
    const s = getSession(key);
    const writeBlocks = [{ id: "tu1", name: "hub_worker_line", input: { account: "georges", amount: 40, side: "debit", description: "diesel", summary: "Georges ledger: +$40 diesel" } }];
    s.pending = { readResults: [], writeBlocks };
    await s.onPending(writeBlocks, "");
  };
  await makeRunner({ hub, apiKey: "k", turn }).ask({ ...body, thread: "t-card" });
  const [kind, , b] = hub.log[0];
  assert.strictEqual(kind, "reply"); assert.strictEqual(b.kind, "action"); assert.strictEqual(b.action.summary, "Georges ledger: +$40 diesel");
  assert.strictEqual(b.action.writes[0].input.account, "georges");
  assert.deepStrictEqual(hub.log[1], ["done", "t-card", "q1"]);
});

test("confirm ok: executes the card's writes through the hub and settles done — with no session at all", async () => {
  const hub = fakeHub();
  const writes = [{ id: "tu9", name: "hub_todo", input: { title: "call Roger", summary: "To-do: call Roger" } }];
  await makeRunner({ hub, apiKey: "k", turn: async () => {} }).confirm({ thread: "t-fresh", postId: "card1", ok: true, writes, date: "2026-09-20", ledger: body.ledger });
  assert.deepStrictEqual(hub.log[0], ["exec", { name: "hub_todo", input: writes[0].input }, "card1"]);
  assert.deepStrictEqual(hub.log[1], ["settle", "t-fresh", "card1", { status: "done", receipt: "did hub_todo https://hub/x" }]);
});

test("confirm no: nothing runs, card settles declined", async () => {
  const hub = fakeHub();
  await makeRunner({ hub, apiKey: "k", turn: async () => {} }).confirm({ thread: "t-no", postId: "card2", ok: false, note: "", writes: [{ id: "x", name: "hub_todo", input: {} }], ledger: body.ledger });
  assert.deepStrictEqual(hub.log, [["settle", "t-no", "card2", { status: "declined" }]]);
});

test("confirm: a failing write settles error and keeps the message", async () => {
  const hub = fakeHub(); hub.exec = async () => { throw new Error("no such worker ledger: bob"); };
  await makeRunner({ hub, apiKey: "k", turn: async () => {} }).confirm({ thread: "t-err", postId: "card3", ok: true, writes: [{ id: "x", name: "hub_worker_line", input: { account: "bob" } }], ledger: body.ledger });
  assert.deepStrictEqual(hub.log, [["settle", "t-err", "card3", { status: "error", error: "no such worker ledger: bob" }]]);
});

test("ask while a card is pending: 'yes' typed in the chat confirms that card", async () => {
  const hub = fakeHub();
  const runner = makeRunner({ hub, apiKey: "k", turn: async (key) => {
    const s = getSession(key);
    const writeBlocks = [{ id: "tu5", name: "hub_todo", input: { title: "x", summary: "To-do: x" } }];
    s.pending = { readResults: [], writeBlocks }; await s.onPending(writeBlocks, "");
  } });
  await runner.ask({ ...body, thread: "t-yes" });            // → card-1
  await runner.ask({ ...body, thread: "t-yes", postId: "q2", text: "yes" });
  const exec = hub.log.find((l) => l[0] === "exec"); assert.ok(exec, "the typed yes executed the card");
  const settle = hub.log.find((l) => l[0] === "settle"); assert.strictEqual(settle[2], "card-1"); assert.strictEqual(settle[3].status, "done");
});
```

- [ ] **Step 2: Run** → FAIL, `Cannot find module '.../run.mjs'`.

- [ ] **Step 3: Implement**

```js
// D:\vscode\shift-hub\bots\agent-site\run.mjs
// One turn of the site agent: Mario's post comes in from the hub, Claude runs the same loop as the
// Telegram bot, texts go back as posts by "shift", a held write batch goes back as an action card.
// ✓ / ✗ on the card come back through confirm(). Sessions are per hub thread and run one at a time.
import { getSession, handleTurn, applyWrites, isConfirm, isNo } from "../agent/agent.mjs";
import { HUB_TOOLS, runHubTool } from "./hub-tools.mjs";
import { cardFromWrites, receiptOf, systemExtra, userContent } from "./card.mjs";

export function makeRunner({ hub, apiKey, turn = handleTurn }) {
  const key = (thread) => `site:${thread}`;

  // the session pieces the loop reads; re-applied every turn so a restart-fresh session works too
  function prime(session, body, postId) {
    session.extraTools = HUB_TOOLS;
    session.systemExtra = systemExtra(body);
    session._apiKey = apiKey;
    session._postId = postId;
    session.runExtra = (name, input) => runHubTool(hub, name, input, session._postId);
    session.onPending = async (writeBlocks) => {
      const card = cardFromWrites(writeBlocks);
      const p = await hub.reply(body.thread, { kind: "action", action: card, replyTo: postId });
      session._card = { id: p.id, writes: card.writes };
    };
  }
  const sender = (thread, postId) => (text) => hub.reply(thread, { kind: "text", text, replyTo: postId });

  // turns on one thread never interleave (two quick messages, or a ✓ during an answer)
  const queue = (session, fn) => { const run = (session._q || Promise.resolve()).then(fn, fn); session._q = run.catch(() => {}); return run; };

  async function ask(body) {
    const { thread, postId } = body;
    const session = getSession(key(thread));
    return queue(session, async () => {
      // a card is still open and Mario typed instead of tapping: yes/no act on the card, anything else is a correction
      if (session.pending && session._card) {
        const t = String(body.text || "").trim();
        if (isConfirm(t) || isNo(t)) {
          await doConfirm(session, { ...body, postId: session._card.id, ok: isConfirm(t), note: "", writes: session._card.writes });
          await hub.done(thread, postId).catch(() => {});
          return;
        }
        await hub.settle(thread, session._card.id, { status: "declined" }).catch(() => {});
        session._card = null;
      }
      prime(session, body, postId);
      try { await turn(key(thread), userContent(body), sender(thread, postId), apiKey); }
      catch (e) { await sender(thread, postId)(`❌ ${e.message}`).catch(() => {}); }
      finally { await hub.done(thread, postId).catch(() => {}); }
    });
  }

  async function doConfirm(session, body) {
    const { thread, postId, ok, note, writes } = body;
    prime(session, body, postId);
    const send = sender(thread, postId);
    let receipts;
    try { receipts = await applyWrites(session, writes || [], !!ok, ok ? "" : `User did NOT approve.${note ? ` They said: "${note}".` : ""} Adjust accordingly.`, send); }
    catch (e) { return hub.settle(thread, postId, { status: "error", error: String(e.message || e).slice(0, 300) }); }
    finally { if (session._card && session._card.id === postId) session._card = null; }
    if (!ok) return hub.settle(thread, postId, { status: "declined" });
    const failed = receipts.filter((r) => !r.ok);
    if (failed.length) return hub.settle(thread, postId, { status: "error", error: failed.map((r) => r.error).join(" · ").slice(0, 300) });
    return hub.settle(thread, postId, { status: "done", receipt: receipts.map((r) => receiptOf(r.name, r.out)).join(" · ").slice(0, 300) });
  }

  const confirm = (body) => { const session = getSession(key(body.thread)); return queue(session, () => doConfirm(session, body)); };

  return { ask, confirm };
}
```

- [ ] **Step 4: Run all** — `cd /d/vscode/shift-hub && node --test test/` → `pass 18`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /d/vscode/shift-hub && git add bots/agent-site/run.mjs test/agent-site-run.test.js && git commit -m "agent-site: ask/confirm runner with per-thread queue and typed yes/no on an open card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: server.mjs handler + hub mount + local harness

**Files:**
- Create: `D:\vscode\shift-hub\bots\agent-site\server.mjs`, `D:\vscode\shift-hub\bots\agent-site\local.mjs`
- Modify: `D:\vscode\shift-hub\server.mjs` (loads after line 47; request handler before line 88), `package.json` (scripts), `README.md` (route table)
- Test: `D:\vscode\shift-hub\test\agent-site-server.test.js`

**Interfaces:**
- Produces: `makeAgentSite({ secret, runner }) → { name: 'agent-site', handle(req, res) → boolean }`; `export const agentSite` built from env. Routes: `POST /site-agent` (ask), `POST /site-agent/confirm`; both need `Authorization: Bearer $SITE_AGENT_SECRET`, both answer `202 {"ok":true}` right after parsing and run afterwards; `400` when `thread`/`postId` missing or bad JSON; `401` bad bearer; `405` non-POST; other paths → `false`.

- [ ] **Step 1: Write the failing test**

```js
// D:\vscode\shift-hub\test\agent-site-server.test.js
process.env.SITE_AGENT_SECRET ||= "s".repeat(32); process.env.HUB_URL ||= "http://127.0.0.1:1"; process.env.HUB_MACHINE_KEY ||= "k".repeat(40);
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { makeAgentSite } from "../bots/agent-site/server.mjs";

const SECRET = "s".repeat(32);
function serve(handler) {
  const srv = http.createServer((req, res) => { if (!handler.handle(req, res)) { res.writeHead(404); res.end(); } });
  return new Promise((r) => srv.listen(0, () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}
const post = (url, path, body, auth = `Bearer ${SECRET}`) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("ask is acked with 202 and run after", async () => {
  const seen = []; let resolve; const ran = new Promise((r) => (resolve = r));
  const runner = { ask: async (b) => { seen.push(b); resolve(); }, confirm: async () => {} };
  const s = await serve(makeAgentSite({ secret: SECRET, runner }));
  try {
    const r = await post(s.url, "/site-agent", { thread: "shift", postId: "q1", text: "hi" });
    assert.strictEqual(r.status, 202); assert.deepStrictEqual(await r.json(), { ok: true });
    await ran; assert.deepStrictEqual(seen, [{ thread: "shift", postId: "q1", text: "hi" }]);
  } finally { s.close(); }
});

test("confirm routes to runner.confirm", async () => {
  let got; const runner = { ask: async () => {}, confirm: async (b) => { got = b; } };
  const s = await serve(makeAgentSite({ secret: SECRET, runner }));
  try { const r = await post(s.url, "/site-agent/confirm", { thread: "shift", postId: "c1", ok: true, writes: [] }); assert.strictEqual(r.status, 202); await new Promise((r) => setTimeout(r, 20)); assert.strictEqual(got.postId, "c1"); }
  finally { s.close(); }
});

test("bad bearer → 401, missing ids → 400, GET → 405, other paths not claimed", async () => {
  const s = await serve(makeAgentSite({ secret: SECRET, runner: { ask: async () => {}, confirm: async () => {} } }));
  try {
    assert.strictEqual((await post(s.url, "/site-agent", { thread: "a", postId: "b" }, "Bearer nope")).status, 401);
    assert.strictEqual((await post(s.url, "/site-agent", { text: "x" })).status, 400);
    assert.strictEqual((await post(s.url, "/site-agent", "{not json")).status, 400);
    assert.strictEqual((await fetch(s.url + "/site-agent")).status, 405);
    assert.strictEqual((await fetch(s.url + "/healthz")).status, 404);
  } finally { s.close(); }
});
```

- [ ] **Step 2: Run** → FAIL, `Cannot find module '.../server.mjs'`.

- [ ] **Step 3: Implement the handler**

```js
// D:\vscode\shift-hub\bots\agent-site\server.mjs
// "Shift" in the hub site chat. The hub POSTs Mario's post here and waits only for the 202 —
// the Claude turn runs after the ack and answers through the hub's machine routes (hub.mjs).
//   POST /site-agent           { thread, postId, text, date, context, ledger }
//   POST /site-agent/confirm   { thread, postId, ok, note, writes, date, ledger }
// Both need "Authorization: Bearer $SITE_AGENT_SECRET".
import { loadAgentCreds } from "../agent/agent.mjs";
import { makeHub } from "./hub.mjs";
import { makeRunner } from "./run.mjs";
import { checkBearer } from "./card.mjs";

export function makeAgentSite({ secret = process.env.SITE_AGENT_SECRET, runner } = {}) {
  if (!secret || secret.length < 16) throw new Error("SITE_AGENT_SECRET (16+ chars) is required");
  if (!runner) runner = makeRunner({ hub: makeHub(), apiKey: loadAgentCreds().anthropicKey });

  function handle(req, res) {
    const path = (req.url || "/").split("?")[0];
    const op = path === "/site-agent" ? "ask" : path === "/site-agent/confirm" ? "confirm" : null;
    if (!op) return false;
    if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }
    if (!checkBearer(req, secret)) { res.writeHead(401); res.end("unauthorized"); return true; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }
      if (!b.thread || !b.postId) { res.writeHead(400); res.end("thread and postId are required"); return; }
      res.writeHead(202, { "content-type": "application/json" }); res.end('{"ok":true}');
      runner[op](b).catch((e) => console.error(`[agent-site] ${op} ${b.thread}/${b.postId}:`, e.message));
    });
    return true;
  }
  return { name: "agent-site", handle };
}

export const agentSite = makeAgentSite();
```

- [ ] **Step 4: Run** → `pass 3`.

- [ ] **Step 5: Mount in the hub server**

`D:\vscode\shift-hub\server.mjs` after line 47:

```js
await load("agentSite", async () => (await import("./bots/agent-site/server.mjs")).agentSite);
```

In the request handler, before the `if (loaded.mcp && …)` block:

```js
    // "Shift" in the hub site chat — claims /site-agent and /site-agent/confirm
    if (loaded.agentSite && path.startsWith("/site-agent") && loaded.agentSite.handle(req, res)) return;
```

Header comment: add `//   POST /site-agent[/confirm]     "Shift" in the hub site chat (bearer SITE_AGENT_SECRET)`.
`package.json` scripts: `"test": "node --test test/"`.
`README.md` route table: `| "Shift" in the hub site chat | — (new) | POST /site-agent, POST /site-agent/confirm (bearer SITE_AGENT_SECRET; needs HUB_URL, HUB_MACHINE_KEY) |`.

- [ ] **Step 6: The local harness**

```js
// D:\vscode\shift-hub\bots\agent-site\local.mjs
// Try the site agent from the terminal without the hub or Render:
//   node bots/agent-site/local.mjs "add a to-do: call Roger tomorrow"
//   node bots/agent-site/local.mjs --thread georges "how much does he owe"
//   … --real   also lets an Odoo write execute on ✓ (default: hub writes only, Odoo writes are refused)
// A mock hub on 127.0.0.1 prints every reply/card/settle and answers exec with a fake receipt.
// Reads run against the real Odoo (~/.odoo-creds.json); the Anthropic key comes from ~/.mario-bot.json.
import http from "node:http";
import readline from "node:readline";
import { loadAgentCreds } from "../agent/agent.mjs";
import { makeHub } from "./hub.mjs";
import { makeRunner } from "./run.mjs";
import { isHubTool } from "./hub-tools.mjs";

const args = process.argv.slice(2);
const real = args.includes("--real");
const ti = args.indexOf("--thread");
const thread = ti >= 0 ? args[ti + 1] : "shift";
const text = args.filter((a, i) => a !== "--real" && !(i === ti || i === ti + 1)).join(" ");
if (!text) { console.error("usage: node bots/agent-site/local.mjs [--thread <id>] [--real] <what Mario says>"); process.exit(1); }

const people = [{ id: "georges", name: "Georges", odooPartnerId: null }, { id: "abed", name: "Abed", odooPartnerId: null }, { id: "khodr", name: "Khoder", odooPartnerId: 299 }, { id: "ziad", name: "Ziad", odooPartnerId: null }, { id: "mitri", name: "Mitri", odooPartnerId: null }];
const ledger = { current: people.find((p) => p.id === thread) || null, people };
let card = null;

const mock = http.createServer((req, res) => {
  const end = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b); const route = req.url.split("/").pop();
    if (route === "reply") {
      const id = "card-" + Date.now().toString(36);
      if (body.kind === "action") { card = { id, ...body.action }; console.log(`\n┌ CARD ${id}\n│ ${body.action.summary}\n│ ${body.action.detail.replace(/\n/g, "\n│ ")}\n└`); }
      else console.log(`\nShift: ${body.text}`);
      return end({ id });
    }
    if (route === "exec") {
      if (!real && !isHubTool(body.write.name)) return end({ error: "Odoo write refused by the harness (pass --real)" }, 400);
      console.log(`  exec ${body.write.name} ${JSON.stringify(body.write.input)}`);
      return end({ ok: true, receipt: `mock ${body.write.name}`, url: "https://hub.shift-group.co/" });
    }
    if (route === "settle") { console.log(`  card ${body.postId} → ${body.status}${body.receipt ? " · " + body.receipt : ""}${body.error ? " · " + body.error : ""}`); return end({ ok: true }); }
    return end({ ok: true });
  });
});
await new Promise((r) => mock.listen(0, r));
const hub = makeHub({ url: `http://127.0.0.1:${mock.address().port}`, key: "k".repeat(40) });
const runner = makeRunner({ hub, apiKey: loadAgentCreds().anthropicKey });
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Beirut" });

await runner.ask({ thread, postId: "q-" + Date.now().toString(36), text, date: today, context: [], ledger });
if (card) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question("\n✓ do it / ✗ cancel / or type a correction: ", r)); rl.close();
  if (/^[✓y]/i.test(a)) await runner.confirm({ thread, postId: card.id, ok: true, note: "", writes: card.writes, date: today, ledger });
  else if (/^[✗n]/i.test(a)) await runner.confirm({ thread, postId: card.id, ok: false, note: "", writes: card.writes, date: today, ledger });
  else await runner.ask({ thread, postId: "q-" + Date.now().toString(36), text: a, date: today, context: [], ledger });
}
mock.close();
```

- [ ] **Step 7: Run the harness once, both paths**

`cd /d/vscode/shift-hub && node bots/agent-site/local.mjs "add a to-do: call Roger about the Q3 VAT, due Friday"` → a `┌ CARD` block with a `hub_todo` summary; type `y` → `exec hub_todo {...}` then `card … → done · mock hub_todo …`.
`node bots/agent-site/local.mjs --thread khodr "how many posted bills does he have"` → a `Shift: …` text answer from a real Odoo read (partner 299), no card.
`node --test test/` → `pass 21`.

- [ ] **Step 8: Commit**

```bash
cd /d/vscode/shift-hub && git add bots/agent-site/server.mjs bots/agent-site/local.mjs server.mjs package.json README.md test/agent-site-server.test.js && git commit -m "agent-site: HTTP handler mounted on the hub, npm test, local harness with a mock hub

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Hub — machine bearer opens `/api/site/agent/*`

**Files:**
- Modify: `D:\vscode\todo\server.js:801-823`

**Interfaces:**
- Produces: for `Authorization: Bearer $ACCOUNTING_API_KEY` on `/api/site/agent/*`: `user = { uid: 'shift-agent', email: 'shift@shift-group.co' }`, `access = { email, apps: ['site'], admin: false, agent: true }`. Task 8's routes check `ctx.access.agent`.

- [ ] **Step 1: Edit**

Replace lines 803–805 (`const machineKey…`, `const bearer…`, `const machine…`):

```js
  const machineKey = process.env.ACCOUNTING_API_KEY;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const keyOk = !!machineKey && bearer.length >= 32 && bearer === machineKey;
  // the same key lets Render's site agent ("Shift", shift-hub bots/agent-site) post replies and run hub writes — see site-agent.js
  const agentCall = keyOk && url.startsWith('/api/site/agent/');
  const machine = agentCall || (keyOk && (url.startsWith('/api/accounting/') || url === '/api/crm/ingest'));
```

Replace the `const user = machine ? … : await verifyToken(req);` line:

```js
  const user = agentCall ? { uid: 'shift-agent', email: 'shift@shift-group.co' }
    : machine ? { uid: 'whish-watcher', email: 'whish-watcher@shift-group.co' } : await verifyToken(req);
```

Replace the `const access = machine ? … : await accessFor(user.email);` expression:

```js
  const access = agentCall
    ? { email: user.email, apps: ['site'], admin: false, agent: true }
    : machine
      ? { email: user.email, apps: ['accounting'], admin: false }
      : AUTH_DISABLED
        ? { email: user.email || '', apps: APPS.slice(), admin: true }
        : await accessFor(user.email);
```

- [ ] **Step 2: Verify by hand**

```bash
cd /d/vscode/todo && (REQUIRE_AUTH=1 ACCOUNTING_API_KEY=0123456789abcdef0123456789abcdef PORT=8098 node server.js > /tmp/hub8098.log 2>&1 &) && sleep 5
K="Authorization: Bearer 0123456789abcdef0123456789abcdef"
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "$K" -H "Content-Type: application/json" -d '{}' http://localhost:8098/api/site/agent/reply
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' http://localhost:8098/api/site/agent/reply
curl -s -o /dev/null -w "%{http_code}\n" -H "$K" http://localhost:8098/api/site/threads
taskkill //F //IM node.exe //FI "WINDOWTITLE eq *" > /dev/null 2>&1 || true
```
Expected: `404` (gate passed, route not mounted yet — NOT 401/403), `401`, `401` (the key opens agent routes only). Stop only the server you started (`netstat -ano | findstr :8098` → `taskkill //PID <pid> //F`) — never kill every node (the WhatsApp daemon and others run under node).

- [ ] **Step 3: Commit**

```bash
cd /d/vscode/todo && git add server.js && git commit -m "hub: the machine key opens /api/site/agent/* for Render's site agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Hub — `site-agent.js` pure parts

**Files:**
- Create: `D:\vscode\todo\site-agent.js` (helpers now; routes in Task 8)
- Test: `D:\vscode\todo\test\site-agent.test.js`

**Interfaces:**
- Produces: `AGENT = 'shift'`, `isTrigger(thread, text, admin)`, `stripTrigger(text)`, `contextLines(posts) → string[]`, `todoDoc(input, who, users) → task doc`, `previewOf(post) → string`.

- [ ] **Step 1: Write the failing test**

```js
// D:\vscode\todo\test\site-agent.test.js — node --test test/site-agent.test.js
const test = require('node:test');
const assert = require('node:assert');
const { AGENT, isTrigger, stripTrigger, contextLines, todoDoc, previewOf } = require('../site-agent');

test('trigger: the shift thread, or @shift / @s at the start — admin only', () => {
  assert.ok(isTrigger('shift', 'hello', true));
  assert.ok(isTrigger('georges', '@shift how much does he owe', true));
  assert.ok(isTrigger('georges', '@S add 40$ diesel', true));
  assert.ok(!isTrigger('georges', 'he @shift owes', true), 'only at the start');
  assert.ok(!isTrigger('georges', '@shifted', true));
  assert.ok(!isTrigger('shift', 'hello', false), 'a worker never wakes it');
  assert.strictEqual(AGENT, 'shift');
});

test('stripTrigger removes the prefix only', () => {
  assert.strictEqual(stripTrigger('@shift: how much'), 'how much');
  assert.strictEqual(stripTrigger('@s add 40$'), 'add 40$');
  assert.strictEqual(stripTrigger('plain text'), 'plain text');
});

test('contextLines: last 20, oldest first, one line each, taps and deleted skipped', () => {
  const posts = [
    { date: '2026-09-19', by: 'georges@x', kind: 'text', text: '40$ diesel' },
    { date: '2026-09-19', by: 'mario@x', byAdmin: true, kind: 'voice', parsed: { transcript: 'ok noted' } },
    { date: '2026-09-19', by: 'georges@x', kind: 'start' },
    { date: '2026-09-19', by: 'georges@x', kind: 'photo', parsed: {} },
    { date: '2026-09-20', by: 'shift', kind: 'action', status: 'done', action: { summary: 'Georges ledger: +$40 diesel' } },
    { date: '2026-09-20', by: 'georges@x', kind: 'text', text: 'gone', deleted: true },
  ];
  assert.deepStrictEqual(contextLines(posts), [
    '2026-09-19 georges: 40$ diesel',
    '2026-09-19 Mario: (voice) ok noted',
    '2026-09-19 georges: (photo)',
    '2026-09-20 Shift: [action card done] Georges ledger: +$40 diesel',
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ date: '2026-09-20', by: 'a@x', kind: 'text', text: 't' + i }));
  const c = contextLines(many); assert.strictEqual(c.length, 20); assert.strictEqual(c[0], '2026-09-20 a: t10');
});

test('todoDoc: the To-Do app shape, assignee matched by name, priority whitelisted', () => {
  const users = [{ id: 'u1', name: 'Christa Saliba' }, { id: 'u2', name: 'Mario' }];
  const t = todoDoc({ title: '  send D3 drawings ', assignee: 'christa', due: '2026-09-22', priority: 'high', notes: 'for Antoine' }, 'shift', users);
  assert.match(t.id, /^ag-/);
  assert.strictEqual(t.title, 'send D3 drawings'); assert.strictEqual(t.done, false); assert.strictEqual(t.doneAt, null);
  assert.deepStrictEqual(t.assignees, ['u1']); assert.strictEqual(t.due, '2026-09-22'); assert.strictEqual(t.priority, 'high');
  assert.strictEqual(t.notes, 'for Antoine'); assert.strictEqual(t.taskType, 'task'); assert.strictEqual(t.createdBy, 'shift');
  const u = todoDoc({ title: 'x', assignee: 'nobody', due: 'Monday', priority: 'urgent' }, 'shift', users);
  assert.deepStrictEqual(u.assignees, []); assert.strictEqual(u.due, ''); assert.strictEqual(u.priority, ''); assert.strictEqual(u.notes, 'for nobody');
  assert.strictEqual(todoDoc({ title: '   ' }, 'shift', users).title, '');
});

test('previewOf: an action card previews as its summary', () => {
  assert.strictEqual(previewOf({ kind: 'action', action: { summary: 'Pay Khoder $150' }, status: 'pending' }), '✓? Pay Khoder $150');
  assert.strictEqual(previewOf({ kind: 'action', action: { summary: 'Pay Khoder $150' }, status: 'done' }), '✓ Pay Khoder $150');
  assert.strictEqual(previewOf({ kind: 'text', text: 'hello' }), 'hello');
});
```

- [ ] **Step 2: Run** → FAIL, `Cannot find module '../site-agent'`.

- [ ] **Step 3: Implement the pure parts**

```js
// D:\vscode\todo\site-agent.js — "Shift", the agent member of the site chat.
// Spec: docs/superpowers/specs/2026-09-20-site-agent-design.md. Mario writes in the `shift` thread, or
// starts a message with @shift / @s in any thread; the post is forwarded to Render (shift-hub,
// bots/agent-site) which answers back through the machine routes below (/api/site/agent/*).
// The agent writes nothing without Mario's ✓ on an action card (POST …/confirm).
const acc = require('./accounts');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const beirutDay = d => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const readBody = (req, max = 2e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});

const AGENT = 'shift';                       // the thread id and the `by` of every agent post
const TRIGGER = /^@(shift|s)\b[:,]?\s*/i;
const PRIORITIES = ['high', 'medium', 'low'];

const isTrigger = (thread, text, admin) => !!admin && (thread === AGENT || TRIGGER.test(String(text || '')));
const stripTrigger = text => String(text || '').replace(TRIGGER, '').trim();

// what the agent gets to read: the last posts of the thread, oldest first, one line each
function contextLines(posts) {
  return posts.filter(p => !p.deleted && p.kind !== 'start' && p.kind !== 'finish').slice(-20).map(p => {
    const who = p.by === AGENT ? 'Shift' : p.byAdmin ? 'Mario' : String(p.by || '').split('@')[0];
    const body = p.kind === 'action' ? `[action card ${p.status || 'pending'}] ${(p.action && p.action.summary) || ''}`
      : p.kind === 'text' ? p.text
      : p.parsed && p.parsed.transcript ? `(voice) ${p.parsed.transcript}` : `(${p.kind})`;
    return `${p.date} ${who}: ${body}`;
  });
}

// the To-Do app's task shape (todo.html kanbanAddCommit), filled from the agent's input
function todoDoc(input, who, users) {
  const name = String(input.assignee || '').trim().toLowerCase();
  const user = name ? (users || []).find(u => String(u.name || '').toLowerCase().startsWith(name)) : null;
  const notes = [name && !user ? `for ${input.assignee}` : '', String(input.notes || '').trim()].filter(Boolean).join(' · ');
  return { id: 'ag-' + newId(), title: String(input.title || '').trim().slice(0, 200), done: false, doneAt: null, createdAt: now(),
    project: '', taskStatus: '', department: null, priority: PRIORITIES.includes(input.priority) ? input.priority : '',
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(input.due || '')) ? input.due : '', partner: '', notes, taskType: 'task',
    clientName: '', clientId: null, subtasks: [], assignees: user ? [user.id] : [], createdBy: who };
}

const previewOf = p => p.kind === 'action' ? `${p.status === 'done' ? '✓' : p.status === 'declined' ? '✗' : '✓?'} ${(p.action && p.action.summary) || ''}` : String(p.text || '');

module.exports = { AGENT, isTrigger, stripTrigger, contextLines, todoDoc, previewOf };
```

- [ ] **Step 4: Run** → `pass 5`.

- [ ] **Step 5: Commit**

```bash
cd /d/vscode/todo && git add site-agent.js test/site-agent.test.js && git commit -m "site-agent: trigger, context, to-do doc and preview helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Hub — the routes and the site.js wiring

**Files:**
- Modify: `D:\vscode\todo\site-agent.js` (add `ledgerFor`, `render`, `handle`)
- Modify: `D:\vscode\todo\site.js` — require (after line 9), `threadsFor` (line 43), `writeLine` (line 63), `handle` (line 139), threads preview (line 157), `/digest` route (after line 244), exports (line 277)

**Interfaces:**
- Consumes: Task 6 (`access.agent`), Task 7 helpers, `site.js` `writeLine(ctx, ws, post, target, fields)` now honouring `fields.src`, `refs(ctx)`.
- Produces (front end, Task 9): `POST /api/site/:thread/posts/:id/ask` (admin) → `200 {ok:true}` | `503` (not connected) | `504 {error:'Shift is waking up — send it again in a moment'}` | `502`; `POST /api/site/:thread/posts/:id/confirm {ok, note?}` (admin) → the updated card post. Post fields: asked post `agentAsk: true, askedAt, answeredAt|null`; agent posts `{ by:'shift', kind:'text'|'action', text, replyTo, digestedAt }`, action posts also `{ action:{summary, detail, writes}, status:'pending'|'running'|'done'|'declined'|'error', receipt, error }`.
- Produces (Render, Tasks 3–4): `POST /api/site/agent/reply {thread, kind, text?, action?, replyTo}` → the post; `/done {thread, postId}`; `/settle {thread, postId, status, receipt?, error?}`; `/exec {write:{name,input}, postId}` → `{ok:true, receipt, url}` | `400 {error}`.

- [ ] **Step 1: site.js**

(a) After line 9: `const siteAgent = require('./site-agent');`

(b) `threadsFor` line 43:
```js
  // "Shift" (the agent) is a thread of its own, pinned under Mario — admin only (site-agent.js)
  const all = [{ id: 'general', name: 'Mario', kind: 'general' }, { id: siteAgent.AGENT, name: 'Shift', kind: 'agent' }, ...people.map(p => ({ id: p.id, name: p.name, kind: 'worker' }))];
```

(c) `writeLine` line 63: `src: 'site',` → `src: fields.src || 'site',` (the agent's lines say `src: 'agent'`).

(d) `handle`, before `const att = await attendance.handle(…)`:
```js
  // the agent's routes first: /api/site/agent/* is machine-only and must not fall into the attendance matcher
  const ag = await siteAgent.handle(req, res, url, user, { ...ctx, threadsFor, writeLine, refs });
  if (ag !== false) return ag;
```

(e) Threads preview line 157: `p.kind === 'text' ? String(p.text || '').slice(0, 90)` → `(p.kind === 'text' || p.kind === 'action') ? siteAgent.previewOf(p).slice(0, 90)`.

(f) `/digest` route, right after `if (post.digestedAt && !b.force) return json(res, 200, post);`:
```js
    // a message meant for the agent is a question, not a ledger proposal: read a voice note, never write a line
    if (post.by === siteAgent.AGENT || post.agentAsk || siteAgent.isTrigger(m[1], post.text, post.byAdmin)) {
      const parsed = post.parsed || {};
      if (post.kind === 'voice' && !parsed.transcript) { const buf = await readBytes(ctx, post.file); parsed.transcript = await parse.whisper(buf, post.file.mime); }
      await ref.set({ parsed, line: null, error: null, digestedAt: now(), digesting: false, agentAsk: !!post.byAdmin }, { merge: true });
      return json(res, 200, (await ref.get()).data());
    }
```

(g) Exports: `module.exports = { handle, sweep: attendance.sweep, writeLine };`

- [ ] **Step 2: site-agent.js — add before `module.exports`, and export `handle`**

```js
// the worker ledgers the agent may name; `current` when the thread is a worker's chat
async function ledgerFor(ws, thread) {
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived)
    .map(a => ({ id: a.id, name: a.name, owner: a.owner || '', odooPartnerId: a.odooPartner ? a.odooPartner.id : null }));
  return { current: people.find(p => p.id === thread) || null, people };
}

// Render, and only its ack: the turn runs after (a Claude loop can take a minute; Vercel gives us 60 s)
async function render(path, body) {
  const base = String(process.env.SITE_AGENT_URL || '').replace(/\/+$/, '');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25e3);
  try {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.SITE_AGENT_SECRET || '') }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error('Shift answered ' + r.status);
  } finally { clearTimeout(t); }
}
const WAKING = 'Shift is waking up — send it again in a moment';
const fail = (res, e) => json(res, e.name === 'AbortError' ? 504 : 502, { error: e.name === 'AbortError' ? WAKING : e.message });

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const postsOf = thread => ws.collection('site').doc(thread).collection('posts');
  let m;

  // ── Mario's side ─────────────────────────────────────────────────────────────
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/ask$/)) && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    if (!process.env.SITE_AGENT_URL) return json(res, 503, { error: 'Shift is not connected (SITE_AGENT_URL)' });
    const [thread, id] = [m[1], m[2]];
    const ref = postsOf(thread).doc(id);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    const text = post.kind === 'text' ? stripTrigger(post.text) : (post.parsed && post.parsed.transcript) || '';
    if (!text) return json(res, 400, { error: 'nothing to ask — a voice note needs its transcript first' });
    const snap = await postsOf(thread).orderBy('at', 'desc').limit(25).get();
    const context = contextLines(snap.docs.map(x => x.data()).reverse().filter(p => p.id !== id));
    const ledger = await ledgerFor(ws, thread);
    await ref.set({ agentAsk: true, askedAt: now(), answeredAt: null, digestedAt: post.digestedAt || now(), digesting: false, line: null }, { merge: true });
    try { await render('/site-agent', { thread, postId: id, text, date: post.date, context, ledger }); }
    catch (e) { return fail(res, e); }
    return json(res, 200, { ok: true });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/confirm$/)) && req.method === 'POST') {
    if (!access.admin) return json(res, 403, { error: 'admin only' });
    if (!process.env.SITE_AGENT_URL) return json(res, 503, { error: 'Shift is not connected (SITE_AGENT_URL)' });
    const [thread, id] = [m[1], m[2]];
    const ref = postsOf(thread).doc(id);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    if (post.kind !== 'action') return json(res, 400, { error: 'not an action card' });
    if (!['pending', 'error'].includes(post.status)) return json(res, 409, { error: `this card is already ${post.status}` });
    const b = await readBody(req);
    const ok = !!b.ok;
    await ref.set({ status: ok ? 'running' : 'declined', error: '', confirmedAt: now(), confirmedBy: user.email || user.uid }, { merge: true });
    try { await render('/site-agent/confirm', { thread, postId: id, ok, note: String(b.note || '').slice(0, 500), writes: post.action.writes, date: post.date, ledger: await ledgerFor(ws, thread) }); }
    catch (e) {
      await ref.set({ status: ok ? 'error' : 'declined', error: e.name === 'AbortError' ? WAKING : e.message }, { merge: true });
      return fail(res, e);
    }
    return json(res, 200, (await ref.get()).data());
  }

  // ── Render's side (machine bearer → access.agent, see server.js) ─────────────
  if (url.startsWith('/api/site/agent/')) {
    if (!access.agent) return json(res, 403, { error: 'agent only' });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
    const b = await readBody(req);
    const thread = String(b.thread || '');
    if (!/^[\w-]+$/.test(thread)) return json(res, 400, { error: 'thread' });

    if (url === '/api/site/agent/reply') {
      const id = newId();
      const post = { id, thread, by: AGENT, at: now(), date: beirutDay(), kind: b.kind === 'action' ? 'action' : 'text', text: String(b.text || '').slice(0, 4000), byAdmin: false, replyTo: b.replyTo ? String(b.replyTo) : null, digestedAt: now() };
      if (post.kind === 'action') {
        const a = b.action || {};
        post.action = { summary: String(a.summary || '').slice(0, 300), detail: String(a.detail || '').slice(0, 1500), writes: Array.isArray(a.writes) ? a.writes.slice(0, 10) : [] };
        if (!post.action.writes.length) return json(res, 400, { error: 'an action card needs writes' });
        post.status = 'pending'; post.receipt = ''; post.error = ''; post.text = post.action.summary;
      } else if (!post.text) return json(res, 400, { error: 'nothing to say' });
      await postsOf(thread).doc(id).set(post);
      return json(res, 200, post);
    }
    if (url === '/api/site/agent/done') {
      const ref = postsOf(thread).doc(String(b.postId || ''));
      if ((await ref.get()).exists) await ref.set({ answeredAt: now() }, { merge: true });
      return json(res, 200, { ok: true });
    }
    if (url === '/api/site/agent/settle') {
      const ref = postsOf(thread).doc(String(b.postId || ''));
      const d = await ref.get(); if (!d.exists || d.data().kind !== 'action') return json(res, 404, { error: 'no card' });
      const status = ['done', 'declined', 'error'].includes(b.status) ? b.status : 'error';
      await ref.set({ status, receipt: String(b.receipt || '').slice(0, 300), error: String(b.error || '').slice(0, 300), settledAt: now() }, { merge: true });
      return json(res, 200, (await ref.get()).data());
    }
    if (url === '/api/site/agent/exec') {
      const w = b.write || {}, input = w.input || {};
      const host = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'hub.shift-group.co');
      if (w.name === 'hub_worker_line') {
        const a = await acc.resolve(ws, String(input.account || ''));
        if (!a || !a.daily) return json(res, 400, { error: 'no such worker ledger: ' + (input.account || '(none)') });
        const amount = Math.round((+input.amount || 0) * 100) / 100;
        if (!(amount > 0)) return json(res, 400, { error: 'an amount above 0 is needed' });
        const analytic = input.analytic ? parse.matchName(String(input.analytic), (await ctx.refs(ctx)).analytics) : null;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : beirutDay();
        // the card's id becomes the line's id (site-<cardId>): one card, one line — a re-run ✓ overwrites, never duplicates
        const post = { id: String(b.postId || newId()), thread: a.id, date, at: now(), by: AGENT, byAdmin: true, text: '' };
        const line = await ctx.writeLine(ctx, ws, post, a.id, { amount, side: input.side === 'credit' ? 'credit' : 'debit', description: String(input.description || '').slice(0, 160), analytic, nature: ['labour', 'expense', 'vendor', 'transfer'].includes(input.nature) ? input.nature : undefined, note: '', src: 'agent' });
        return json(res, 200, { ok: true, receipt: `${a.name} ledger · ${input.side === 'credit' ? '-' : '+'}$${amount} ${date} · waiting for ✓ on the Day report`, url: host + '/accounting/daily', line });
      }
      if (w.name === 'hub_todo') {
        const users = (await ws.collection('users').get()).docs.map(d => ({ id: d.id, ...d.data() }));
        const t = todoDoc(input, AGENT, users);
        if (!t.title) return json(res, 400, { error: 'a title is needed' });
        await ws.collection('tasks').doc(t.id).set({ ...t, workspaceId: TEAM_ID });
        return json(res, 200, { ok: true, receipt: `to-do "${t.title}"${t.due ? ' due ' + t.due : ''}`, url: host + '/todo', taskId: t.id });
      }
      return json(res, 400, { error: 'unknown hub write ' + w.name });
    }
    return json(res, 404, { error: 'no such agent route' });
  }
  return false;
}
```

Before relying on `ws.collection('users')`: `grep -n "users" server.js | grep collection` — use whatever collection `/api/workspaces/:id/users` reads. Known limitation (note in memory): the To-Do page saves the *full* task list on every change, so a task the agent adds while `/todo` is open with a stale list can be dropped by that next save.

- [ ] **Step 3: Tests + local smoke**

`cd /d/vscode/todo && node --test test/*.test.js` → `pass 16`, `fail 0`.

Local smoke (no Render: `/ask` must answer 503; the machine routes must write):
```bash
cd /d/vscode/todo && (ACCOUNTING_API_KEY=0123456789abcdef0123456789abcdef PORT=8098 node server.js > /tmp/hub8098.log 2>&1 &) && sleep 5
K="Authorization: Bearer 0123456789abcdef0123456789abcdef"
curl -s -X POST -H "$K" -H "Content-Type: application/json" -d '{"thread":"shift","kind":"text","text":"hello from the smoke test","replyTo":null}' http://localhost:8098/api/site/agent/reply; echo
curl -s -X POST -H "$K" -H "Content-Type: application/json" -d '{"thread":"shift","kind":"action","action":{"summary":"To-do: smoke","detail":"1. To-do: smoke","writes":[{"id":"x","name":"hub_todo","input":{"title":"smoke test task","summary":"To-do: smoke"}}]},"replyTo":null}' http://localhost:8098/api/site/agent/reply; echo
curl -s http://localhost:8098/api/site/threads | head -c 400; echo
```
Expected: two posts with `"by":"shift"`, the second `"status":"pending"`; the threads list has `{"id":"shift","name":"Shift","kind":"agent",…}` with preview `✓? To-do: smoke`. Stop the 8098 server by PID. These two posts stay in the live `shift` thread — delete them from the chat after Task 9's check (long-press → Delete).

- [ ] **Step 4: Commit**

```bash
cd /d/vscode/todo && git add site.js site-agent.js && git commit -m "site chat: the Shift thread, /ask + /confirm, machine routes for Render's replies, cards and hub writes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Front end — Shift row, agent bubbles, action cards, ask/poll/confirm

**Files:**
- Modify: `D:\vscode\todo\site.html` — CSS (after line 70), list helpers (lines 162–189), `digestOne` (291–297), `loadPosts` (319–324), `draw` (336–353), `sendText` (372–379), boot (493–501)

- [ ] **Step 1: CSS** — after the `.post .err` rule:

```css
  /* "Shift", the agent (site-agent.js): dark avatar with the amber S; bubbles with an amber edge; action cards with ✓ / ✗ */
  .chat-row .av.agent,.chatbar .av.agent{background:#15181C;color:#F2A93B;font-family:"Century Gothic","Trebuchet MS",sans-serif;}
  .post.agent{border-left:3px solid var(--amber);white-space:pre-wrap;}
  .post.agent.typing{color:var(--overlay0);font-style:italic;}
  .post.sys{align-self:center;background:transparent;box-shadow:none;color:var(--overlay0);font-size:.75rem;text-align:center;}
  .post .trig{color:var(--amber);font-weight:700;}
  .card-a{margin-top:2px;border:1px solid var(--surface0);border-radius:10px;padding:8px 10px;background:#fff;white-space:normal;}
  .card-a .s{font-size:.92rem;} .card-a .d{font-size:.72rem;color:var(--overlay0);margin-top:3px;white-space:pre-wrap;}
  .card-a .b{display:flex;gap:8px;margin-top:8px;} .card-a .b button{flex:1;height:44px;border:0;border-radius:10px;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;}
  .card-a .ok{background:var(--amber);color:#fff;} .card-a .no{background:var(--surface0);color:var(--text);}
  .card-a.done{border-color:#bfe6c8;background:#f1fbf3;} .card-a.declined .s{text-decoration:line-through;color:var(--overlay0);}
  .card-a .r{font-size:.75rem;color:var(--green);margin-top:6px;} .card-a .e{font-size:.75rem;color:var(--red);margin-top:6px;} .card-a .r a{color:inherit;}
```

- [ ] **Step 2: Chats list and header**

Replace `const initial = …` with:
```js
const initial = t => t.kind === 'general' ? 'M' : t.kind === 'agent' ? 'S' : (t.name || '?').trim().charAt(0).toUpperCase();
const avClass = t => t.kind === 'general' ? 'me' : t.kind === 'agent' ? 'agent' : '';
const PIN = { general: 0, agent: 1 };   // Mario, then Shift, then the workers by last message
```
`loadThreads` sort: `threads.sort((a, b) => (PIN[a.kind] ?? 9) - (PIN[b.kind] ?? 9) || (b.last || '').localeCompare(a.last || ''));`
`drawList`: `<div class="av ${avClass(t)}">`; pin: `${t.kind in PIN ? '<span class="pin">📌</span>' : ''}`.
`drawChatBar`: `<div class="av ${avClass(t)}">`; subtitle `${t.kind === 'general' ? 'Mario · site notes and receipts' : t.kind === 'agent' ? 'Shift · ask anything; ✓ to act' : 'worker chat'}`.
`previewText`: `const who = p.by === me.email ? '' : p.by === 'shift' ? 'Shift: ' : esc((p.by || '').split('@')[0]) + ': ';` and before `const body` add `if (p.kind === 'action') return who + '✓ ' + esc(p.text);`.

- [ ] **Step 3: Rendering** — add before `function draw()`:

```js
// ── "Shift", the agent ────────────────────────────────────────────────────────
const isAskText = t => cur === 'shift' || /^@(shift|s)\b/i.test(t || '');
const linkify = s => esc(s).replace(/(https?:\/\/\S+)/g, '<a href="$1" target="_blank" rel="noopener">open ↗</a>');
function agentPost(p) {
  const meta = `<div class="meta"><span>Shift</span><span>${hhmm(p.at)}</span></div>`;
  if (p.kind !== 'action') return `<div class="post agent" data-id="${esc(p.id)}">${esc(p.text)}${meta}</div>`;
  const a = p.action || {}, st = p.status || 'pending';
  const btns = st === 'pending' || st === 'error'
    ? `<div class="b"><button class="ok" onclick="confirmCard('${esc(p.id)}',true)">✓ Do it</button><button class="no" onclick="confirmCard('${esc(p.id)}',false)">✗</button></div>`
    : st === 'running' ? `<div class="d">working…</div>` : '';
  const tail = st === 'done' ? `<div class="r">✓ done${p.receipt ? ' · ' + linkify(p.receipt) : ''}</div>` : st === 'error' ? `<div class="e">${esc(p.error || 'failed')}</div>` : st === 'declined' ? `<div class="d">✗ not done</div>` : '';
  return `<div class="post agent" data-id="${esc(p.id)}"><div class="card-a ${esc(st)}"><div class="s"><b>${esc(a.summary || p.text)}</b></div>${a.detail && a.detail !== a.summary && a.detail !== '1. ' + a.summary ? `<div class="d">${esc(a.detail)}</div>` : ''}${btns}${tail}</div>${meta}</div>`;
}
const asking = new Map();   // post id → deadline, while Shift is answering it
function sysNote(text) { posts.push({ id: 'sys-' + Date.now(), kind: 'sys', text, at: new Date().toISOString(), date: posts.length ? posts[posts.length - 1].date : '', local: true }); }
async function fetchPosts() { const r = await Admin.api('GET', `/api/site/${cur}/posts?limit=100`); posts = r.posts; }
async function pollFor(thread, doneWhen, onTimeout, ms = 60e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 2000));
    if (cur !== thread) return;
    try { await fetchPosts(); } catch { continue; }
    if (doneWhen()) { draw(); return; }
    draw();
  }
  onTimeout(); draw();
}
async function askOne(thread, id) {
  asking.set(id, Date.now() + 60e3); draw();
  try { await Admin.api('POST', `/api/site/${thread}/posts/${id}/ask`, {}); }
  catch (e) { asking.delete(id); sysNote(e.message); draw(); return; }
  await pollFor(thread, () => { const q = posts.find(p => p.id === id); return !!(q && q.answeredAt); }, () => sysNote('Shift is taking long — pull down to refresh, or send it again'));
  asking.delete(id); draw();
}
async function confirmCard(id, ok) {
  const p = posts.find(x => x.id === id); if (!p) return;
  p.status = ok ? 'running' : 'declined'; draw();
  try { const d = await Admin.api('POST', `/api/site/${cur}/posts/${id}/confirm`, { ok }); replacePost(d); draw(); }
  catch (e) { p.status = 'error'; p.error = e.message; draw(); return; }
  if (ok) pollFor(cur, () => { const q = posts.find(x => x.id === id); return !!q && q.status !== 'running'; }, () => sysNote('Still working — pull down to refresh'));
}
```

In `draw()`, right after the `dayHdr`/`lastDay` lines:
```js
    if (p.kind === 'sys') return `${dayHdr}<div class="post sys">${esc(p.text)}</div>`;
    if (p.by === 'shift') return `${dayHdr}${agentPost(p)}`;
```
Text body: `: esc(p.text);` → `: esc(p.text).replace(/^(@(?:shift|s)\b)/i, '<span class="trig">$1</span>');`
End of `draw()` before `const pane = …`:
```js
  if ([...asking.values()].some(t => t > Date.now())) el('feed').insertAdjacentHTML('beforeend', '<div class="post agent typing">Shift is thinking…</div>');
```
`loadPosts`: `const r = await Admin.api(…); posts = r.posts; draw();` → `await fetchPosts(); draw();`; sweep filter → `posts.filter(p => p.by !== 'shift' && !p.agentAsk && !p.error && (…unchanged…))`.

- [ ] **Step 4: Sending**

`sendText`: `await digestOne(cur, p.id);` →
```js
    if (me.admin && isAskText(t)) { await digestOne(cur, p.id); await askOne(cur, p.id); }   // digest marks it a question (no ledger line), then Shift answers
    else await digestOne(cur, p.id);
```
`digestOne`, after `replacePost(d); draw();`: `if (me.admin && d.kind === 'voice' && thread === 'shift' && d.parsed && d.parsed.transcript && !d.askedAt) askOne(thread, d.id);`

- [ ] **Step 5: `?demo=agent` fixture** (hub-verify screenshots without Render) — in the boot block after `await loadThreads();`:

```js
  if (new URLSearchParams(location.search).get('demo') === 'agent' && me.admin) {   // local-only fixture for hub-verify screenshots
    open_('shift'); await fetchPosts();
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }), at = new Date().toISOString();
    posts.push({ id: 'demo-q', thread: 'shift', by: me.email, byAdmin: true, at, date: d, kind: 'text', text: 'pay Khoder 150 from my cash', agentAsk: true, answeredAt: at, digestedAt: at });
    posts.push({ id: 'demo-a', thread: 'shift', by: 'shift', at, date: d, kind: 'text', text: 'One unpaid bill for Khoder (BILL/2026/09/0012, $150). I will pay it from Mario cash.' });
    posts.push({ id: 'demo-c', thread: 'shift', by: 'shift', at, date: d, kind: 'action', text: 'Pay Khoder $150 from Mario cash (87) — S LB', status: 'pending', action: { summary: 'Pay Khoder $150 from Mario cash (87) — S LB', detail: '', writes: [{ id: 'demo', name: 'odoo_register_payment', input: { move_id: 1, journal_id: 87, summary: 'demo' } }] } });
    posts.push({ id: 'demo-d', thread: 'shift', by: 'shift', at, date: d, kind: 'action', text: 'To-do for Christa: send D3 drawings', status: 'done', receipt: 'to-do "send D3 drawings" https://hub.shift-group.co/todo', action: { summary: 'To-do for Christa: send D3 drawings', detail: '', writes: [] } });
    draw(); return;
  }
```

- [ ] **Step 6: Verify locally**

`cd /d/vscode/todo && node verify-hub.mjs --only "/site?demo=agent,/site"` → both `✓` (△ only for known noise). Open the phone screenshot of `/site?demo=agent`: Shift second in the list with the dark "S" avatar, the card with 44 px **✓ Do it / ✗**, the done card green with `open ↗`. If `--only` rejects `?`, run `PORT=8099 node server.js` and open `http://localhost:8099/site?demo=agent` in Edge (Shift+P for the phone view).
Then in plain `/site` open the Shift thread and delete the two smoke posts of Task 8 (long-press → Delete).

- [ ] **Step 7: Commit**

```bash
cd /d/vscode/todo && git add site.html && git commit -m "site chat: Shift thread in the list, agent bubbles, action cards with ✓/✗, ask + poll, demo fixture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Deploy Render, set env, verify the service

Ops only; nothing spends money.

- [ ] **Step 1: Secrets** — `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` → `SITE_AGENT_SECRET`. `HUB_MACHINE_KEY` = the hub's `ACCOUNTING_API_KEY`: `cd /d/vscode/todo && npx vercel env pull .env.agent-tmp --environment production && grep ACCOUNTING_API_KEY .env.agent-tmp; rm .env.agent-tmp` (never commit it).
- [ ] **Step 2: Render env** on `shift-hub` (srv-dab5c4ad0e5s73dd1qug), dashboard or Render MCP `update_environment_variables`: `HUB_URL=https://hub.shift-group.co`, `HUB_MACHINE_KEY=<key>`, `SITE_AGENT_SECRET=<secret>`. Note both in memory `credentials-deploy-map`.
- [ ] **Step 3: Push** — `cd /d/vscode/shift-hub && git push origin main`; poll `curl -s https://shift-hub.onrender.com/` until `loaded` has `"agentSite"` and `failed` is `{}`. A `failed.agentSite` naming an env var = fix env, redeploy.
- [ ] **Step 4: Bearer check** — `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer wrong" -H "Content-Type: application/json" -d '{"thread":"shift","postId":"x"}' https://shift-hub.onrender.com/site-agent` → `401`. (Don't send a real ask from curl: post `x` doesn't exist on the hub.)

---

### Task 11: Deploy the hub, end-to-end on prod

- [ ] **Step 1: Vercel env** — `cd /d/vscode/todo && printf '%s' 'https://shift-hub.onrender.com' | npx vercel env add SITE_AGENT_URL production && printf '%s' '<secret>' | npx vercel env add SITE_AGENT_SECRET production`.
- [ ] **Step 2: hub-verify** (full run, fix ✗), then `cd /d/vscode/todo && npx vercel deploy --prod --yes`.
- [ ] **Step 3: E2E** (Mario on the phone, Claude watching Render logs):
  1. Shift thread → "add a to-do: call Roger about the Q3 VAT, due Friday" → text + card → **✓ Do it** → green receipt with `open ↗`; `/todo` shows the task.
  2. Georges's thread → "@shift add 40$ diesel for him today" → card → **✗** → "✗ not done"; `/accounting/daily` unchanged.
  3. Shift thread → "how much is unpaid for Khoder" → text answer, no card.
  4. Shift thread → "pay $1 of Khoder's oldest unpaid bill from my cash" → card → **✓** → receipt `paid bill … → payment [...]`. Then **ask Mario** before cancelling/deleting that $1 payment (memory `odoo-delete-cancelled-entries`).
  5. Restart resilience: get a card, trigger a Render redeploy before ✓, then ✓ → still executes.
- [ ] **Step 4: Memory** — update `site-chat-project.md` (Shift thread live, routes, env), `credentials-deploy-map.md`, `shift-hub-merged-service.md` (agentSite, `npm test`); pointer lines in `MEMORY.md` if a file is new. Push both repos.

---

## Self-review

**Spec coverage** — trigger + admin-only (T7/T8/T9); last-20 context + ledger map (T7/T8/T2); loop reuse with hub tools + card hook (T1/T3/T4); restart-safe cards (`writes` in the card, `applyWrites` without session: T2/T4/T8); three writes (T3 defs, T8 exec, Odoo via existing `runTool`); `src:'agent', review:true` (T8 → `writeLine` src override); errors — waking 504 (T8/T9), tool error keeps the card with buttons (T8 settle + T9), unknown ledger asks (T2 prompt + exec 400), non-admin ignored (`isTrigger`, `/ask` 403); UI (T9); config + rollback (T10/T11 — no `SITE_AGENT_URL` → `/ask` 503, thread silent); testing (T1–T7 node:test, T5 harness, T9 hub-verify, T11 prod E2E with Mario's ok on the $1 deletion). Voice: covered in the Shift thread (T9 `digestOne` hook); `@shift` by voice in a worker thread is v2.

**Placeholders** — none.

**Type consistency** — `hub.reply(thread, {kind, text|action, replyTo})` ↔ `/reply`; `hub.exec(write, postId)` ↔ `/exec {write, postId}` ↔ `runHubTool(hub, name, input, postId)`; `settle {status, receipt, error}` ↔ `/settle`; card `writes: [{id,name,input}]` ↔ `applyWrites(session, writes, …)` ↔ `/confirm` forwards `post.action.writes`; `receiptOf(name, out)` reads `{receipt,url}` (hub exec) and the Odoo tool JSON (`runTool`).
