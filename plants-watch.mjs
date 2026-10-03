// Task Scheduler "PlantsWatch", every 15 min: asks the hub to run the plant offline check (/api/plants/check, see
// plants.js). The hub sends the Telegram itself — api.telegram.org is blocked from this laptop. Key = the Whish
// watcher's machine key (~/.whish-watcher.json → accountingApiKey = Vercel ACCOUNTING_API_KEY).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.whish-watcher.json'), 'utf8')).accountingApiKey;
const LOG = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1')), 'plants-watch.log');
const log = s => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch {} };
try {
  const r = await fetch('https://hub.shift-group.co/api/plants/check', { method: 'POST', headers: { Authorization: 'Bearer ' + key } });
  log(`${r.status} ${(await r.text()).slice(0, 300)}`);
} catch (e) { log('error ' + e.message); }
