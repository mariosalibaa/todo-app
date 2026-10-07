# SHIFT — north star for every Claude session

One page every agent reads first. Detail lives in memory files and skills; this is the map.
Owner: Mario Saliba (mario@shift-group.co). Last revised 2026-09-16.

## Who we are
- **Shift Group** (@shiftgrouplb) — steel structures + solar systems + engineering, Lebanon. B2B too (drawings for other solar companies, incl. Canada).
- **Shift Development** (@shift.development) — builds and sells villas. Flagship: **Les Villas Ajaltoun** (AJ4193, 6 villas, $1,800/m², 2 sold).
- Slogan: **"Make the Shift"**. Wordmark only (no logo image): Century Gothic, amber `#F2A93B`, dark steel `#15181C`. Development palette: cream `#F5F1E8` / ink `#181613` / bronze `#A08A5F`.
- Website shift-group.co (Vercel). Hub: **hub.shift-group.co** (To-Do, Accounting, Ajaltoun, Partners, Reports, Site chat).

## Legal entities (Odoo `shift2`)
| Company | id | Currency | Used for |
|---|---|---|---|
| SHIFT GROUP SARL | 2 | USD | official VAT bills (journal 20, tax 151 = 11%) |
| SHIFT GROUP SARL LBP | 8 | LBP | |
| S LB | 7 | USD | non-official / no-VAT receipts (journal 85), workers' cash |
| SHIFT DEVELOPMENT | 10 | USD | Ajaltoun (Georges EL Hajj settlements, journal 185) |
| OFFSHORE 9 · UAE 4 · Intl Shift Group SRL (Moldova) · Shift Group LLC (Maryland, Youssef) | | | |

Cash journals: Mario cash = 21 (SARL) / 87 (S LB); Whish = 167 (SARL) / 184 (S LB) / 185 (S DEV). Accountant: Roger (roger83aziz@gmail.com).

## People
- **Mario** — CEO, sole approver. Dictates by voice ("cloud code" = Claude Code); prefixes his messages with a marker — keep replies plain.
- **Workers with cash ledgers**: Georges, Abed ($50/day, $70 with son), Khoder (hours × 25/9 $/h + $5 transport), Ziad (ISF driver), Mitri. Their Excel sheet is the truth; Odoo must match it.
- **Partners**: Antoine (Villa D3), Jean (buyer), Youssef Matar (USA). Sister Maya (household bot). Christa.

## Where things live
- Code: `D:\vscode\<app>` (hub = `D:\vscode\todo`, Odoo scripts = `D:\vscode\odoo`, WhatsApp = `D:\vscode\wa-contacts`).
- Files: `D:\Dropbox\0. SHIFT\` — accounting scans in `0. ACCOUNTING`, marketing in `00. branding`, Ajaltoun in `00. DEVELOPMENT (REAL ESTATE)\AJALTOUN 4193 VILLAS`.
- Secrets: never in repos; see memory `credentials-deploy-map`. Odoo creds `~/.odoo-creds.json`.
- Always-on: WhatsApp daemon Chrome on CDP :9333 (attach, never launch), Task Scheduler jobs via hidden.vbs, Render "Shift Hub" (bots + Odoo MCP).

## Delegation — what Claude does alone vs what waits for Mario
| Claude does | Waits for Mario's explicit ok |
|---|---|
| read scans, rename per convention, draft bills, reconcile, import statements | posting a bill with no project tag; anything sent to a worker (statement, screenshot, WhatsApp reply) |
| prepare hub rows, reports, PDFs, drafts of posts/reels/captions | publishing or boosting anything; sending outward messages/emails |
| local rendering (ffmpeg, Edge, HTML), cost previews | spending credits (Higgsfield, Meta ads, Apify, Firecrawl beyond free) |
| research, summaries, session-notes PDF at the end of a topic | restart/shutdown; deleting Odoo entries; git push to a shared repo when unsure |

Hard rules are also enforced mechanically by the PreToolUse hook `~/.claude/hooks/shift-rules.mjs` — never work around a refusal; ask.

## Conventions (the short list)
- Scan filenames: `yyyymmdd supplier amount$ttc project (paidby).pdf`; RETURN / RECEIPT variants; ` - paid_mario - posted` suffix after booking. No payer on the scan → Mario cash.
- Bill `ref` = supplier's invoice number verbatim. Fuel after 2026-04-01: no VAT, account 6993.
- One Odoo bill per hub line. A WhatsApp line is a proposal until Mario's ✓.
- Quarantine folders `old` / `inutile` / `z. do not use` are never a source. Visual assets only from approved `00. branding\…` subfolders, with a per-video `sources\` list approved first.
- Every reel: silent master + "WITH SONG (preview only)"; IG text block centred slightly below middle.
- Replacing a sent message: delete the old one first.
- Free tools first (fetch / Playwright / yt-dlp) before paid scrapers.
- Closing a topic → dated `Session Notes YYYY-MM-DD - <topic>.pdf` in the project folder.
- Hub dates: Beirut local, never `toISOString()`. Never two Claude sessions committing in `D:\vscode\todo`.

## Standing goals (Sept 2026)
Sell the remaining Ajaltoun villas (diaspora marketing, paused ads await approval) · keep the four workers' ledgers reconciled through the statement round · reconcile Whish/Wise into Odoo · Shift Group content cadence (carports, pergolas, McKinsey reel) · USA opportunities with Youssef.
