// The hub's dev queue from the laptop (skill hub-dev-queue). Reads hub.shift-group.co/api/dev-requests with the
// machine key in ~/.whish-watcher.json (the hub's ACCOUNTING_API_KEY) and prints the open requests as one brief
// for Claude Code; marks one done / doing / dropped with its commit.
//
//   node dev-queue.mjs                       open requests, as a brief (markdown)
//   node dev-queue.mjs --json                the same as JSON
//   node dev-queue.mjs --doing <id>
//   node dev-queue.mjs --done <id> --commit <hash> [--notes "..."]
//   node dev-queue.mjs --drop <id> [--notes "..."]
//   HUB_URL=http://localhost:8080 overrides the hub (local server in local mode needs no key)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HUB = process.env.HUB_URL || 'https://hub.shift-group.co';
let key = process.env.ACCOUNTING_API_KEY || '';
if (!key) { try { key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.whish-watcher.json'), 'utf8')).accountingApiKey || ''; } catch {} }
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function call(method, p, body) {
  const r = await fetch(HUB + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || (method + ' ' + p + ' → ' + r.status));
  return j;
}

const id = opt('--done') || opt('--doing') || opt('--drop');
if (id) {
  const patch = opt('--done') ? { status: 'done', commit: opt('--commit') || '' } : opt('--doing') ? { status: 'doing' } : { status: 'dropped' };
  if (opt('--notes')) patch.notes = opt('--notes');
  const r = await call('PATCH', '/api/dev-requests/' + id, patch);
  console.log(`${r.id} → ${r.status}${r.commit ? ' (' + r.commit.slice(0, 7) + ')' : ''}: ${r.title}`);
} else {
  const { items } = await call('GET', '/api/dev-requests?status=open');
  if (args.includes('--json')) { console.log(JSON.stringify(items, null, 2)); process.exit(0); }
  if (!items.length) { console.log('The dev queue is empty.'); process.exit(0); }
  console.log(`# Hub dev queue — ${items.length} open\n`);
  for (const [i, x] of items.entries()) {
    console.log(`## ${i + 1}. [${x.id}] ${x.title}${x.page ? '  (' + x.page + ')' : ''}${x.status === 'doing' ? '  — already started' : ''}`);
    console.log(`queued ${x.createdAt.slice(0, 16).replace('T', ' ')} by ${x.createdBy}\n`);
    console.log(x.prompt || '(no brief — ask Mario)');
    if (x.asked) console.log(`\n> Mario said: ${x.asked.replace(/\n/g, '\n> ')}`);
    if (x.notes) console.log(`\nnotes: ${x.notes}`);
    console.log();
  }
}
// node 24 on Windows sometimes trips a libuv assertion while tearing down the fetch socket — leave cleanly
process.exit(0);
