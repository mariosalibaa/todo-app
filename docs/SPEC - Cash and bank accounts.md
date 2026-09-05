# SPEC — Cash & bank accounts inside Shift Hub Accounting

Captured 2026-09-05 from Mario's instructions, answers folded in the same day. Status: **phase 1 built 2026-09-05** (accounts page, Mario cash + Neo Mario + Neo Therese from Odoo, HomeBudget history, transfers) — see `Session Notes 2026-09-05 - Cash and bank accounts.pdf`. Phase 2 (per-person cash, Telegram, dashboard) not started.

## The one-line version
Turn the Whish page into a generic *account* page. Any account — cash or bank — is created from a **+** button in the app (no code per account), imports statements the way Whish does, carries the same columns and the same Odoo logic, and can be fed from Telegram. Retire the per-person Excels and WhatsApp accounting groups.

## Account types
| Type | Examples | Columns | Data source |
|---|---|---|---|
| **bank** | Whish Mario (exists), **Neo Mario**, **Neo Therese**, Therese Whish, Wise, BOB, offshore | identical for all banks — the Whish grid | **Build from Odoo now** (the Neo journals already exist there); CSV import comes later when Mario exports one |
| **cash** | **Mario**, Georges, Abed, Khodr, Ziad, Mitri | one shared layout modelled on the existing Excels | see per-account notes below |

Neo and Whish are used across several companies; other banks belong to one official company (SARL, offshore). Company is chosen per line, as on Whish today.

## Mario's cash account (replaces Budget's "cash $ lap mario" from 4/9/2026)
Mario's real cash is the Odoo "Cash Mario USD" journals: **87 (S LB), 21 (SARL), 146 (S DEV)** — one physical wallet, three books. Build it from **all Odoo lines on those three journals + the HomeBudget history**, then cut over to live entry.
**Trap:** Cash Mario in Odoo was used as a *general* cash account, so some of its payments were physically made by Abed, Georges, Ziad, Mitri or Khodr. Cross-check against their Excels/WhatsApp groups and re-attribute.

## Per-person cash accounts — Georges, Abed, Khodr, Ziad, Mitri
Each has up to three sources that must be **matched, not summed**:
1. their **Excel** ledger (the payroll/cash workbooks — see memory `worker-hours-tracking-gap`, `odoo-worker-cash-payments`)
2. their **WhatsApp accounting group**: *Accounting Metre* (Mitri), *Accounting Khodr*, *Accounting Ziad*, *Accounting Abed*, and Georges' group — readable from the WhatsApp Local archive (`D:\vscode\whatsapp-local`, 2013–2026) or live via Playwright
3. what is **already in Odoo**: their cash journals (S LB 162/166/165/163/164, S DEV 150/161/160/158/159, SARL 151/153/155/152/154) and supplier bills they paid
Import only what is missing; link what is common. They pay Shift suppliers (Abed buys from ATTAL, etc.), sometimes for an official company, with per-line analytic. Ziad also draws a salary — that is separate from his cash account.

**Georges** is its own subject: Odoo accounts + Excel + WhatsApp group, match all three.
**Dib / Anthony (Shift Development)** are NOT a Georges matter — they are already handled in S DEV as transfers (`PCSH2/2026/00001-34`). Leave that mechanism alone; do not build a "settlement mode" for them.

## Transfers
First-class object: **transfer between accounts** (Mario → Abed/Khodr/Mitri/Ziad …). One record = *out* on the source, *in* on the destination; never income or expense. A **list of transfers** view. Whish wallet top-ups are transfers.

## Telegram entry
Capture-only. One Telegram group/bot per person replacing the WhatsApp groups — date/amount/who/note; classification and Odoo booking stay in the grid. Reuse the Shift Hub Render service / @MarioOdoo_bot pattern.

## Dashboard
All cash, per account and total, plus gold & silver from
`D:\Dropbox\0. SHIFT\0. ACCOUNTING\ms\00. XLS\0. GOLD\20250422 gold+silver.xlsx`.

## Constraints carried over from Whish
- `whish-rules.js` generalises to any account: `book` (vendor bill) and `book:false` (classify only).
- Before creating any partner or picking an account, **read how prior entries for that counterparty were booked** and mirror them (the row's `odoo.matches` carries partner/company/journal).
- Partners and analytic accounts stay shared (`company_id:false`).
- Idempotency key per line stays `<ACCOUNT>-<txId>` in the move ref.
- Budget keeps history before 4/9/2026; Mario's cash account opens with a real opening-balance row.

## Side tasks for the same session
- **Astro** drafts 4446 ($358, 24 Apr) and 4447 ($133, 11 Jun) await invoices; **Solaris** $116.15 (28 Jul) and $695.13 (21 Aug) have none. Search the **Astro and Solaris WhatsApp chats** (statement of account / invoice PDFs) and **drive D:** for those documents before asking the suppliers.
- Isam (6 lines) and Solaris company choice: Mario does these himself in the app.
