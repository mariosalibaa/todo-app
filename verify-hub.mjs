// Hub verification loop — "can the agent run the thing" (skill: hub-verify).
// Starts the hub locally on a spare port (local mode = no sign-in, live Firestore, read-only visits),
// opens every page in a desktop and a phone viewport, records console errors + failed requests +
// blank pages, screenshots each into verify/<date>/, prints a summary, exits 1 on any failure.
//
//   node verify-hub.mjs                    all pages, desktop + phone
//   node verify-hub.mjs --only /accounting/statements,/reports
//   node verify-hub.mjs --url https://hub.shift-group.co --cookie "<name=value>"   (prod, signed-in cookie)
//   node verify-hub.mjs --keep             leave the local server running (port printed)
//
// Playwright comes from wa-contacts' node_modules (same browsers as the WhatsApp tooling) so the hub's
// own package.json stays untouched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = createRequire('D:/vscode/wa-contacts/package.json')('playwright')); }

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
// Git Bash rewrites a leading '/x' argument into 'C:/Program Files/Git/x' — undo that
const ONLY = arg('only', '').split(',').map(s => s.trim().replace(/^[A-Za-z]:\/Program Files\/Git/i, '')).filter(Boolean).map(s => '/' + s.replace(/^\/+/, ''));
const URL_BASE = arg('url', '');
const COOKIE = arg('cookie', '');
const KEEP = process.argv.includes('--keep');
const PORT = Number(arg('port', 8099));

// every route in server.js PAGES except the public hand-out page
const PAGES = ['/admin', '/members', '/ask', '/todo', '/accounting', '/accounting/whish', '/accounting/daily', '/accounting/statements',
  '/accounting/transfers', '/accounting/wise', '/accounting/budget', '/accounting/dashboard', '/partners', '/ajaltoun',
  '/ajaltoun/excavation', '/ajaltoun/excavation/summary', '/site', '/reports', '/decisions', '/crm', '/rent-law', '/mechanical'];
const VIEWPORTS = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
// noise that is not a hub bug
const IGNORE = [/favicon/i, /sw\.js/i, /manifest/i, /ResizeObserver loop/i, /net::ERR_ABORTED/i, /api\.telegram\.org/i, /googleapis\.com.*401/i];
const noisy = s => IGNORE.some(re => re.test(s));

const day = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // local date, not UTC
const OUT = path.join(HERE, 'verify', day);
fs.mkdirSync(OUT, { recursive: true });

async function startLocal() {
  const child = spawn(process.execPath, ['server.js'], { cwd: HERE, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(base + '/todo'); if (r.ok) return { child, base, logs: () => logs }; } catch {}
    if (child.exitCode !== null) break;
  }
  child.kill();
  throw new Error('hub did not start on ' + PORT + '\n' + logs.slice(-1500));
}

(async () => {
  const local = URL_BASE ? null : await startLocal();
  const base = URL_BASE || local.base;
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const route of (ONLY.length ? ONLY : PAGES)) {
    for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, deviceScaleFactor: viewport.deviceScaleFactor });
      if (COOKIE) { const [name, ...rest] = COOKIE.split('='); await ctx.addCookies([{ name, value: rest.join('='), url: base }]); }
      const page = await ctx.newPage();
      const errors = [], failed = [];
      page.on('console', m => { if (m.type() === 'error' && !noisy(m.text())) errors.push(m.text().slice(0, 200)); });
      page.on('pageerror', e => errors.push('pageerror: ' + String(e.message || e).slice(0, 200)));
      page.on('response', r => { if (r.status() >= 400 && !noisy(r.url())) failed.push(`${r.status()} ${r.url().replace(base, '')}`.slice(0, 160)); });
      const t0 = Date.now();
      let status = 'ok', note = '';
      try {
        const resp = await page.goto(base + route, { waitUntil: 'load', timeout: 45000 });
        // the accounting pages keep polling; give them 15 s to settle, then judge what is there
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        if (!resp || resp.status() >= 400) { status = 'fail'; note = 'HTTP ' + (resp && resp.status()); }
        await page.waitForTimeout(800);
        const text = (await page.evaluate(() => document.body && document.body.innerText || '')).trim();
        const title = await page.title();
        if (!text || text.length < 20) { status = 'fail'; note = note || 'blank page'; }
        if (/cannot get|internal server error|something went wrong/i.test(text)) { status = 'fail'; note = note || 'error text on page'; }
        if (/sign in|log in/i.test(title) && !COOKIE && URL_BASE) { status = 'fail'; note = 'login wall (pass --cookie)'; }
        // horizontal overflow on the phone = a layout bug (memory: hub-mobile-and-paper)
        if (vp === 'phone') {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (over > 8) { status = status === 'ok' ? 'warn' : status; note = (note ? note + '; ' : '') + `phone scrolls sideways by ${over}px`; }
        }
      } catch (e) { status = 'fail'; note = String(e.message || e).split('\n')[0].slice(0, 160); }
      if (errors.length || failed.length) status = status === 'ok' ? 'warn' : status;
      const shot = path.join(OUT, route.replace(/^\//, '').replace(/\//g, '_') + '-' + vp + '.png');
      try { await page.screenshot({ path: shot, fullPage: vp === 'desk' }); } catch {}
      results.push({ route, vp, status, ms: Date.now() - t0, note, errors, failed, shot: path.relative(HERE, shot) });
      await ctx.close();
    }
  }
  await browser.close();
  if (local && !KEEP) local.child.kill();

  const icon = { ok: '✓', warn: '△', fail: '✗' };
  let fails = 0;
  for (const r of results) {
    if (r.status === 'fail') fails++;
    console.log(`${icon[r.status]} ${r.route.padEnd(32)} ${r.vp.padEnd(5)} ${String(r.ms).padStart(5)} ms  ${r.note}`);
    for (const e of r.errors) console.log('     console: ' + e);
    for (const f of r.failed) console.log('     request: ' + f);
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length} checks, ${fails} failed, ${results.filter(r => r.status === 'warn').length} with warnings → ${path.relative(HERE, OUT)}/`);
  if (local && KEEP) console.log(`local hub still running on ${base}`);
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error('FATAL', e.message); process.exitCode = 1; });
