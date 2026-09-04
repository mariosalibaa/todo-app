// Pull Wise statements with Playwright and import them into the hub.
//
// Wise closed the API statement route on personal accounts (PSD2), so this drives the
// website instead: it creates a CSV statement for every balance over a date range,
// then imports each file. Wise names each file statement_<balanceId>_<CUR>_<from>_<to>.csv,
// which is how the importer keeps the five USD balances apart.
//
//   node wise-pull.js                       # 1 Jan of this year -> today
//   node wise-pull.js 2025-01-01 2025-12-31 # explicit range
//   node wise-pull.js --headed              # watch it work / log in the first time
//
// The first run needs you to log in once; the session is kept in .wise-profile next to
// this file, so later runs are unattended until Wise expires it.
//
// Two things learned the hard way, both handled below:
//  * Clicking "Download statement" starts a real browser download that kills the
//    automation connection. Instead the download click is swallowed and the file is
//    fetched from the same endpoint the page uses.
//  * That endpoint needs the app's own `x-access-token` header — cookies alone give 401 —
//    so the header is captured off the page's own fetch before replaying it.

const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join('D:', 'vscode', 'wa-schedule', 'node_modules', 'playwright'))); }

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HEADED = process.argv.includes('--headed');
const year = new Date().getFullYear();
const FROM = args[0] || `${year}-01-01`;
const TILL = args[1] || new Date().toISOString().slice(0, 10);
const HUB = process.env.WISE_HUB || 'http://127.0.0.1:8099';
const PROFILE = path.join(__dirname, '.wise-profile');

const NAMES = {
  '10012290': 'Wise USD (main)', '66364876': 'Wise EUR', '100148943': 'Wise AED',
  '74499448': 'Wise USD stocks', '85518568': 'Wise USD stocks 2',
  '74501147': 'Wise interest (USD)', '137924820': 'Wise Christa (USD)',
};
const longDate = iso => { const d = new Date(iso + 'T12:00:00Z');
  return `${d.getUTCDate()} ${['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

function post(p, body) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(body);
    const lib = HUB.startsWith('https') ? https : http;
    const u = new URL(HUB + p);
    const r = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { try { res({ status: x.statusCode, body: JSON.parse(s) }); } catch { res({ status: x.statusCode, body: s.slice(0, 200) }); } }); });
    r.on('error', rej); r.end(d);
  });
}

(async () => {
  console.log(`Wise -> hub   ${FROM} to ${TILL}\n`);
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: !HEADED, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://wise.com/balances/statements/balance-statement/create', { waitUntil: 'domcontentloaded' });
  if (/\/login/.test(page.url())) {
    console.log('Not signed in. Re-run with --headed and log in once; the session is then remembered.');
    await ctx.close(); process.exit(2);
  }
  await page.waitForTimeout(2500);

  // 1. dates — click through the calendar to the wanted day
  const pickDate = async (label, iso) => {
    const want = longDate(iso);
    await page.evaluate(l => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === l); if (b) b.click(); }, label);
    await page.waitForTimeout(600);
    await page.evaluate(async want => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const dlg = () => document.querySelector('[role=dialog]') || document.body;
      const target = new Date(want + ' UTC');
      for (let i = 0; i < 90; i++) {
        const hit = [...dlg().querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === want);
        if (hit) { hit.click(); return; }
        const head = dlg().innerText.split('\n')[0];
        const cur = new Date(head + ' 1 UTC');
        const dir = target < cur ? 'previous month' : 'next month';
        const nav = [...dlg().querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === dir);
        if (!nav) return;
        nav.click(); await wait(120);
      }
    }, want);
    await page.waitForTimeout(500);
  };
  await pickDate('From', FROM);
  await pickDate('To', TILL);

  // 2. every currency, 3. CSV
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const btn = t => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === t);
    btn('Select currencies') && btn('Select currencies').click(); await wait(700);
    const g = [...document.querySelectorAll('[role=group]')].find(x => /Your currencies/i.test(x.getAttribute('aria-label') || x.innerText.slice(0, 40)));
    const sa = g && [...g.querySelectorAll('button')].find(b => b.innerText.trim() === 'Select all');
    if (sa) sa.click(); await wait(800);
    const csv = [...document.querySelectorAll('[role=radio],label,button,div')].filter(e => /^CSV\b/.test(e.innerText.trim()) && e.innerText.trim().length < 40);
    if (csv.length) csv[csv.length - 1].click(); await wait(700);
  });

  // 4. generate
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Generate' && !x.disabled); if (b) b.click(); });
  await page.waitForFunction(() => /Download statement/i.test(document.body.innerText), null, { timeout: 90000 });
  const statementId = page.url().split('/').pop();
  console.log('statement', statementId);

  // fetch the zip ourselves: swallow the download click, steal the header, replay the call
  const b64 = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const F = window.fetch; let tok = null, url = null;
    const read = src => !src ? null : (typeof src.get === 'function' ? src.get('x-access-token') : (src['x-access-token'] || src['X-Access-Token']));
    window.fetch = function (input, init) {
      try { const u = typeof input === 'string' ? input : input.url;
        if (/statement-file/.test(u)) { url = u; tok = read(init && init.headers) || read(input && input.headers); } } catch {}
      return F.apply(this, arguments);
    };
    const A = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    const b = [...document.querySelectorAll('button')].find(x => /Download statement/i.test(x.innerText));
    if (b) b.click();
    await wait(3000);
    window.fetch = F; HTMLAnchorElement.prototype.click = A;
    if (!tok || !url) return null;
    const r = await F(url, { credentials: 'include', headers: { 'x-access-token': tok } });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return btoa(s);
  });
  await ctx.close();
  if (!b64) { console.error('Could not fetch the statement file.'); process.exit(1); }

  // unzip in memory — one CSV per balance
  const zip = Buffer.from(b64, 'base64');
  const dir = path.join(os.tmpdir(), 'wise-pull');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'statements.zip'), zip);
  const { execFileSync } = require('child_process');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${path.join(dir, 'statements.zip')}' -DestinationPath '${dir}' -Force`]);

  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  console.log(`\n${files.length} balances\n`);
  let added = 0;
  for (const f of files) {
    const csv = fs.readFileSync(path.join(dir, f), 'utf8');
    const id = (f.match(/statement[_-](\d+)/) || [])[1];
    const up = await post('/api/accounting/wise/upload', { csv, filename: f, accountName: NAMES[id] || '' });
    if (up.status === 200) {
      const a = up.body.accounts[0];
      added += a.added;
      console.log(`  ${(NAMES[id] || id).padEnd(22)} ${String(a.lines).padStart(4)} lines  ${a.added} new  closing ${a.closing}`);
    } else if (/no transactions/i.test(JSON.stringify(up.body))) {
      console.log(`  ${(NAMES[id] || id).padEnd(22)}    no movement in this period`);
    } else {
      console.log(`  ${(NAMES[id] || id).padEnd(22)} FAILED ${JSON.stringify(up.body).slice(0, 80)}`);
    }
  }
  console.log(`\n${added} new lines imported.`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
