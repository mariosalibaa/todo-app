# SPEC — Cash & bank accounts inside Shift Hub Accounting

Captured 2026-09-05 from Mario's instructions. Status: **not started**. Build in a fresh session.

## The one-line version
Turn the Whish page into a generic *account* page. Any account — cash or bank — is created from a **+** button in the app (no code per account), imports statements/CSVs the way Whish does, carries the same columns and the same Odoo logic, and can be fed from Telegram. Retire the payroll/cash Excels.

## Account types
| Type | Examples | Columns | Import |
|---|---|---|---|
| **bank** | Whish Mario (exists), Neo Mario, Neo Therese, Therese Whish, Wise, BOB, offshore | identical for all banks — the Whish grid | CSV/PDF drop, like Whish |
| **cash** | Mario "cash $ lap mario" (from Budget, from 4/9/2026), Georges, Abed, Khodr, Ziad, Mitri | one shared layout, **modelled on the existing Excels** | one-time import of each Excel, then Telegram |

Neo and Whish are used across several companies; other banks belong to one official company (SARL, offshore). Company is chosen per line, as on Whish today.

## Transfers
First-class object: **transfer between accounts** (Mario → Abed, Mario → Khodr, Mario → Mitri, Mario → Ziad …). One record shows as *out* on the source and *in* on the destination; never booked as income or expense. A **list of transfers** view. Wallet top-ups on Whish are transfers too.

## Cash accounts for the people
Georges, Abed, Khodr, Ziad, Mitri each get a cash account. They pay Shift suppliers from it (Abed buys from ATTAL, etc.), sometimes for an official company, with per-line analytic. Ziad is also a partner with a salary — the cash account is separate from that.

**Georges first**: an Excel exists AND Odoo already has entries (journal 185 `PCSH2/2026/00001-34`, and cash journals 150/151/162 "Cash Georges USD"). Reconcile: match what's in both, import only what's missing.

Source Excels: the payroll/cash workbooks already known (see memory `worker-hours-tracking-gap`, `odoo-worker-cash-payments`). Stop using them once imported.

## Telegram entry
Capture-only. One Telegram group/bot per person (Abed, Khodr, Ziad, Mitri, Georges) replacing WhatsApp — they enter date/amount/who/note; classification and Odoo booking stay in the grid. Reuse the Shift Hub Render service / @MarioOdoo_bot pattern.

## Dashboard
Summary of all cash, per account and total. Plus gold & silver holdings from
`D:\Dropbox\0. SHIFT\0. ACCOUNTING\ms\00. XLS\0. GOLD\20250422 gold+silver.xlsx`.

## Constraints carried over from Whish
- Rules engine (`whish-rules.js`) must generalise to any account: `book` (vendor bill), `book:false` (classify only), and a new **settlement** mode for the Georges pattern (cash-journal entry, debit 401100 payable, credit the cash account) — the Book button today only makes vendor bills.
- Before creating any partner or picking an account, **read how prior entries for that counterparty were booked** and mirror them.
- Partners and analytic accounts stay shared (`company_id:false`).
- Idempotency key per line stays `<ACCOUNT>-<txId>` in the move ref.
- Budget app keeps the history before 4/9/2026; the new Mario cash account opens with a real opening-balance row.

## Open questions for Mario
1. Which real wallet is "cash $ lap mario" — is it Odoo journal 87 (Cash Mario USD, S LB) / 21 (SARL) / 146 (S DEV)?
2. Exact Excel paths for Abed, Khodr, Ziad, Mitri, Georges.
3. Neo bank CSV samples (Mario + Therese) to pin the parser.
