// The laptop half of the Shift chat's coding (Mario 2026-10-18: "a conversation that acts like Claude — no coding
// when the laptop is off, coding when it is on"). Runs all the time on the laptop (Task Scheduler "ShiftDevRunner",
// at logon, through tools/hidden.vbs):
//   every 30 s  → POST /api/dev-requests/laptop (the hub shows 💻 on / 💤 off in the Shift thread, the agent knows)
//   an open request with auto:true (written by the ✓ on a hub_dev_request card) → Claude Code (`claude -p`) in the
//   repo it names, one at a time; "started" and the final answer go back into the thread the card was in.
// kind 'code' commits locally and never deploys or pushes; kind 'deploy' ships — each only after Mario's ✓ on its card.
// A follow-up in the same thread + repo within 3 h resumes the same Claude session, so it reads like one conversation.
// The hub lock (todo/.claude-session.lock, shift-rules hook) is respected: while another session works in the hub,
// hub jobs wait and the chat is told once.
//
//   node dev-runner.mjs            run forever
//   node dev-runner.mjs --once     one beat + at most one job, then exit (testing)
//   HUB_URL=http://localhost:8099 overrides the hub
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HUB = process.env.HUB_URL || 'https://hub.shift-group.co';
const ROOT = 'D:/vscode';
const CLAUDE = path.join(os.homedir(), '.local/bin/claude.exe');
const HUB_LOCK = `${ROOT}/todo/.claude-session.lock`, LOCK_TTL_MS = 90 * 60e3;
const STATE = path.join(os.homedir(), '.shift-dev-runner.json');   // { sessions: { "<thread>|<repo>": { id, at } } }
const PIDFILE = path.join(os.tmpdir(), 'shift-dev-runner.pid');
const LOG = `${ROOT}/todo/dev-runner.log`;
const JOB_MS = 45 * 60e3, BEAT_MS = 30e3, RESUME_MS = 3 * 3600e3;
const once = process.argv.includes('--once');

let key = process.env.ACCOUNTING_API_KEY || '';
if (!key) { try { key = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.whish-watcher.json'), 'utf8')).accountingApiKey || ''; } catch {} }
const log = (...a) => { const l = `${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut' })} ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} };

async function call(method, p, body) {
  const r = await fetch(HUB + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30e3) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${method} ${p} → ${r.status}`);
  return j;
}
const say = (thread, text) => call('POST', '/api/site/agent/reply', { thread, kind: 'text', text: text.slice(0, 3900) }).catch(e => log('reply failed:', e.message));
const beat = (busy, job) => call('POST', '/api/dev-requests/laptop', { host: os.hostname(), busy, job }).catch(e => log('beat failed:', e.message));

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sessions: {} }; } };
const writeState = s => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch {} };
const hubLocked = () => { try { return Date.now() - fs.statSync(HUB_LOCK).mtimeMs < LOCK_TTL_MS && !!fs.readFileSync(HUB_LOCK, 'utf8').trim(); } catch { return false; } };
const repoDir = r => ['todo', 'shift-hub', 'odoo', 'wa-contacts'].includes(r) ? `${ROOT}/${r}` : r === 'website' ? 'D:/Dropbox/0. SHIFT/00. branding/Website/site source (shift-website)' : ROOT;

function brief(it) {
  const deploy = it.kind === 'deploy';
  return `You are Claude Code on Mario's laptop, working a request he sent from his phone in the Shift chat on the hub and approved with ✓.
He cannot see this terminal: your FINAL message is posted back into his chat as the answer.

Request: ${it.title}
${it.page ? `Page: ${it.page}\n` : ''}Repo: ${it.repo} (${repoDir(it.repo)})
Kind: ${deploy ? 'DEPLOY' : 'CODE'}

${it.prompt}

Rules (on top of D:\\vscode\\CLAUDE.md, SHIFT.md and the skills):
${deploy
    ? `- Ship what is already committed in this repo: verify first (hub: the hub-verify skill), then deploy/push the way this repo does (hub: npx vercel deploy --prod --yes from D:\\vscode\\todo, then git push; shift-hub: git push). Nothing else.`
    : `- Make the change, verify it (hub: node verify-hub.mjs --only <pages you touched>), commit locally.
- Do NOT deploy, do NOT git push — Mario says "ship it" in the chat when he wants it live.`}
- Never send anything outward (WhatsApp, email, Telegram to anyone), never spend credits, never delete Odoo entries.
- When something needs his decision, do the clear part and ask the question in your final message instead of guessing.
- Final message: plain text for a phone, at most 8 short lines, no tables or headings — what you did, the commit hash, what to look at, what is still open.`;
}

function runClaude(it, resume) {
  return new Promise(resolve => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', ...(resume ? ['--resume', resume] : [])];
    // no ANTHROPIC_API_KEY in the child: it runs on Mario's Max subscription (claude.ai login), never on paid API credit
    const child = spawn(CLAUDE, args, { cwd: repoDir(it.repo), windowsHide: true, env: (({ ANTHROPIC_API_KEY, ...e }) => ({ ...e, SHIFT_DEV_RUNNER: '1' }))(process.env) });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const t = setTimeout(() => { err += '\n(stopped after 45 min)'; child.kill(); }, JOB_MS);
    child.on('close', code => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      resolve({ ok: code === 0 && j && !j.is_error, result: (j && j.result) || err.trim().slice(-1500) || `claude exited ${code}`, session: j && j.session_id, cost: j && j.total_cost_usd });
    });
    child.stdin.end(brief(it));
  });
}

const told = new Set();   // requests whose "waiting for the hub lock" was already said
async function tick() {
  let items = [];
  try { items = (await call('GET', '/api/dev-requests?status=open')).items || []; } catch (e) { log('queue:', e.message); await beat(false, ''); return; }
  const it = items.find(x => x.auto && x.status === 'open' && !(x.repo === 'todo' && hubLocked()));
  for (const x of items) if (x.auto && x.status === 'open' && x.repo === 'todo' && hubLocked() && !told.has(x.id)) {
    told.add(x.id); await say(x.thread || 'shift', `⏳ "${x.title}" waits: another Claude session is working in the hub right now. It starts by itself when that one finishes.`);
  }
  if (!it) { await beat(false, ''); return; }
  const st = readState(), sk = `${it.thread}|${it.repo}`, prev = st.sessions[sk];
  const resume = prev && Date.now() - prev.at < RESUME_MS ? prev.id : null;
  await call('PATCH', `/api/dev-requests/${it.id}`, { status: 'doing' });
  await beat(true, it.title);
  const hb = setInterval(() => beat(true, it.title), BEAT_MS);
  log('start', it.id, it.kind, it.repo, it.title, resume ? 'resume ' + resume : '');
  await say(it.thread || 'shift', `🛠 Started on the laptop: ${it.title}${it.kind === 'deploy' ? ' (deploy)' : ''}`);
  let r;
  try { r = await runClaude(it, resume); } finally { clearInterval(hb); }
  if (r.session) { st.sessions[sk] = { id: r.session, at: Date.now() }; writeState(st); }
  log('end', it.id, r.ok ? 'ok' : 'FAILED', r.cost != null ? '$' + r.cost.toFixed(2) : '', r.session || '');
  await say(it.thread || 'shift', (r.ok ? '✅ ' : '❌ ') + r.result);
  const commit = (String(r.result).match(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/) || [''])[0];   // a hash, not a plain number
  await call('PATCH', `/api/dev-requests/${it.id}`, { status: r.ok ? 'done' : 'dropped', result: r.result, commit, notes: `laptop run · session ${r.session || '?'}${r.cost != null ? ' · ~$' + r.cost.toFixed(2) + ' API-equivalent (Max plan, not billed)' : ''}${r.ok ? '' : ' · failed'}` }).catch(e => log('close:', e.message));
  await beat(false, '');
}

// one runner per laptop
try { const pid = +fs.readFileSync(PIDFILE, 'utf8'); if (pid && pid !== process.pid) { process.kill(pid, 0); if (!once) { console.log('already running as', pid); process.exit(0); } } } catch {}
if (!once) fs.writeFileSync(PIDFILE, String(process.pid));
if (!key && !/localhost/.test(HUB)) { log('no machine key (~/.whish-watcher.json accountingApiKey)'); process.exit(1); }
log('dev-runner up on', os.hostname(), '→', HUB);
// a job left "doing" by a crash or a shutdown goes back to open (we are the only runner)
try { for (const x of (await call('GET', '/api/dev-requests?status=open')).items || []) if (x.auto && x.status === 'doing') { await call('PATCH', `/api/dev-requests/${x.id}`, { status: 'open', notes: 'interrupted (laptop restarted) — runs again' }); log('reopened', x.id); } } catch (e) { log('reopen:', e.message); }
if (once) { await tick(); setTimeout(() => process.exit(0), 200); }
else for (;;) { try { await tick(); } catch (e) { log('tick:', e.message); } await new Promise(r => setTimeout(r, BEAT_MS)); }
