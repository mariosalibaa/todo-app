// ── ↶ Undo · ↷ Redo · 🕘 Log, for any page of the hub ────────────────────────
// The accounting grid has kept an undo stack and a change log since 2026-09-08. Mario,
// 2026-09-09: every page should. This is that machinery on its own, so a page adds three
// buttons and a history with one call instead of copying two hundred lines.
//
//   HubHistory.mount({ into: '#bar', area: 'transfers', reload: load });
//   await HubHistory.run({
//     label: 'transfer 120.00',
//     do:  () => Admin.api('PATCH', '/api/accounting/transfers/x', { amount: 120 }),
//     put: prev => Admin.api('PATCH', '/api/accounting/transfers/x', { ...prev, __undo: true }),
//   });
//
// `put` is handed the row's previous fields; `undo`, when you need more, is handed those and the
// whole server reply — `undo: (before, out) => …`.
//
// `do` returns whatever the server sent. When that carries { before, after } — every write the
// hub logs does — the undo step is filled in from `put` for free. A write with no way back (a
// delete that cannot be recreated, an import) is still logged and still shows in 🕘; it simply
// greys ↶ out and says why.
const HubHistory = (() => {
  const undoStack = [], redoStack = [];
  let cfg = { area: '', reload: null, limit: 200 };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const say = (t, cls) => { const m = document.getElementById('msg'); if (m) { m.textContent = t; m.className = 'msg ' + (cls || 'ok'); } };

  function describe(e) {
    if (e.label) return e.label;
    const ks = Object.keys(e.after || {});
    return ks.length ? ks.join(', ') : 'change';
  }
  function paint() {
    const u = document.getElementById('hh-undo'), r = document.getElementById('hh-redo');
    if (u) {
      const top = undoStack[undoStack.length - 1];
      u.disabled = !top || !top.undo;
      u.title = !top ? 'Nothing to undo' : !top.undo ? '"' + describe(top) + '" cannot be undone automatically' : 'Undo: ' + describe(top);
    }
    if (r) {
      const top = redoStack[redoStack.length - 1];
      r.disabled = !top;
      r.title = top ? 'Redo: ' + describe(top) : 'Nothing to redo';
    }
  }

  // run a write and remember how to put it back
  async function run(step) {
    const out = await step.do();
    const before = step.before || (out && out.before) || null;
    const entry = { label: step.label || '', before, after: (out && out.after) || step.after || null, redo: step.do };
    // the caller's own way back — given what the record said before and what the server replied
    // (a batch write answers with a `before` per line, which is the only way to unpick it) — or,
    // failing that, a plain write of the previous fields through `put`
    if (step.undo) entry.undo = () => step.undo(before, out);
    else if (before && Object.keys(before).length && step.put) entry.undo = () => step.put(before);
    undoStack.push(entry); redoStack.length = 0;
    if (undoStack.length > cfg.limit) undoStack.shift();
    paint();
    return out;
  }

  async function undo() {
    const e = undoStack.pop(); if (!e) return;
    if (!e.undo) { undoStack.push(e); return; }
    try { await e.undo(); redoStack.push(e); say('Undone: ' + describe(e)); if (cfg.reload) await cfg.reload(); }
    catch (err) { undoStack.push(e); say('Could not undo: ' + err.message, 'err'); }
    paint();
  }
  async function redo() {
    const e = redoStack.pop(); if (!e) return;
    try { await e.redo(); undoStack.push(e); say('Redone: ' + describe(e)); if (cfg.reload) await cfg.reload(); }
    catch (err) { redoStack.push(e); say('Could not redo: ' + err.message, 'err'); }
    paint();
  }

  // ── 🕘 the log ────────────────────────────────────────────────────────────
  const beirut = at => { try { return new Date(at).toLocaleString('en-GB', { timeZone: 'Asia/Beirut' }); } catch (e) { return at || ''; } };
  const shown = v => v === null || v === undefined || v === '' ? '—'
    : typeof v === 'object' ? JSON.stringify(v) : String(v);
  function rowsOf(e) {
    const keys = [...new Set([...Object.keys(e.before || {}), ...Object.keys(e.after || {})])];
    return keys.map(k => '<tr><td class="k">' + esc(k) + '</td><td class="was">' + esc(shown((e.before || {})[k])) + '</td>'
      + '<td class="arr">→</td><td class="now">' + esc(shown((e.after || {})[k])) + '</td></tr>').join('');
  }
  async function openLog() {
    const box = document.getElementById('hh-log');
    box.hidden = false;
    const body = box.querySelector('.hh-body');
    body.innerHTML = '<p class="hh-none">Reading the log…</p>';
    try {
      const r = await Admin.api('GET', '/api/accounting/log/' + cfg.area + '?limit=' + cfg.limit);
      const es = r.entries || [];
      body.innerHTML = es.length ? es.map(e => '<div class="hh-entry">'
        + '<div class="hh-when">' + esc(beirut(e.at)) + ' · ' + esc(e.who || '') + (e.undo ? ' · <i>undo</i>' : '') + '</div>'
        + (e.line ? '<div class="hh-line">' + esc(e.line) + '</div>' : '')
        + '<table class="hh-diff">' + rowsOf(e) + '</table></div>').join('')
        : '<p class="hh-none">Nothing has been changed here yet.</p>';
    } catch (e) {
      body.innerHTML = '<p class="hh-none">Could not read the log: ' + esc(e.message) + '</p>';
    }
  }
  const closeLog = () => { document.getElementById('hh-log').hidden = true; };

  const CSS = [
    '.hh-btns{display:inline-flex;gap:8px;}',
    '.hh-log{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:60;}',
    '.hh-log[hidden]{display:none;}',
    '.hh-box{background:#fff;border-radius:8px;width:min(680px,94vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3);}',
    '.hh-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line,#dee2e6);font-weight:600;}',
    '.hh-head .sp{flex:1;}',
    '.hh-body{overflow:auto;padding:10px 14px;}',
    '.hh-entry{border-bottom:1px solid #eef0f2;padding:8px 0;}',
    '.hh-when{font-size:11.5px;color:var(--muted,#6c757d);}',
    '.hh-line{font-size:12.5px;margin:2px 0 4px;}',
    '.hh-diff{border-collapse:collapse;font-size:12px;width:100%;}',
    '.hh-diff td{padding:1px 6px 1px 0;vertical-align:top;}',
    '.hh-diff .k{color:var(--muted,#6c757d);width:26%;}',
    '.hh-diff .was{color:#b03030;text-decoration:line-through;width:30%;word-break:break-word;}',
    '.hh-diff .arr{color:var(--muted,#6c757d);width:16px;}',
    '.hh-diff .now{color:#1d7a35;width:30%;word-break:break-word;}',
    '.hh-none{color:var(--muted,#6c757d);padding:20px 0;text-align:center;}',
  ].join('\n');

  function mount(opts) {
    cfg = Object.assign({}, cfg, opts);
    const host = typeof opts.into === 'string' ? document.querySelector(opts.into) : opts.into;
    if (!host) return console.warn('HubHistory: no host for', opts.into);
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const span = document.createElement('span');
    span.className = 'hh-btns';
    span.innerHTML = '<button class="btn" id="hh-undo" title="Nothing to undo" disabled>↶ Undo</button>'
      + '<button class="btn" id="hh-redo" title="Nothing to redo" disabled>↷ Redo</button>'
      + '<button class="btn" id="hh-log-btn" title="Every change made here: when, who, from what to what">🕘 Log</button>';
    host.appendChild(span);
    const dlg = document.createElement('div');
    dlg.className = 'hh-log'; dlg.id = 'hh-log'; dlg.hidden = true;
    dlg.innerHTML = '<div class="hh-box"><div class="hh-head"><span>🕘 Change log</span><span class="sp"></span>'
      + '<button class="btn" id="hh-log-close">Close</button></div><div class="hh-body"></div></div>';
    document.body.appendChild(dlg);
    document.getElementById('hh-undo').onclick = undo;
    document.getElementById('hh-redo').onclick = redo;
    document.getElementById('hh-log-btn').onclick = openLog;
    document.getElementById('hh-log-close').onclick = closeLog;
    dlg.addEventListener('click', e => { if (e.target === dlg) closeLog(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !dlg.hidden) return closeLog();
      const meta = e.ctrlKey || e.metaKey;
      if (!meta || (e.target && e.target.matches && e.target.matches('input, textarea, select'))) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    paint();
  }

  return { mount, run, undo, redo, openLog, closeLog, stacks: () => ({ undoStack, redoStack }) };
})();
