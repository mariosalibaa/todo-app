// Learn from Mario — step 2 (judgement): turn the day's corrections into principle-level
// proposals for the worker-statement-round skill, and tell Mario on Telegram.
//
// 1. learn-diff.mjs → learn/corrections-<day>.md (what he changed on worker lines since last run)
// 2. if anything changed: `claude -p` reads the corrections + the skill + the related memories and
//    writes learn/proposal-<day>.md — 1–5 PRINCIPLES (not per-line rules) with the evidence, and
//    the exact text to add/replace in SKILL.md. It never edits the skill itself: Mario (or a
//    session he asks) applies it — "apply the learning proposal".
// 3. one Telegram line through the hub relay, silent when there were no corrections.
//
// Task Scheduler "LearnFromMario", daily 22:30, via tools/hidden.vbs (never node.exe directly).
//   node learn-nightly.mjs            normal run
//   node learn-nightly.mjs --dry-run  diff only, no Claude, no Telegram, cursor not moved
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DRY = process.argv.includes('--dry-run');
const DIR = path.join(HERE, 'learn');
const LOG = path.join(DIR, 'nightly.log');
const SKILL = path.join(os.homedir(), '.claude', 'skills', 'worker-statement-round', 'SKILL.md');
const MEM = path.join(os.homedir(), '.claude', 'projects', 'd--vscode', 'memory');
const HUB = process.env.HUB_URL || 'https://hub.shift-group.co';
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); if (!DRY) fs.appendFileSync(LOG, line + '\n'); };

function run(cmd, args, opts = {}) {
  const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;   // a nested `claude -p` refuses to start inside a Claude session otherwise
  const r = spawnSync(cmd, args, { cwd: HERE, encoding: 'utf8', shell: process.platform === 'win32', env, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const diff = run('node', ['learn-diff.mjs', ...(DRY ? ['--dry-run'] : [])]);
  const m = diff.out.match(/corrections=(\d+) file=(\S+)/);
  if (!m) { log('learn-diff failed:', diff.out.slice(-400)); process.exitCode = 1; return; }
  const count = +m[1], file = path.join(HERE, m[2]);
  log(`corrections=${count}`);
  if (!count) { log('nothing to learn tonight'); return; }
  if (DRY) { console.log(diff.out); return; }

  const day = path.basename(file).replace(/^corrections-|\.md$/g, '');
  const proposal = path.join(DIR, `proposal-${day}.md`);
  const memFiles = ['hub-analytic-split.md', 'hub-fuel-by-car.md', 'worker-vendor-rows-rule.md', 'hub-timesheet-costing.md', 'worker-sheet-is-the-truth.md', 'statement-round.md']
    .map(f => path.join(MEM, f)).filter(fs.existsSync);
  const prompt = `You are improving the skill that reconciles Shift's worker cash ledgers. Read, in this order:
1. ${file}  — every field Mario changed on worker lines since the last run (proposal → what he set)
2. ${SKILL}  — the current skill
3. ${memFiles.join('\n   ')}  — the memories the skill leans on

Then write ${proposal} with exactly these sections:
# Learning proposal ${day}
## What the corrections say
For each GROUP of similar corrections (not each line): the pattern, how many lines, 2-3 evidence lines quoted (date · description · from → to).
## Principles to add or change (max 5)
Write each as a principle a new colleague could apply to a situation you have not seen — "when X, do Y because Z" — never a per-line rule ("on 2026-09-04 use project 45"). If Mario's edits contradict an existing line of the skill, say which line and propose the replacement.
## Exact edit to SKILL.md
The full text of a "## Learned from Mario" section (or the changed lines of an existing section) ready to paste. Keep the skill under 90 lines total.
## Mechanical rules worth coding
Only if a correction repeats with no judgement involved (e.g. "every Khoder benzine line → car Tacoma"): one line each, naming the hub file that would hold it (ledgers.js waLine / daily.html defaults / whish-rules.js). Otherwise write "none".

Rules: do not edit SKILL.md or any memory file; write only the proposal file. Be concrete, short, no preamble. If the corrections are only ✓ acceptances with nothing changed, say so in one line and stop.`;

  const t0 = Date.now();
  // prompt on stdin — it has quotes and newlines, which a Windows shell would mangle on argv
  const claude = run('claude', ['-p', '--allowedTools', 'Read,Write,Glob,Grep', '--output-format', 'text', '--max-turns', '25'], { input: prompt, timeout: 15 * 60 * 1000 });
  const ok = claude.code === 0 && fs.existsSync(proposal);
  log(`claude ${ok ? 'wrote' : 'FAILED'} ${path.basename(proposal)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!ok) log(claude.out.slice(-600));

  // one line for Mario: the principle headings, and how to apply
  let heads = [];
  if (ok) {
    const text = fs.readFileSync(proposal, 'utf8');
    const sec = text.split(/^## Principles[^\n]*\n/m)[1] || '';
    heads = sec.split(/^## /m)[0].split('\n').filter(l => /^\s*(\d+[.)]|-|\*)\s+\*{0,2}\S/.test(l)).map(l => l.replace(/^\s*(\d+[.)]|-|\*)\s+/, '').replace(/\*\*/g, '').split(/[—:]/)[0].trim()).filter(Boolean).slice(0, 5);
  }
  const text = ok
    ? `🧠 Learned from ${count} correction(s) on worker lines\n` + heads.map(h => '• ' + h).join('\n') + `\n\nProposal: todo/learn/${path.basename(proposal)}\nSay "apply the learning proposal" in Claude to fold it into the skill.`
    : `🧠 ${count} correction(s) collected (todo/learn/${path.basename(file)}) but the proposal step failed — check learn/nightly.log`;
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.whish-watcher.json'), 'utf8'));
    const r = await fetch(HUB + '/api/accounting/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secrets.accountingApiKey }, body: JSON.stringify({ text, chatId: secrets.chatId }) });
    log('telegram', r.status);
  } catch (e) { log('telegram failed', e.message); }
  process.exitCode = ok ? 0 : 1;
})().catch(e => { log('FATAL', e.message); process.exitCode = 1; });
