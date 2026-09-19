# Shift agent in Shift WhatsApp — design (2026-09-20)

Sub-project 1 of the "Salesforce + Slack" hub update (order agreed with Mario:
1 agent in chat → 2 CRM/pipeline page → 3 channels/threads/search → 4 agents
posting their work in the chat). Source idea: Benioff on CNBC — Slack CRM,
"Slackforce" AI front end on Anthropic, coding agents in channels.

## Goal
A "Shift" member in the hub site chat (/site) that Mario can ask anything about
Odoo and hub data, and that drafts three kinds of actions which execute only
after his ✓ in the chat.

## Scope (v1)
- Users: **Mario only** (posts with `byAdmin`). Workers/partners typing `@shift`
  are ignored silently.
- Read & answer from Odoo (JSON-RPC tools) + hub Firestore (worker ledgers,
  to-dos, site posts of the current thread).
- Draft, gated by ✓: `odoo_register_payment`, `hub_worker_line`, `hub_todo`.
- Out of scope (v2): bill-from-photo, thread summaries, worker/partner access.

## Architecture
- **Hub (Vercel, `todo/site.js`)**
  - New thread `shift` (kind `agent`, name "Shift", admin-only, pinned after
    Mario in the Chats list).
  - Trigger: any admin post in `shift`, or any admin post in another thread
    whose text starts with `@shift` / `@s`. Voice/photo posts use the existing
    whisper transcript / vision text.
  - Forwards `{thread, postId, text, context: last 20 posts, ledger: {account,
    worker}}` to Render `POST $SITE_AGENT_URL/site-agent` with
    `Authorization: Bearer $SITE_AGENT_SECRET`.
  - Accepts agent replies on the existing `POST /api/site/:thread/posts` when
    called with the machine bearer (`ACCOUNTING_API_KEY`), `by:'shift'`,
    `kind:'text' | 'action'`.
  - New `POST /api/site/:thread/posts/:id/confirm` `{ok:true|false, note?}`
    → forwards to Render `/site-agent/confirm`; updates the action post with
    `status: 'done'|'declined'|'error'`, `receipt`, `error`.
- **Render `shift-hub`, new `bots/agent-site/`**
  - Reuses `bots/agent/agent.mjs` loop, Odoo tools, write gate (`WRITE_TOOLS`,
    `pending`, `resolvePending`). Session key = hub thread id.
  - Adds gated tools `hub_worker_line` and `hub_todo` calling the hub API with
    `HUB_URL` + `HUB_MACHINE_KEY`.
  - When the loop stops at write blocks, posts one `kind:'action'` post per
    turn: `{summary, detail, writes:[...full tool inputs...]}`. The payload is
    self-contained so ✓ executes even after a Render restart clears the session.
  - Handler exported like the other bots; `GET /` reports it loaded.
- **System prompt**: Telegram bot prompt (all company/journal/vendor ids) +
  thread→worker→ledger map + rules: search before writing, never invent ids,
  USD default, no vendor/analytic creation, one action per card unless Mario
  asked for several.

## Tools (writes)
| tool | hub/Odoo call | card text | receipt |
|---|---|---|---|
| `odoo_register_payment` | existing | "Pay Khoder $150 from Mario cash (87) — S LB" | payment name + Odoo link |
| `hub_worker_line` | `POST /api/accounting/lines` `{account,date,description,amount,side,analytic?}` → `src:'agent', review:true` (stays in the statement-round ✓ queue) | "Georges ledger: +$40 diesel, 20 Sep, RAV4" | hub row link |
| `hub_todo` | `POST /api/tasks` `{title,assignee?,due?}` | "To-do for Christa: send D3 drawings — due Mon" | task id |

## Error handling
- No reply from Render within 25 s → hub posts a grey system bubble "Shift is
  waking up… send again"; Mario's post stays.
- Tool error on ✓ → card shows the error in red and stays pending (✓ retry or ✗).
- Unknown thread / no ledger → agent asks in text which worker; never guesses.
- Non-admin trigger → ignored, no bubble.

## UI (`site.html`, `site.js` front end)
- Chats list: "Shift" pinned second, amber avatar "S", preview = last reply.
- Agent bubbles left-aligned, amber left border, name "Shift"; "…" typing
  bubble while a request is in flight (existing 2 s poll).
- Action card: summary, grey detail line, buttons **✓ Do it** (amber) / **✗**,
  44 px tall. Done → green tick + receipt + link; declined → struck through;
  error → red text, buttons stay.
- In site threads the `@shift …` prefix in Mario's bubble is highlighted amber.

## Config
- Vercel: `SITE_AGENT_URL`, `SITE_AGENT_SECRET`.
- Render: `HUB_URL`, `HUB_MACHINE_KEY` (= hub `ACCOUNTING_API_KEY`),
  `SITE_AGENT_SECRET`; `ANTHROPIC_KEY`, `ODOO_*` already shared. Model
  `claude-sonnet-4-6`, override `AGENT_MODEL`.
- Rollback: remove `SITE_AGENT_URL` on Vercel — the thread stops answering.

## Testing
- Render: local harness (like `local.mjs`) with mocked hub API — one read
  ("Abed balance"), one gated write to a scratch to-do, one ✗, one
  restart-then-✓ using only the card payload.
- Hub: `hub-verify` with `/site` showing the Shift thread + a fixture pending
  card, desktop + phone.
- Prod end-to-end once: ✓ a to-do, ✗ a worker line, ✓ a $1 Odoo payment then
  delete it (deletion only after Mario's ok).

## Rollout
1. Render handler (additive). 2. Hub deploy after hub-verify. 3. Env vars.
