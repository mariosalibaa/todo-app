# Site chat — part 1 (daily flag, read-only Day report, General thread) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new app flags (`daily`, `site`), a partner-safe read-only Day report, and the `/site` page with Mario's General thread — text / photo / video / voice posts that become *suggestion* lines on Mario cash behind the existing ✓ gate.

**Architecture:** Same shape as every hub module: one Node file per API area mounted from `server.js` by URL prefix (`site.js` → `/api/site/*`), one HTML page per screen served from the `PAGES` map, Firestore under `workspaces/team/…`, files in the Storage bucket with the Firestore `txDocs` fallback. Suggestion lines reuse the `tx` schema exactly as the WhatsApp import writes it (`review: true`, `excluded: true`, `waAccepted: false`), so the Day report, Accounts grid and Statements need no new gate. Parsing runs *after* the post is saved and never blocks it.

**Tech Stack:** Node ≥ 20 (plain `http` server, no framework), firebase-admin 12, Claude API (`claude-haiku-4-5-20251001` for text, `claude-sonnet-5` for vision), OpenAI Whisper (`whisper-1`) for voice notes, vanilla HTML/JS pages with `admin-shared.js` + `hub-history.js`. Tests: `node --test` for pure functions, a headless Chromium script (Playwright from `D:\vscode\wa-contacts\node_modules`) against the local hub on port 8081 (sign-in disabled).

## Global Constraints

- The todo folder is **not a git repository**; "commit" steps are `cp file file.bak-<tag>` before the edit (the folder's convention) — no git commands.
- Never `toISOString()` for a yyyy-mm-dd in browser code; Beirut is UTC+3 (use `ymd()` from the page).
- No line is ever written accepted: every line from a post carries `src: 'site', review: true, excluded: true, waAccepted: false`.
- Default payer is Mario cash: account id `mario-cash` (check with `curl -s http://127.0.0.1:8081/api/accounting/accounts | python -m json.tool | grep '"id"'` before Task 5 and fix the constant if it differs).
- Copy: "Paid by Shift" / "Due to employee" are the two money columns; a proposed line is a **suggestion**.
- Deploy only when Mario says so: `cd D:\vscode\todo; vercel --prod` in the same command (never from another cwd).
- Local hub: `D:\vscode\todo\start-todo.bat` → http://127.0.0.1:8081, `authDisabled` = every app, admin.

## File map

| File | Responsibility |
|---|---|
| `server.js` | `APPS` list, allowlist fields `account` / `projects`, the `daily` GET exception, mounting `site.js`, `/site` page + static list |
| `hub.html` | members table: `daily` and `site` checkboxes, Site tile |
| `admin-shared.js` | local `me.apps` includes the new flags |
| `daily-access.js` (new) | pure: `filterForPartner(lines, projects)`, `readOnlyFor(access)` |
| `accounts.js` | daily GET: partner filter + `readOnly` flag |
| `daily.html` | read-only mode; `site` suggestions look like WhatsApp ones; progress media under the day |
| `hub-files.js` (new) | `saveFile` / `readFile`: bucket first, `txDocs` fallback (lifted from the docs route so both share it) |
| `site-parse.js` (new) | pure + AI: `quickParse`, `claudeParse`, `visionRead`, `whisper` → `{ amount, currency, partner, project, paidFrom, note, receipt }` |
| `site.js` (new) | `/api/site/*`: threads, posts, files, the post → suggestion line |
| `site.html` (new) | the page: thread list (admin), composer, posts with their line state |
| `test/daily-access.test.js`, `test/site-parse.test.js` (new) | `node --test` |
| `test/e2e-site.mjs` (new) | headless run against 8081 |

---

### Task 1: App flags `daily` and `site`

**Files:**
- Modify: `server.js:373` (APPS), `server.js:805-812` (allowlist POST), `server.js:793-800` (allowlist GET passes fields through already via `...x`)
- Modify: `hub.html:77-82` (tiles), `hub.html:100-115` (members table), `hub.html:125-131` (addMember)
- Modify: `admin-shared.js:115`

**Interfaces:**
- Produces: `access.apps` may contain `'daily'` and `'site'`; allowlist doc may carry `account: string` (the ledger account id of a worker) and `projects: number[]` (analytic ids a partner may see). `accessFor()` returns them as `access.account`, `access.projects`.

- [ ] **Step 1: Back up**

```powershell
cd D:\vscode\todo; cp server.js server.js.bak-siteflags; cp hub.html hub.html.bak-siteflags; cp admin-shared.js admin-shared.js.bak-siteflags
```

- [ ] **Step 2: APPS + accessFor carry the new fields**

In `server.js` replace:
```js
const APPS = ['todo', 'accounting', 'partners', 'ajaltoun'];
```
with
```js
// daily = may READ the Day report (a partner, filtered to his projects); site = may post on /site
// (a worker: his own thread only). Neither opens anything else.
const APPS = ['todo', 'accounting', 'partners', 'ajaltoun', 'daily', 'site'];
```
In `allowlistMap()` change the `map.set` line to:
```js
      map.set(email, { email, apps: Array.isArray(x.apps) ? x.apps.filter(a => APPS.includes(a)) : ['todo'],
        account: typeof x.account === 'string' ? x.account : '',           // a worker's own ledger (site thread)
        projects: Array.isArray(x.projects) ? x.projects.map(Number).filter(Boolean) : [] });   // a partner's analytic ids (daily)
```
In `accessFor()` change the return to:
```js
  return { email: e, apps: isAdmin ? APPS.slice() : entry.apps, admin: isAdmin,
    account: entry ? entry.account : '', projects: entry ? entry.projects : [] };
```
In the allowlist POST, after `if (Array.isArray(b.apps)) doc.apps = …` add:
```js
        if ('account' in b) doc.account = String(b.account || '').replace(/[^\w-]/g, '').slice(0, 40);
        if ('projects' in b) doc.projects = (Array.isArray(b.projects) ? b.projects : []).map(Number).filter(n => n > 0).slice(0, 50);
```

- [ ] **Step 3: Members table + Site tile in hub.html**

In the `APPS` tile list add after the ajaltoun entry:
```js
  { id: 'site', ico: '📍', name: 'Site', desc: 'Post your day: text, photos, a voice note. Start and Finish with your location.', href: '/site' },
```
(`daily` has no tile — it opens the Day report inside Accounting; the members table is its only switch.)

In the members table row, after the ajaltoun checkbox cell add two cells:
```js
        <td class="c"><input type="checkbox" data-app="daily" ${apps.includes('daily') ? 'checked' : ''} ${m.admin ? 'disabled' : ''} onchange="toggleApp(this)" title="May read the Day report — only the lines of his projects"></td>
        <td class="c"><input type="checkbox" data-app="site" ${apps.includes('site') ? 'checked' : ''} ${m.admin ? 'disabled' : ''} onchange="toggleApp(this)" title="May post on /site — his own thread"></td>
        <td><input class="small" value="${esc(m.account || '')}" placeholder="ledger id" title="The worker's ledger account id, e.g. khodr-cash (site)" onchange="setField('${esc(m.email)}','account',this.value)"></td>
        <td><input class="small" value="${esc((m.projects || []).join(','))}" placeholder="analytic ids" title="Analytic account ids the partner may see on the Day report, e.g. 69,59,60,61,62,63,64" onchange="setField('${esc(m.email)}','projects',this.value)"></td>
```
Find the `<thead>` of that table and add matching headers `Daily`, `Site`, `Ledger`, `Projects`; bump both `colspan="6"` to `colspan="10"`. Add the style `.small{width:110px;font-size:.75rem;padding:4px 6px;}` next to the table styles. Add the function beside `toggleApp`:
```js
async function setField(email, field, value) {
  const body = { email };
  body[field] = field === 'projects' ? value.split(/[ ,;]+/).map(Number).filter(n => n > 0) : value.trim();
  try { await Admin.api('POST', '/api/allowlist', body); }
  catch (e) { alert('Could not save: ' + e.message); }
}
```
The hub's tile filter already shows a tile only when `me.apps` includes its id — verify by reading the render code near `APPS.filter`; no change if so.

- [ ] **Step 4: Local mode knows the flags**

`admin-shared.js` line 115: `apps: ['todo', 'accounting', 'partners', 'ajaltoun', 'daily', 'site']`.

- [ ] **Step 5: Verify**

Restart the hub (`start-todo.bat`), open http://127.0.0.1:8081/admin: the members table shows the four new columns; the Site tile appears. `curl -s http://127.0.0.1:8081/api/me` → `apps` lists six entries.

---

### Task 2: Partner filter for the Day report (pure)

**Files:**
- Create: `daily-access.js`, `test/daily-access.test.js`

**Interfaces:**
- Produces: `filterForPartner(lines, projects) → lines` — keeps a line only when it is not a suggestion and one of its analytic ids is in `projects`; `readOnlyFor(access) → boolean` — true when the caller holds `daily` but not `accounting` and is not admin; `isSuggestion(t) → boolean` — `(t.src === 'whatsapp' || t.src === 'site') && !t.waAccepted`.

- [ ] **Step 1: Failing tests**

`test/daily-access.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { filterForPartner, readOnlyFor, isSuggestion } = require('../daily-access');

test('a partner sees only accepted lines on his projects', () => {
  const lines = [
    { id: 'a', analyticId: 69, src: 'manual' },
    { id: 'b', analyticId: 2, src: 'manual' },
    { id: 'c', analyticSplit: [{ id: 62, pct: 50 }, { id: 2, pct: 50 }], src: 'manual' },
    { id: 'd', analyticId: 69, src: 'whatsapp', waAccepted: false },
    { id: 'e', analyticId: 69, src: 'site', waAccepted: true },
    { id: 'f', src: 'manual' },
  ];
  assert.deepStrictEqual(filterForPartner(lines, [69, 62]).map(l => l.id), ['a', 'c', 'e']);
  assert.deepStrictEqual(filterForPartner(lines, []), []);
});

test('read-only is daily without accounting', () => {
  assert.strictEqual(readOnlyFor({ apps: ['daily'], admin: false }), true);
  assert.strictEqual(readOnlyFor({ apps: ['daily', 'accounting'], admin: false }), false);
  assert.strictEqual(readOnlyFor({ apps: [], admin: true }), false);
});

test('a suggestion is an unaccepted whatsapp or site line', () => {
  assert.strictEqual(isSuggestion({ src: 'site' }), true);
  assert.strictEqual(isSuggestion({ src: 'whatsapp', waAccepted: true }), false);
  assert.strictEqual(isSuggestion({ src: 'manual' }), false);
});
```

- [ ] **Step 2: Run, expect failure**

`cd D:\vscode\todo; node --test test/daily-access.test.js` → FAIL, `Cannot find module '../daily-access'`.

- [ ] **Step 3: Implement**

`daily-access.js`:
```js
// Who may see what on the Day report. A partner holding only `daily` reads the lines of his own
// projects, accepted ones only — never a suggestion, never another project (Mario, 2026-09-12).
const isSuggestion = t => (t.src === 'whatsapp' || t.src === 'site') && !t.waAccepted;
const analyticIds = t => Array.isArray(t.analyticSplit) && t.analyticSplit.length
  ? t.analyticSplit.map(s => +s.id) : t.analyticId ? [+t.analyticId] : [];
function filterForPartner(lines, projects) {
  const allowed = new Set((projects || []).map(Number));
  if (!allowed.size) return [];
  return lines.filter(t => !isSuggestion(t) && !t.excluded && analyticIds(t).some(id => allowed.has(id)));
}
const readOnlyFor = access => !access.admin && !(access.apps || []).includes('accounting') && (access.apps || []).includes('daily');
module.exports = { filterForPartner, readOnlyFor, isSuggestion };
```

- [ ] **Step 4: Run, expect pass**

`node --test test/daily-access.test.js` → 3 pass.

---

### Task 3: Day report opens for `daily` holders, read-only and filtered

**Files:**
- Modify: `server.js:744-746` (the accounting gate), `server.js:749` (ctx gets `access`)
- Modify: `accounts.js:587-603` (daily GET)
- Modify: `daily.html` (`Admin.require`, read-only mode, `isSuggestion`)

**Interfaces:**
- Consumes: `daily-access.js` from Task 2; `access.projects` from Task 1.
- Produces: `GET /api/accounting/daily` answers `{ date, since, people, lines, readOnly }`; with `readOnly: true` the `people` array is empty and lines are filtered.

- [ ] **Step 1: Back up** — `cp accounts.js accounts.js.bak-dailyro; cp daily.html daily.html.bak-dailyro; cp server.js server.js.bak-dailyro`

- [ ] **Step 2: Gate exception in server.js**

Replace
```js
  if (url.startsWith('/api/accounting/')) {
    if (!access.apps.includes('accounting')) return noApp('accounting');
```
with
```js
  if (url.startsWith('/api/accounting/')) {
    // a `daily` holder (a partner) may READ the day report and nothing else under accounting
    const dailyRead = req.method === 'GET' && /^\/api\/accounting\/(daily|analytic)(\?|$)/.test(url) && access.apps.includes('daily');
    if (!access.apps.includes('accounting') && !dailyRead) return noApp('accounting');
```
and add `access` to the ctx: `const ctx = { db, admin, TEAM_ID, odooCall, local: AUTH_DISABLED, access };`

- [ ] **Step 3: The daily GET filters**

At the top of `accounts.js` add `const dailyAccess = require('./daily-access');`. In the daily GET, replace the final `return json(res, 200, { date, since, people: …, lines });` with:
```js
    const access = ctx.access || { apps: ['accounting'], admin: true, projects: [] };
    const readOnly = dailyAccess.readOnlyFor(access);
    const shown = readOnly ? dailyAccess.filterForPartner(lines, access.projects) : lines;
    return json(res, 200, { date, since, readOnly,
      people: readOnly ? [] : people.map(p => ({ id: p.id, name: p.name, owner: p.owner || '', odooPartner: p.odooPartner || null, defaultRate: p.defaultRate || 0, defaultProject: p.defaultProject || null, wa: !!((p.whatsapp && p.whatsapp.chatName) || WA_CHATS[p.id]) })),
      lines: shown });
```
The `ctx` destructuring at the top of `handle` stays; `ctx.access` is read where needed.

- [ ] **Step 4: daily.html read-only mode**

Replace `Admin.require('accounting', async me => {` with `Admin.require(null, async me => {` and, as the first lines inside, add:
```js
  if (!me.apps.includes('accounting') && !me.apps.includes('daily')) { document.body.innerHTML = '<p style="padding:40px;color:#a6adc8">This page is not open to your account.</p>'; return; }
  READ_ONLY = !me.admin && !me.apps.includes('accounting');
  if (READ_ONLY) document.body.classList.add('ro');
```
Declare `let READ_ONLY = false;` next to `let people = …`. Add the CSS:
```css
  body.ro .card.write, body.ro #hh-host, body.ro .docbtn, body.ro #spanbtn ~ .adminonly { display:none !important; }
```
Give the "Write the day" card the class `write` (find `<div class="card">` that contains `WRITE THE DAY` and add `write`). In `drawLines()` change `const sug = isSuggestion(t);` to `const sug = !READ_ONLY && isSuggestion(t);` — the server already strips suggestions for a partner, this keeps the page honest if not. Replace the page's `isSuggestion` with the shared rule:
```js
const isSuggestion = t => (t.src === 'whatsapp' || t.src === 'site') && !t.waAccepted;
```
In `load()` skip `drawDrafts()` and `drawWa()` when `READ_ONLY`.

- [ ] **Step 5: Verify (local = admin, so simulate)**

`node --test` still green. In the browser console on http://127.0.0.1:8081/accounting/daily run `document.body.classList.add('ro')` → the write card, undo bar and camera buttons vanish. Then an API check with a fake partner: temporarily add to `server.js` under the `/api/me` route nothing — instead run:
```js
// node -e in D:\vscode\todo
const d = require('./daily-access');
console.log(d.filterForPartner([{ analyticId: 69, src: 'manual' }, { analyticId: 2, src: 'manual' }], [69]).length); // 1
```
Live verification of the real gate happens on Vercel with Antoine's account once Mario ticks `daily` — noted in the final report, not done now.

---

### Task 4: `hub-files.js` — one place that stores a file

**Files:**
- Create: `hub-files.js`
- (Leave the docs route in `accounts.js` as is — it works; the site module uses the new helper. Merging the two is a later cleanup.)

**Interfaces:**
- Produces:
  - `saveFile(ctx, { buf, mime, name, key, who, meta }) → { id, name, mime, size, key, store, at, by }` — bucket if it exists, else `workspaces/team/txDocs/<id>` with `b64` (refuses > 900 KB with an Error whose message tells Mario to enable Storage).
  - `streamFile(ctx, doc, res)` — writes the bytes with `Content-Type`, 404 if gone.

- [ ] **Step 1: Implement**

```js
// One file, stored once: the Storage bucket when it exists, else a Firestore document of its
// own (never on a line — the grids read lines by the thousand). Lifted from the tx docs route
// (accounts.js) for the site page; both keep the same { key, store } record.
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const now = () => new Date().toISOString();

async function saveFile(ctx, { buf, mime, name, key, who, meta }) {
  const { admin, db, TEAM_ID } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const id = newId();
  let store = 'bucket';
  try {
    const bk = admin.storage().bucket();
    const [live] = await bk.exists();
    if (!live) throw new Error('bucket not created');
    await bk.file(key).save(buf, { contentType: mime, resumable: false, metadata: { metadata: { ...(meta || {}), by: who } } });
  } catch (e) {
    if (buf.length > 900e3) throw new Error('Firebase Storage is not enabled for this project, so a file must stay under 900 KB. Enable Storage in the Firebase console and any size will work.');
    await ws.collection('txDocs').doc(id).set({ ...(meta || {}), mime, name: String(name || '').slice(0, 120), b64: buf.toString('base64'), at: now(), by: who });
    store = 'firestore';
    console.warn('file kept in Firestore (Storage not enabled):', e.message);
  }
  return { id, name: String(name || '').slice(0, 120), mime, size: buf.length, key, store, at: now(), by: who };
}

async function streamFile(ctx, doc, res) {
  const { admin, db, TEAM_ID } = ctx;
  let buf;
  if (doc.store === 'firestore') {
    const d = await db.collection('workspaces').doc(TEAM_ID).collection('txDocs').doc(doc.id).get();
    if (d.exists) buf = Buffer.from(d.data().b64 || '', 'base64');
  } else {
    try { [buf] = await admin.storage().bucket().file(doc.key).download(); } catch (e) { buf = null; }
  }
  if (!buf) { res.writeHead(404); res.end('file gone'); return; }
  res.writeHead(200, { 'Content-Type': doc.mime || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
  res.end(buf);
}
module.exports = { saveFile, streamFile };
```

- [ ] **Step 2: Smoke**

`node -e "const f=require('./hub-files'); console.log(typeof f.saveFile, typeof f.streamFile)"` → `function function`.

---

### Task 5: `site-parse.js` — from a post to `{ amount, partner, project, paidFrom … }`

**Files:**
- Create: `site-parse.js`, `test/site-parse.test.js`

**Interfaces:**
- Consumes: `ledgers.parseMoney(text, owner, fromMe, lbpRate)` (exported from `ledgers.js`) for the deterministic amount/side.
- Produces:
  - `quickParse(text, { fromMe, owner, lbpRate }) → { amount, currency, side: 'debit'|'credit'|null, skip? } | null`
  - `matchName(text, list) → item|null` where `list = [{ id, name }]` — longest case-blind name contained in the text.
  - `claudeParse(text, { analytics, partners, accounts }) → { amount, currency, partner, project, paidFrom, note }` (Anthropic Messages API, `claude-haiku-4-5-20251001`, JSON out; null fields when unsure).
  - `visionRead(buf, mime) → { receipt: boolean, vendor, amount, currency, date, note }` (`claude-sonnet-5`).
  - `whisper(buf, mime) → string` (OpenAI `whisper-1`, `OPENAI_API_KEY`; throws when no key).

- [ ] **Step 1: Failing tests (pure parts)**

`test/site-parse.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { quickParse, matchName } = require('../site-parse');

test('a bare amount from the worker is what he is owed', () => {
  const r = quickParse('750$', { fromMe: false, owner: 'Khodr' });
  assert.strictEqual(r.amount, 750); assert.strictEqual(r.currency, 'USD'); assert.strictEqual(r.side, 'debit');
});
test('paid from Mario is money he received', () => {
  const r = quickParse('paid 200$', { fromMe: true, owner: 'Khodr' });
  assert.strictEqual(r.side, 'credit');
});
test('no amount → null', () => {
  assert.strictEqual(quickParse('excavation D1 today', { fromMe: false, owner: 'Khodr' }), null);
});
test('the longest name in the text wins', () => {
  const list = [{ id: 1, name: 'Bilal' }, { id: 2, name: 'Bilal Aluminum' }, { id: 3, name: 'Ajaltoun 4193' }];
  assert.strictEqual(matchName('paid bilal aluminum 200 ajaltoun', list).id, 2);
  assert.strictEqual(matchName('nothing here', list), null);
});
```

- [ ] **Step 2: Run, expect failure** — `node --test test/site-parse.test.js` → `Cannot find module '../site-parse'`.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run, expect pass** — `node --test test/site-parse.test.js` → 4 pass.

- [ ] **Step 5: Live probe of the AI parts (needs the keys in the hub's env)**

```js
// D:\vscode\todo> node -e "require('dotenv')" is not used here; the hub reads process.env set by start-todo.bat.
// Run from the same env as the server:
node -e "const p=require('./site-parse'); p.claudeParse('paid bilal 200 aluminum ajaltoun from whish',{analytics:[{name:'Ajaltoun 4193'}],partners:[{name:'Bilal (Aluminum)'}],accounts:[{name:'Whish'},{name:'Mario cash'}]}).then(x=>console.log(x))"
```
Expected: `{ amount: 200, currency: 'USD', partner: 'Bilal (Aluminum)', project: 'Ajaltoun 4193', paidFrom: 'Whish', note: 'aluminum' }` (wording may vary; amount/partner/project/paidFrom must match).

---

### Task 6: `site.js` — threads, posts, files, the suggestion line

**Files:**
- Create: `site.js`
- Modify: `server.js` (mount under `/api/site/`, `PAGES['/site'] = 'site.html'`, FILE map)

**Interfaces:**
- Consumes: `hub-files.saveFile/streamFile`, `site-parse.*`, `accounts.resolve/txCol/listAccounts`, `accounting` route `/api/accounting/analytic` (its data source: call `odooCall('account.analytic.account','search_read',[[['active','=',true]]],{fields:['name'],context:{allowed_company_ids:[2,4,7,8,9,10]}})` directly).
- Produces (all under the `site` app; admins see every thread, a worker only `access.account`; `general` is admin-only):
  - `GET  /api/site/threads` → `[{ id, name, kind: 'general'|'worker', last }]`
  - `GET  /api/site/:thread/posts?before=<iso>&limit=50` → `{ posts: [...] }` newest last
  - `POST /api/site/:thread/posts` `{ kind: 'text'|'photo'|'video'|'voice', text?, dataBase64?, mime?, name?, date? }` → the post (parse runs after the reply)
  - `GET  /api/site/:thread/posts/:id/file` → bytes
  - `POST /api/site/:thread/posts/:id/flip` → toggles receipt ↔ progress on a photo/video post and redoes the line
  - Post doc: `{ id, thread, by, at, date, kind, text, file?, parsed?, line?: { accountId, txId, state }, error? }` in `workspaces/team/site/<thread>/posts/<id>`.
  - Line written: `tx` on the target account with `src: 'site', postId, review: true, excluded: true, waAccepted: false, daily: false`.

- [ ] **Step 1: Back up server.js** — `cp server.js server.js.bak-sitemount`

- [ ] **Step 2: Write site.js**

```js
// /site — the conversation that replaces the WhatsApp groups. Mounted by server.js under
// /api/site/*; ctx = { db, admin, TEAM_ID, odooCall, access }.
// A post is saved first and answered at once; the parse runs after and hangs a SUGGESTION line
// on the right ledger (review + excluded, exactly like a WhatsApp proposal) — Mario's ✓ on the
// Day report / Accounts / Statements is the only way a line becomes real (Mario, 2026-09-12).
const acc = require('./accounts');
const files = require('./hub-files');
const parse = require('./site-parse');

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const money = n => Math.round((+n || 0) * 100) / 100;
const beirutDay = d => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const MARIO_CASH = 'mario-cash';   // the default payer (see Global Constraints)
const CTX = { allowed_company_ids: [2, 4, 7, 8, 9, 10] };
const readBody = (req, max = 20e6) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', c => { data += c; if (data.length > max) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } }); req.on('error', reject);
});

// which threads this caller may open
async function threadsFor(ctx) {
  const ws = ctx.db.collection('workspaces').doc(ctx.TEAM_ID);
  const people = (await acc.listAccounts(ws)).filter(a => a.daily && !a.archived);
  const all = [{ id: 'general', name: 'General', kind: 'general' }, ...people.map(p => ({ id: p.id, name: p.name, kind: 'worker' }))];
  return ctx.access.admin ? all : all.filter(t => t.kind === 'worker' && t.id === ctx.access.account);
}

let refCache = { at: 0, analytics: [], partners: [] };
async function refs(ctx) {
  if (Date.now() - refCache.at < 600e3) return refCache;
  const [analytics, partners] = await Promise.all([
    ctx.odooCall('account.analytic.account', 'search_read', [[['active', '=', true]]], { fields: ['name'], context: CTX, limit: 500 }),
    ctx.odooCall('res.partner', 'search_read', [[['supplier_rank', '>', 0]]], { fields: ['name'], context: CTX, limit: 2000 }),
  ]);
  refCache = { at: Date.now(), analytics, partners };
  return refCache;
}

// the suggestion line for a post; `target` = the ledger account id
async function writeLine(ctx, ws, post, target, fields) {
  const a = await acc.resolve(ws, target);
  if (!a) throw new Error('no ledger ' + target);
  const id = 'site-' + post.id;
  const t = { id, src: 'site', postId: post.id, thread: post.thread, date: post.date, ref: '', service: 'Site', phone: '',
    description: String(fields.description || post.text || '').slice(0, 160),
    debit: fields.side === 'debit' ? money(fields.amount) : 0, credit: fields.side === 'credit' ? money(fields.amount) : 0,
    nature: fields.nature || 'expense', natureSrc: 'site',
    analyticId: fields.analytic ? fields.analytic.id : null, analyticName: fields.analytic ? fields.analytic.name : '', analyticSrc: fields.analytic ? 'site' : '',
    partnerId: fields.partner ? fields.partner.id : (a.odooPartner ? a.odooPartner.id : null), partnerName: fields.partner ? fields.partner.name : (a.odooPartner ? a.odooPartner.name : ''), partnerSrc: fields.partner ? 'site' : (a.odooPartner ? 'auto' : ''),
    note: String(fields.note || ''), noteSrc: fields.note ? 'site' : '',
    review: true, excluded: true, waAccepted: false, waFrom: post.by === ctx.access.email && ctx.access.admin ? 'mario' : 'them', waAt: post.at,
    docs: post.file ? [post.file] : [], createdAt: now(), createdBy: post.by, updatedAt: now(), updatedBy: post.by };
  if (!t.debit && !t.credit) { t.noBook = true; t.ask = 'no amount yet — price this before booking'; }
  await acc.txCol(a).doc(id).set(t);
  return { accountId: a.id, txId: id, state: 'waiting' };
}

// after the post is stored: read it, decide, write the line, record the outcome on the post
async function digest(ctx, ws, ref, post, buf) {
  const isGeneral = post.thread === 'general';
  const fromMe = ctx.access.admin;
  try {
    let text = post.text || '', parsed = {}, line = null;
    if (post.kind === 'voice') { text = await parse.whisper(buf, post.file.mime); parsed.transcript = text; }
    if (post.kind === 'photo' || post.kind === 'video') {
      if (post.kind === 'photo') Object.assign(parsed, await parse.visionRead(buf, post.file.mime));
      else parsed.receipt = false;
      if (post.receiptOverride != null) parsed.receipt = !!post.receiptOverride;
      if (parsed.receipt && parsed.amount) {
        const { partners, analytics } = await refs(ctx);
        const partner = parsed.vendor ? parse.matchName(parsed.vendor, partners) : null;
        line = await writeLine(ctx, ws, post, isGeneral ? MARIO_CASH : post.thread,
          { amount: parsed.amount, side: isGeneral ? 'credit' : 'debit', description: [parsed.vendor, parsed.note].filter(Boolean).join(' · '), partner, analytic: null });
      }
      // a site photo/video = progress; it is kept on the post and the Day report shows it under the day (part 2 hangs it on the attendance line)
    }
    if (text) {
      const { partners, analytics } = await refs(ctx);
      if (isGeneral) {
        const c = await parse.claudeParse(text, { analytics, partners, accounts: (await acc.listAccounts(ws)).filter(a => !a.daily && !a.archived) });
        Object.assign(parsed, c);
        if (c.amount) {
          const partner = c.partner ? parse.matchName(c.partner, partners) : null;
          const analytic = c.project ? parse.matchName(c.project, analytics) : null;
          const paidFrom = c.paidFrom ? parse.matchName(c.paidFrom, (await acc.listAccounts(ws)).map(a => ({ id: a.id, name: a.name }))) : null;
          line = await writeLine(ctx, ws, post, paidFrom ? paidFrom.id : MARIO_CASH,
            { amount: c.amount, side: 'credit', description: [partner ? partner.name : c.partner, c.note].filter(Boolean).join(' · '), partner, analytic, note: '' });
        }
      } else {
        const q = parse.quickParse(text, { fromMe, owner: post.thread });
        Object.assign(parsed, q || {});
        if (q && q.amount && q.side) {
          const analytic = parse.matchName(text, analytics);
          line = await writeLine(ctx, ws, post, post.thread, { amount: q.amount, side: q.side, description: text, analytic, nature: 'labour' });
        }
      }
    }
    await ref.set({ parsed, line, digestedAt: now() }, { merge: true });
  } catch (e) {
    console.error('site digest', post.id, e.message);
    await ref.set({ error: String(e.message || e).slice(0, 200), digestedAt: now() }, { merge: true });
  }
}

async function handle(req, res, url, user, ctx) {
  const { db, TEAM_ID, access } = ctx;
  const ws = db.collection('workspaces').doc(TEAM_ID);
  const who = user.email || user.uid;
  let m;

  if (url === '/api/site/threads' && req.method === 'GET') {
    const ts = await threadsFor(ctx);
    for (const t of ts) {
      const last = await ws.collection('site').doc(t.id).collection('posts').orderBy('at', 'desc').limit(1).get();
      t.last = last.empty ? '' : last.docs[0].data().at;
    }
    return json(res, 200, ts);
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts(\?.*)?$/)) && req.method === 'GET') {
    const thread = m[1];
    if (!(await threadsFor(ctx)).some(t => t.id === thread)) return json(res, 403, { error: 'not your thread' });
    const q = new URL(req.url, 'http://x').searchParams;
    let qry = ws.collection('site').doc(thread).collection('posts').orderBy('at', 'desc').limit(Math.min(200, +(q.get('limit') || 50)));
    if (q.get('before')) qry = qry.where('at', '<', q.get('before'));
    const snap = await qry.get();
    return json(res, 200, { posts: snap.docs.map(d => d.data()).reverse() });
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts$/)) && req.method === 'POST') {
    const thread = m[1];
    if (!(await threadsFor(ctx)).some(t => t.id === thread)) return json(res, 403, { error: 'not your thread' });
    const b = await readBody(req);
    const kind = ['text', 'photo', 'video', 'voice'].includes(b.kind) ? b.kind : 'text';
    const text = String(b.text || '').trim().slice(0, 2000);
    const id = newId();
    const post = { id, thread, by: who, at: now(), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : beirutDay(), kind, text };
    let buf = null;
    if (kind !== 'text') {
      const raw = String(b.dataBase64 || '').replace(/^data:[^,]*,/, '');
      buf = Buffer.from(raw, 'base64');
      if (!buf.length) return json(res, 400, { error: 'no file' });
      if (buf.length > 25e6) return json(res, 400, { error: 'the file is larger than 25 MB' });
      const mime = String(b.mime || 'application/octet-stream').slice(0, 80);
      const ext = (String(b.name || '').match(/\.([a-z0-9]{1,5})$/i) || [, mime.split('/')[1] || 'bin'])[1].toLowerCase();
      try {
        post.file = await files.saveFile(ctx, { buf, mime, name: b.name || (kind + '.' + ext), key: `site/${thread}/${id}.${ext}`, who, meta: { thread, post: id } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    } else if (!text) return json(res, 400, { error: 'nothing to post' });
    const ref = ws.collection('site').doc(thread).collection('posts').doc(id);
    await ref.set(post);
    json(res, 200, post);
    digest(ctx, ws, ref, post, buf);   // after the reply — never blocks the post
    return true;
  }

  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/file$/)) && req.method === 'GET') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const d = await ws.collection('site').doc(m[1]).collection('posts').doc(m[2]).get();
    if (!d.exists || !d.data().file) return json(res, 404, { error: 'no file' });
    await files.streamFile(ctx, d.data().file, res);
    return true;
  }

  // receipt ↔ progress: the worker (or Mario) says what the picture is; the line follows
  if ((m = url.match(/^\/api\/site\/([\w-]+)\/posts\/([\w-]+)\/flip$/)) && req.method === 'POST') {
    if (!(await threadsFor(ctx)).some(t => t.id === m[1])) return json(res, 403, { error: 'not your thread' });
    const ref = ws.collection('site').doc(m[1]).collection('posts').doc(m[2]);
    const d = await ref.get(); if (!d.exists) return json(res, 404, { error: 'no post' });
    const post = d.data();
    if (post.line) { const a = await acc.resolve(ws, post.line.accountId); if (a) await acc.txCol(a).doc(post.line.txId).delete(); }
    const receiptOverride = !(post.parsed && post.parsed.receipt);
    await ref.set({ receiptOverride, line: null, parsed: {}, error: null }, { merge: true });
    json(res, 200, { ok: true, receipt: receiptOverride });
    const b = post.file ? await new Promise(r => { const chunks = []; files.streamFile(ctx, post.file, { writeHead() {}, end: c => { chunks.push(c); r(Buffer.concat(chunks.filter(Boolean))); } }); }) : null;
    digest(ctx, ws, ref, { ...post, receiptOverride }, b);
    return true;
  }

  return false;
}
module.exports = { handle };
```

- [ ] **Step 3: Mount it and serve the page**

In `server.js` after `const ajaltoun = require('./ajaltoun');` add `const site = require('./site');            // /api/site/* (the conversation that replaces the WhatsApp groups)`. Next to the `/api/ajaltoun/` block add:
```js
  if (url.startsWith('/api/site/')) {
    if (!access.apps.includes('site')) return noApp('site');
    try {
      const handled = await site.handle(req, res, url, user, { db, admin, TEAM_ID, odooCall, access });
      if (handled === false) { res.writeHead(404); res.end('not found'); }
    } catch (e) {
      console.error('site error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
```
`PAGES` gains `'/site': 'site.html'`; `FILE` gains `'site.html': path.join(__dirname, 'site.html')`. The `/api/site/` block must sit **before** the line `if (url !== '/api/session' && url !== '/api/allowlist' && !access.apps.includes('todo')) return noApp('todo');`.

- [ ] **Step 4: API smoke (local, admin)**

```powershell
cd D:\vscode\todo; # restart the hub first
curl -s http://127.0.0.1:8081/api/site/threads
curl -s -X POST http://127.0.0.1:8081/api/site/general/posts -H "Content-Type: application/json" -d '{"kind":"text","text":"paid bilal 200 aluminum ajaltoun"}'
# wait 5 s
curl -s "http://127.0.0.1:8081/api/site/general/posts?limit=1"
```
Expected: threads = General + the daily people; the post comes back at once; the re-read shows `parsed.amount: 200`, `line: { accountId: 'mario-cash', txId: 'site-…', state: 'waiting' }`. Then on http://127.0.0.1:8081/accounting/accounts → Mario cash: the line is there, dimmed, `review`, not counted, with ✓. **Delete the test line and post afterwards** (✕ on the grid, and `node -e` deleting `workspaces/team/site/general/posts/<id>`).

---

### Task 7: `site.html` — the page

**Files:**
- Create: `site.html`
- Modify: `server.js` STATIC_OK (nothing new needed: the page inlines its JS like the others)

**Interfaces:**
- Consumes: every `/api/site/*` route from Task 6; `Admin.require('site', …)`, `Admin.api`, `Admin.esc`; `phone-preview.js` (Shift+P tester).

- [ ] **Step 1: Write the page**

Structure (same tokens/fonts as `daily.html`; copy its `:root`, `header`, `.wordmark`, `.who` CSS):
```html
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#1e1e2e"><title>Site · Shift Hub</title>
<link rel="icon" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><link rel="manifest" href="/manifest.json">
<style>
  /* … the daily.html tokens … */
  main{max-width:760px;margin:0 auto;padding:0 0 120px;}
  .threads{display:flex;gap:8px;overflow-x:auto;padding:12px 16px;border-bottom:1px solid var(--surface0);}
  .threads button{white-space:nowrap;background:var(--mantle);border:1px solid var(--surface0);color:var(--text);border-radius:999px;padding:6px 12px;font-size:.8rem;}
  .threads button.on{border-color:var(--amber);color:var(--amber);}
  .feed{padding:12px 16px;display:flex;flex-direction:column;gap:10px;}
  .post{max-width:88%;background:var(--mantle);border:1px solid var(--surface0);border-radius:14px;padding:10px 12px;font-size:.9rem;}
  .post.me{align-self:flex-end;border-color:#4a3e26;}
  .post .meta{font-size:.68rem;color:var(--overlay0);margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;}
  .post img,.post video{max-width:100%;border-radius:10px;display:block;}
  .post .line{font-size:.72rem;margin-top:6px;padding:4px 8px;border-radius:8px;background:#3b3220;color:var(--amber);}
  .post .line.accepted{background:#26352a;color:var(--green);} .post .line.dismissed{background:#3a2630;color:#f38ba8;}
  .post .err{font-size:.72rem;color:#f38ba8;margin-top:4px;}
  .day{align-self:center;font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--overlay0);margin:8px 0 2px;}
  .composer{position:fixed;bottom:0;left:0;right:0;background:var(--mantle);border-top:1px solid var(--surface0);padding:10px 12px calc(10px + env(safe-area-inset-bottom));}
  .composer .row{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;}
  .composer textarea{flex:1;min-height:42px;max-height:140px;resize:none;background:var(--crust,#11111b);color:var(--text);border:1px solid var(--surface0);border-radius:12px;padding:10px 12px;font:inherit;}
  .composer button{background:var(--surface0);border:0;color:var(--text);border-radius:12px;width:42px;height:42px;font-size:1.15rem;}
  .composer button.send{background:var(--amber);color:var(--base);}
  .composer button.rec{background:#f38ba8;color:var(--base);}
  .empty{color:var(--overlay0);text-align:center;padding:60px 20px;font-size:.9rem;}
</style></head>
<body>
<header><div class="wordmark">SHIFT <span>GROUP</span><small>SITE</small></div><div class="who" id="who"></div></header>
<main>
  <div class="threads" id="threads"></div>
  <div class="feed" id="feed"><div class="empty">Loading…</div></div>
</main>
<div class="composer"><div class="row">
  <button onclick="pick('image/*','photo')" title="Photo">📷</button>
  <button onclick="pick('video/*','video')" title="Video">🎬</button>
  <button id="recbtn" onclick="toggleRec()" title="Voice note">🎤</button>
  <textarea id="text" placeholder="Write… or hold the Flow key and talk" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendText();}"></textarea>
  <button class="send" onclick="sendText()" title="Send">➤</button>
</div></div>
<input type="file" id="file" hidden>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js"></script>
<script src="/admin-shared.js"></script><script src="/phone-preview.js"></script>
<script>
const esc = Admin.esc, el = id => document.getElementById(id);
let threads = [], cur = '', posts = [], me = null, timer = null;
const hhmm = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Beirut' });
const dayLabel = ymd => new Date(ymd + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

async function loadThreads() {
  threads = await Admin.api('GET', '/api/site/threads');
  if (!cur) cur = (location.hash.slice(1) && threads.some(t => t.id === location.hash.slice(1))) ? location.hash.slice(1) : (threads[0] || {}).id || '';
  el('threads').innerHTML = threads.map(t => `<button class="${t.id === cur ? 'on' : ''}" onclick="open('${t.id}')">${esc(t.name)}</button>`).join('');
  el('threads').hidden = threads.length < 2;
}
function open(id) { cur = id; location.hash = id; loadThreads(); loadPosts(); }
async function loadPosts() {
  if (!cur) { el('feed').innerHTML = '<div class="empty">No thread is open to your account yet. Ask Mario.</div>'; return; }
  const r = await Admin.api('GET', `/api/site/${cur}/posts?limit=100`);
  posts = r.posts; draw();
  // a post's line arrives a few seconds after the post: poll while one is still being read
  clearTimeout(timer);
  if (posts.some(p => !p.digestedAt && Date.now() - Date.parse(p.at) < 120e3)) timer = setTimeout(loadPosts, 3000);
}
function lineTag(p) {
  if (p.error) return `<div class="err">${esc(p.error)}</div>`;
  if (!p.digestedAt) return `<div class="line">reading…</div>`;
  if (!p.line) return p.parsed && p.parsed.receipt === false && (p.kind === 'photo' || p.kind === 'video') ? `<div class="line" style="background:#26352a;color:var(--green)">progress photo · <a href="#" onclick="flip('${p.id}');return false;">this is a receipt</a></div>` : '';
  const amt = p.parsed && (p.parsed.amount || 0);
  return `<div class="line ${p.line.state || 'waiting'}">${amt ? amt.toFixed(2) + ' ' + (p.parsed.currency || 'USD') + ' · ' : ''}suggested on ${esc(p.line.accountId)} — ${p.line.state === 'accepted' ? 'accepted ✓' : p.line.state === 'dismissed' ? 'dismissed' : 'waiting for Mario\'s ✓'}${(p.kind === 'photo') ? ` · <a href="#" onclick="flip('${p.id}');return false;">not a receipt</a>` : ''}</div>`;
}
function draw() {
  if (!posts.length) { el('feed').innerHTML = '<div class="empty">Nothing here yet. Write what happened, send a photo, or record.</div>'; return; }
  let lastDay = '';
  el('feed').innerHTML = posts.map(p => {
    const day = p.date !== lastDay ? `<div class="day">${esc(dayLabel(p.date))}</div>` : ''; lastDay = p.date;
    const mine = p.by === me.email;
    const body = p.kind === 'photo' ? `<img src="/api/site/${cur}/posts/${p.id}/file" loading="lazy">`
      : p.kind === 'video' ? `<video src="/api/site/${cur}/posts/${p.id}/file" controls preload="metadata"></video>`
      : p.kind === 'voice' ? `<audio src="/api/site/${cur}/posts/${p.id}/file" controls></audio>${p.parsed && p.parsed.transcript ? `<div style="margin-top:6px;font-style:italic">${esc(p.parsed.transcript)}</div>` : ''}`
      : esc(p.text);
    return `${day}<div class="post ${mine ? 'me' : ''}">${body}${lineTag(p)}<div class="meta"><span>${esc(mine ? 'you' : p.by.split('@')[0])}</span><span>${hhmm(p.at)}</span></div></div>`;
  }).join('');
  window.scrollTo(0, document.body.scrollHeight);
}
async function sendText() {
  const t = el('text').value.trim(); if (!t || !cur) return;
  el('text').value = '';
  try { const p = await Admin.api('POST', `/api/site/${cur}/posts`, { kind: 'text', text: t }); posts.push(p); draw(); loadPosts(); }
  catch (e) { alert('Could not send: ' + e.message); el('text').value = t; }
}
function pick(accept, kind) { const f = el('file'); f.accept = accept; f.capture = kind === 'photo' ? 'environment' : ''; f.onchange = () => sendFile(f.files[0], kind); f.click(); }
// photos shrink to 1600 px on the phone; a video over 60 s is refused (the spec's phone-side limits)
async function sendFile(file, kind) {
  if (!file || !cur) return;
  let blob = file, mime = file.type, name = file.name;
  if (kind === 'photo') { blob = await shrink(file, 1600); mime = 'image/jpeg'; name = (name || 'photo').replace(/\.\w+$/, '') + '.jpg'; }
  if (kind === 'video') { const secs = await duration(file); if (secs > 60) return alert('Keep a video under 60 seconds.'); }
  const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  try { const p = await Admin.api('POST', `/api/site/${cur}/posts`, { kind, dataBase64: b64, mime, name }); posts.push(p); draw(); loadPosts(); }
  catch (e) { alert('Could not send: ' + e.message); }
}
function shrink(file, max) {
  return new Promise(res => { const img = new Image(); img.onload = () => {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); c.toBlob(b => res(b || file), 'image/jpeg', 0.85); };
    img.onerror = () => res(file); img.src = URL.createObjectURL(file); });
}
function duration(file) { return new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res(v.duration || 0); v.onerror = () => res(0); v.src = URL.createObjectURL(file); }); }
let rec = null, chunks = [];
async function toggleRec() {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
    rec = new MediaRecorder(stream, { mimeType: mime }); chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); el('recbtn').classList.remove('rec'); const b = new Blob(chunks, { type: mime }); rec = null; sendFile(new File([b], 'voice.' + (mime === 'audio/webm' ? 'webm' : 'm4a'), { type: mime }), 'voice'); };
    rec.start(); el('recbtn').classList.add('rec');
  } catch (e) { alert('Microphone not available: ' + e.message); }
}
async function flip(id) { try { await Admin.api('POST', `/api/site/${cur}/posts/${id}/flip`, {}); loadPosts(); } catch (e) { alert(e.message); } }
Admin.require('site', async m => {
  me = m;
  el('who').innerHTML = `${esc(me.email)} <a href="#" onclick="Admin.signOut();return false;">Sign out</a>`;
  await loadThreads(); await loadPosts();
});
</script></body></html>
```
`Admin.require('site', …)` — check `admin-shared.js` `tryMe` treats an app the user lacks with the "not approved" card (it does for any app id through `/api/me` + `noApp`); if `A.require` only understands `'todo' | 'accounting' | null`, extend its comment, no code change needed since the gate is by `me.apps` on the server.

- [ ] **Step 2: Line state on the post follows the ledger**

The post's `line.state` is written once as `waiting`. To show `accepted` / `dismissed` without a second write path, the posts GET in `site.js` looks the lines up: after `const snap = await qry.get();` add
```js
    const out = snap.docs.map(d => d.data()).reverse();
    await Promise.all(out.filter(p => p.line).map(async p => {
      const a = await acc.resolve(ws, p.line.accountId); if (!a) return;
      const t = (await acc.txCol(a).doc(p.line.txId).get()).data();
      p.line.state = !t ? 'dismissed' : t.waAccepted ? 'accepted' : t.excluded && !t.review ? 'dismissed' : 'waiting';
    }));
    return json(res, 200, { posts: out });
```
(replace the previous `return json(res, 200, { posts: … })`).

- [ ] **Step 3: Headless check**

`test/e2e-site.mjs` (run from `D:\vscode\wa-contacts` so Playwright resolves: `node D:\vscode\todo\test\e2e-site.mjs`):
```js
import { chromium } from 'playwright';
const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 420, height: 800 } });
await page.goto('http://127.0.0.1:8081/site');
await page.waitForSelector('#feed');
await page.fill('#text', 'test post — delete me 12$');
await page.click('button.send');
await page.waitForFunction(() => document.querySelector('.post .line') && !/reading/.test(document.querySelector('.post .line').textContent), null, { timeout: 30000 });
console.log(await page.evaluate(() => [...document.querySelectorAll('.post')].slice(-1)[0].innerText));
await page.screenshot({ path: 'D:/vscode/todo/_site.png' });
await b.close();
```
Expected: the last post reads `test post — delete me 12$ · 12.00 USD · suggested on mario-cash — waiting for Mario's ✓`. Look at `_site.png`, then delete it and the test post + its line.

---

### Task 8: Day report shows `site` suggestions and progress media

**Files:**
- Modify: `daily.html` (`isSuggestion` already covers `site` after Task 3; the tag text; media strip), `accounts.js` daily GET (media)

**Interfaces:**
- Consumes: posts of kind photo/video with `parsed.receipt === false` in `workspaces/team/site/<worker>/posts` for the day.
- Produces: daily GET adds `media: [{ thread, postId, kind, at }]` for the span; the page draws a strip of thumbnails per worker under the lines.

- [ ] **Step 1: Server**

In the daily GET, after `lines` are gathered and before the `readOnly` block:
```js
    // progress photos / videos the workers posted on /site for these days (no amount on them)
    const media = [];
    await Promise.all(people.map(async a => {
      const snap = await ws.collection('site').doc(a.id).collection('posts').where('date', '>=', since).where('date', '<=', date).get();
      snap.docs.forEach(d => { const p = d.data(); if ((p.kind === 'photo' || p.kind === 'video') && p.parsed && p.parsed.receipt === false) media.push({ thread: a.id, who: a.name, postId: p.id, kind: p.kind, date: p.date, at: p.at, note: p.parsed.note || '' }); });
    }));
```
and include `media: readOnly ? media.filter(x => true) : media` in the reply — a partner sees progress media of every worker on his day (they carry no money); if that is too wide, filter by the worker's attendance project in part 2.

- [ ] **Step 2: Page**

In `daily.html` declare `let media = [];`, set `media = r.media || [];` in `load()`, and at the end of `drawLines()` append:
```js
  const shownMedia = media.filter(x => span === 1 ? x.date === d : true);
  el('media').innerHTML = shownMedia.length ? `<div class="lbl" style="margin-top:14px">From the site</div><div class="strip">${shownMedia.map(x =>
    x.kind === 'photo' ? `<a href="/api/site/${x.thread}/posts/${x.postId}/file" target="_blank" title="${esc(x.who)} · ${esc(x.note)}"><img src="/api/site/${x.thread}/posts/${x.postId}/file" loading="lazy"></a>`
      : `<a href="/api/site/${x.thread}/posts/${x.postId}/file" target="_blank" class="vid" title="${esc(x.who)} · ${esc(x.note)}">🎬 ${esc(x.who)}</a>`).join('')}</div>` : '';
```
with `<div id="media"></div>` after `#totals` and the CSS `.strip{display:flex;gap:8px;overflow-x:auto;padding:6px 0} .strip img{height:84px;border-radius:8px} .strip .vid{display:flex;align-items:center;padding:0 12px;height:84px;border:1px solid var(--surface0);border-radius:8px;color:var(--text);text-decoration:none;font-size:.8rem}`. The suggestion tag text becomes `${t.src === 'site' ? 'Site suggestion' : 'WhatsApp suggestion'}` and its title `Read out of ${t.src === 'site' ? 'a post on /site' : (t.waFrom === 'mario' ? 'your' : 'his') + ' WhatsApp message'}…`.

- [ ] **Step 3: Verify**

Post a site photo of anything non-receipt on the local `/site` General thread — no: General posts by Mario are not "worker" media; post it on a worker thread (open `/site#khodr-cash` as local admin). Then http://127.0.0.1:8081/accounting/daily for today shows the thumbnail under "From the site". Delete the test post afterwards.

---

### Task 9: Wrap-up

- [ ] Run everything: `cd D:\vscode\todo; node --test` (7 pass), `node D:\vscode\todo\test\e2e-site.mjs` from `D:\vscode\wa-contacts`.
- [ ] Vercel env: add `OPENAI_API_KEY` (from `D:\vscode\imggen\.env`) in the todo project's settings — Mario does this in the dashboard or `vercel env add OPENAI_API_KEY production` from `D:\vscode\todo`.
- [ ] Firebase Storage: Mario enables it in the console (Build → Storage → Get started) before any video is posted.
- [ ] Update `accounting-home.html`'s tile list? No — `/site` is a hub tile, not an accounting tile.
- [ ] Report to Mario: what is live locally, what needs his click (Storage, OPENAI key, `daily`/`site` ticks on the members table), and that part 2 (worker threads with Start/Finish + sites + the self-written day) is the next plan.
- [ ] Deploy only on his word: `cd D:\vscode\todo; vercel --prod`.

## Self-review

- Spec §1 → Tasks 1–3. Spec §2 (General thread, text/photo/video/voice, Wispr = plain text, suggestion lines, parse after save, line state on the post, flip receipt/progress, Storage prerequisite, phone-side limits) → Tasks 4–8. Spec §3 (attendance) and §4 (nightly dedup) → part 2 plan, by the spec's own order. Progress media on the Ajaltoun page → part 2 (needs the attendance project).
- Names used across tasks: `filterForPartner`, `readOnlyFor`, `isSuggestion` (Task 2 → 3, 8); `saveFile`, `streamFile` (4 → 6); `quickParse`, `matchName`, `claudeParse`, `visionRead`, `whisper` (5 → 6); routes `/api/site/threads`, `/:thread/posts`, `/file`, `/flip` (6 → 7, 8); `MARIO_CASH` constant checked in Global Constraints.
