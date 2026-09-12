# Site chat & attendance on the hub — design

Date: 2026-09-12 · Owner: Mario · Pilot: Khodr (khodr-cash)

## Why

The workers' days reach the hub through a nightly Playwright read of their WhatsApp groups. It is the weakest link in the accounting chain: WhatsApp Web keeps ~50 messages in its Store, a linked device syncs only part of the history, the browser has to stay signed in, and every "750$" has to be parsed out of free text. The Day report then shows whatever came out.

Replace the read with a place on the hub where the day is *entered*, not scraped: a worker posts his day (text, photo, Start/Finish with location), Mario posts payments for anyone who has no group, and everything lands as a **suggestion** on the right ledger, behind the same ✓ gate that already exists. Nothing is booked without Mario's approval — the nightly read stays running as a fallback until the pilot worker posts daily by himself.

## What is built

Four pieces, in this order. Each is usable on its own.

### 1. `daily` app flag + read-only Day report (prepared, not shown)

- `APPS` gains `daily` (server.js). The members table on the hub gets the checkbox; nobody has it ticked. Ticking it on a partner's row is the switch.
- `/accounting/daily` and `GET /api/accounting/daily` accept a user holding `daily` **or** `accounting`. With `daily` only, the page is read-only: no "Write the day" card, no Copy / Save / Undo / Log / WhatsApp buttons, no ✓/✕ on suggestions, no camera button; just the date navigator, "Last 7 days" and the written lines.
- A `daily`-only user sees **only lines whose analytic account belongs to a project he is partner on** (option A, 2026-09-12): the server filters by the analytic ids listed on his allowlist entry (`projects: [69, 59…64]` for Antoine, set from the members table). Amounts are shown. Suggestions are never shown to a partner.
- POST / PATCH / DELETE under `/api/accounting/…` keep requiring `accounting`.

### 2. Site chat — `/site`

One page, phone-first, installable (the hub is already a PWA). Two kinds of threads:

- **A worker's thread** — one per account flagged `daily` (the same people as the Day report). The worker sees only his own thread; Mario sees all of them. Access: the worker's Google account on the allowlist with a new field `account: 'khodr-cash'` and the app `site`. (`site` is a fifth app flag; a worker gets `site` only.)
- **General** — Mario's own thread, for anyone who has no group and no account: "paid Bilal 200 aluminum Ajaltoun", a receipt photo, a voice note.

A post is `{ id, thread, by, at, kind: 'text'|'photo'|'video'|'voice'|'start'|'finish', text?, file?, loc?, parsed?, lineRef? }` in `workspaces/team/site/<thread>/posts`. Files go through the existing docs route logic, referenced from the post and from the line. **Firebase Storage must be enabled before step 2** — the `txDocs` Firestore fallback stops at 900 KB, which is fine for a receipt but not for site photos and videos. The phone downsizes before upload: photos to 1600 px JPEG, videos to 720p and 60 s (longer is refused with a message). Voice notes are recorded in the page (MediaRecorder, webm/m4a) and sent as files.

**What a post produces**

| Post | Suggested line |
|---|---|
| Worker text with an amount (`benzine 20`, `750$`) | On his ledger, the same rule as the WhatsApp read: a bare amount from him = Due to employee; "paid"/"received" from him = Paid by Shift. Project = today's attendance project if any. |
| Worker photo | Claude vision reads vendor, amount, date, currency (the invoice-renamer read). Line on his ledger: Due to employee = amount, partner = vendor if it matches an Odoo supplier, photo attached. |
| Worker text without an amount | No line; it becomes "what he did" on today's attendance line. |
| Worker voice note | Whisper → text, then the two rows above apply (an amount → a line; otherwise "what he did"). The audio stays on the post. |
| Worker photo / video of the work (no amount on it) | A **progress report**: attached to today's attendance line as `media`, shown on the Day report and the Ajaltoun page under that day. Vision decides receipt vs progress (a receipt has a vendor and an amount); the worker can flip it with one tap ("this is a receipt" / "this is the site"). |
| Mario text / voice in General | Mario's voice comes in as text through the **Wispr Flow keyboard** on his phone (no audio reaches the server). A recorded voice note (a worker without Wispr) → text with Whisper (`OPENAI_API_KEY`, the imggen key). Text → Claude parses `{ amount, currency, partner, project, paidFrom, note }`. Line on **Mario cash (87)** by default (default-payer rule), partner and project as parsed, `paidFrom` overrides the account when he said "from Whish / Neo / Ziad". |
| Mario photo in General | Same vision read; line on Mario cash, partner = vendor. |

Every line is written exactly like a WhatsApp proposal today: `src: 'site'`, `review: true`, `excluded: true`, `waAccepted: false`, plus `postId`. So the Day report, the Accounts grid and the Statements page treat it as a suggestion with no new code — dimmed, out of totals, ✓ accepts, ✕ dismisses. The post shows the state of its line (waiting / accepted / dismissed) so the worker sees that Mario has seen it.

Parsing never blocks the post: the post is saved first, the parse runs after and fills `parsed` + `lineRef`; if the parse fails the post stays and Mario writes the line by hand from it.

### 3. Attendance — Start / Finish with location

- Two big buttons at the top of a worker's thread: **Start** and **Finish**. Each asks the browser for the position (HTTPS geolocation; accuracy stored with it) and writes a `start` / `finish` post with `{ at, loc: { lat, lng, acc } }`.
- **Sites** live in `workspaces/team/site/meta/sites`: `{ id, name, analyticId, lat, lng, radiusM }`. Mario adds them from the page (a pin + radius; the analytic account from the same list the Day report uses). A Start inside a site's circle sets the day's project; outside every circle the button asks him to pick.
- Forgotten taps: a worker can add a Start or Finish for today or yesterday with a time he types; Mario can do it for any day. The post carries `manual: true` and `enteredAt`, and every view shows it as *"entered by hand at 19:40 for 07:30"*. A live tap can never be edited, only complemented.
- **The day writes itself.** When Finish lands (or at 23:59 Beirut for a Start with no Finish), the hub writes the day's suggestion on his ledger: date, project from the Start, "what he did" from his text posts of the day, Due to employee = his `defaultRate`; for Ziad (hourly, ISF 40 h/month rule) hours are stored on the line and the amount is left for the month's costing, as today. A Start with no Finish produces the line with a `no finish` tag so Mario sees who forgot. Same gate: suggestion until ✓.
- A duplicate Start (two in a row) is refused with a message; a Finish before a Start is stored and flagged.

Location is a record and a deterrent, not a lock: it can be refused or spoofed. When refused, the tap is still taken and marked *"no location"*.

### 4. Nightly read → fallback

`wa-contacts/nightly.mjs` keeps running. Once a worker has a `site` login, his WhatsApp proposals get `dupOf` the site line when the day and amount match, so the two sources never double a day. When the pilot worker posts daily for a month, his chat is dropped from `WA_CHATS`.

## Web, not a native app

The hub is an installable PWA (home-screen icon, camera, geolocation on Android and iPhone). That covers three taps and a photo a day. A native app would add background location, guaranteed push and offline queues at the cost of store accounts and a build per fix — not worth it for the pilot. Revisit only if iPhone push reminders ("you did not Finish today") become necessary.

## Not in this design

- The analytic-accounts dashboard across companies (own spec, still to be asked: active-project window A/B/C).
- Video processing beyond the phone-side downscale (no thumbnails, no server transcoding).
- Push notifications to the worker (a later step; the Statements/Telegram relay already tells Mario).
- Payroll / statements to the worker from the site page — statements keep their own round.
- Booking to Odoo from the site page — unchanged, through the ledger's Book months.

## Data & access summary

- Allowlist entry: `{ email, apps: [...,'daily','site'], account?: 'khodr-cash', projects?: [69,…] }`.
- `workspaces/team/site/<thread>/posts/<postId>`; `workspaces/team/site/meta/sites`.
- Ledger lines: existing `tx` schema + `src: 'site'`, `postId`, `manual`, `hours`, `media: [{ postId, kind, file }]` (progress photos/videos of the day).
- New routes under `/api/site/*` (posts, files, start/finish, sites) gated by the `site` app; the `daily` filter is added to the existing daily GET.
- Env on Vercel: `ANTHROPIC_API_KEY` (already), `OPENAI_API_KEY` (new, Whisper only).

## Order of work

1. `daily` flag + read-only, filtered Day report (small, no UI for workers yet). Enable Firebase Storage in the console (Mario, one click; the docs route already prefers the bucket).
2. `/site` page with General thread only — Mario's voice/photo/text → Mario cash suggestions. Proves the parse and the gate.
3. Worker threads + Start/Finish + sites + the self-written day; pilot with Khodr.
4. Dedup against the nightly read; retire his chat.

## Testing

- Headless browser runs against the local hub (port 8081, sign-in disabled) for every page state: worker view, Mario view, partner read-only view, refused location, manual Start.
- Parse fixtures: ten real messages from the WhatsApp archive (Khodr's and Anthony's) + three receipt photos + two voice notes, expected line per fixture.
- The Day report's totals never include a `site` suggestion (same assertion as for WhatsApp suggestions).
