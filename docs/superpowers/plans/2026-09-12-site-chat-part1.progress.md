Task 1: complete (bak-siteflags; review approved; admin Daily checkbox + projects n>0 fixed by controller)
Task 2: complete (new daily-access.js + test; 3/3 pass; verbatim module reviewed by controller)
Task 3: complete (bak-dailyro; review approved, no findings)
Task 4+5: complete (hub-files.js, site-parse.js, tests 7/7; claudeParse live probe OK by controller with invoice-renamer-web key; local hub has NO ANTHROPIC_API_KEY in env — start it with the key for AI smoke tests)
Task 6: complete (site.js new, bak-sitemount/bak-fix6/bak-fix6b; src 'site' gates fix bak-sitesrc; re-review approved; digest is an explicit awaited route, no fire-and-forget)
Task 7: complete (site.html new, bak-fix7; e2e moved to e2e/site.mjs so node --test does not run it; re-review approved; minors: retry has no "retrying…" state, esc on ids is HTML- not JS-escaping)
Task 8: complete (bak-sitemedia; small diff reviewed by controller)
Final review (opus): must-fix 1-3 + should-fix 4-10 applied (bak-final1); controller: threads lookup parallelised, placeholder "Write, or talk with Flow". Re-review pending.
Pre-deploy checklist for Mario: enable Firebase Storage; add OPENAI_API_KEY on Vercel; vercel.json has no maxDuration (digest = vision + Odoo reads may exceed the 10 s default); Vercel body cap ~4.5 MB → videos deferred; tick daily/site on the members table.
Final re-review: approved — ready to show Mario. Receipt branch carries nature 'expense' (controller). NOT deployed.
