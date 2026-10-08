# Shift Hub (hub.shift-group.co) — rules for every change

- **Photos and papers open in the same page, never a new tab** (Mario 2026-10-07; the hub runs as an installed Chrome app). `media-viewer.js` is put into every page by `server.js`; link to the file with a plain `<a href>` or call `HubViewer.open(url, {name, kind, list})`. Never `target="_blank"` / `window.open` for a photo, PDF or file.
- **Every page can be installed** on the phone / desktop (manifest + service worker) — keep new pages in the PAGES map so they get it.
- Run `node verify-hub.mjs --only <pages>` before `npx vercel deploy --prod --yes`, always from `D:\vscode\todo`.
- **Choosing one of many (an account, a supplier, a project, a partner…) is always `Admin.pick(host, {items, value, onPick})`** from `admin-shared.js` — one box you type in, ↓ ↑ Enter, groups, the open one marked — never a plain `<select>` once the list is longer than a handful (Mario 2026-10-08: "same as Accounts, everywhere, and for future features"). Short fixed lists (a period, a type) may stay a `<select>`.
- **Money is shown as `4,000.00$`** — `Admin.money(n, cur)` (thousands separated, two decimals, $ after; LBP keeps "LBP"). Mario cash and every receipt land in USD: an LBP paper becomes its printed $ total, else LBP / 89,500 (`toUsd` in site-parse.js), the LBP figure kept in the description.
- Dates in browser code: Beirut local, never `toISOString()` for a yyyy-mm-dd.
- One Claude session commits here at a time.
