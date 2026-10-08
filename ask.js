// ── Ask: the chat box, on every hub page ─────────────────────────────────────────────────────
// A round button at the bottom right; it opens a panel that talks to /api/assistant. The key
// lives on the server, the assistant may only read (see assistant.js), and every answer says
// which lookups it made. The conversation is kept for this tab only — nothing is stored.
(() => {
  const A = window.Admin;
  if (!A) return;
  const esc = A.esc || (s => String(s == null ? '' : s));
  const KEY = 'hub.ask.open';
  let msgs = [], busy = false, panel = null;

  const CSS = `
  #ask-btn{position:fixed;right:16px;bottom:64px;z-index:1450;width:46px;height:46px;border-radius:50%;border:0;cursor:pointer;
    background:#128c7e;color:#fff;font-size:1.25rem;box-shadow:0 4px 14px rgba(0,0,0,.28);}
  #ask-btn:hover{filter:brightness(1.08);}
  #ask{position:fixed;right:16px;bottom:118px;z-index:1450;width:min(380px,calc(100vw - 32px));max-height:min(560px,70vh);
    display:flex;flex-direction:column;border-radius:14px;overflow:hidden;font:inherit;font-size:.86rem;
    background:var(--mantle,#1e1e2e);color:var(--text,#cdd6f4);box-shadow:0 12px 40px rgba(0,0,0,.35);border:1px solid var(--surface0,#45475a);}
  #ask .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--crust,#181825);border-bottom:1px solid var(--surface0,#45475a);}
  #ask .hd b{font-size:.9rem;} #ask .hd .sp{flex:1;}
  #ask .hd button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;opacity:.7;padding:2px 6px;}
  #ask .body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
  #ask .m{padding:8px 10px;border-radius:10px;max-width:92%;white-space:pre-wrap;line-height:1.45;}
  #ask .m.me{align-self:flex-end;background:#128c7e;color:#fff;}
  #ask .m.it{align-self:flex-start;background:var(--crust,#181825);}
  #ask .m.err{align-self:flex-start;background:#3a1f22;color:#f5a3b0;}
  #ask .used{font-size:.7rem;opacity:.55;margin-top:4px;}
  #ask .hint{font-size:.74rem;opacity:.6;}
  #ask .ft{display:flex;gap:6px;padding:8px;border-top:1px solid var(--surface0,#45475a);background:var(--crust,#181825);}
  #ask .ft textarea{flex:1;resize:none;font:inherit;font-size:.86rem;padding:7px 9px;border-radius:9px;min-height:36px;max-height:110px;
    background:var(--mantle,#1e1e2e);color:inherit;border:1px solid var(--surface0,#45475a);}
  #ask .ft button{border:0;border-radius:9px;padding:0 13px;background:#128c7e;color:#fff;font:inherit;cursor:pointer;}
  #ask .ft button:disabled{opacity:.5;cursor:default;}
  @media(max-width:700px){ #ask{right:8px;left:8px;width:auto;bottom:108px;} #ask-btn{right:10px;bottom:58px;} }`;

  function draw() {
    const body = panel.querySelector('.body');
    const mario = A.me && A.me.admin && !A.me.viewAs;
    body.innerHTML = msgs.length ? '' : mario
      ? `<div class="hint">Ask about the ledgers — "what did we pay Attal this month", "balance of Mario cash", "Ziad's lines not in Odoo".<br>Tell it about money — "Ziad paid 19 for Elias' phone today" — it puts a line on the ledger that waits for your ✓.<br>Ask for a change to the hub — it goes to <a href="/dev" style="color:inherit">/dev</a> for Claude Code. It never books, never sends, never accepts.</div>`
      : `<div class="hint">Ask about the ledgers — "what did we pay Attal this month", "balance of Mario cash", "Ziad's lines not in Odoo". It reads; it never changes anything.</div>`;
    for (const m of msgs) {
      const d = document.createElement('div');
      d.className = 'm ' + (m.role === 'user' ? 'me' : m.error ? 'err' : 'it');
      d.textContent = m.content;
      if (m.used && m.used.length) {
        const u = document.createElement('div');
        u.className = 'used';
        const NAME = { list_accounts: 'ledgers', account_balance: 'balance', find_lines: 'lines', lookup_refs: 'Odoo names',
          propose_line: 'proposed a line — waits for your ✓', fill_line: 'filled the line — waits for your ✓', dev_request: 'queued at /dev' };
        u.textContent = m.used.map(x => (NAME[x.tool] || x.tool.replace(/_/g, ' ')) + (x.ok === false ? ' (refused)' : '')).join(' · ');
        d.append(u);
      }
      body.append(d);
    }
    if (busy) { const d = document.createElement('div'); d.className = 'm it'; d.textContent = 'looking…'; body.append(d); }
    body.scrollTop = body.scrollHeight;
  }

  async function send() {
    const ta = panel.querySelector('textarea');
    const text = ta.value.trim();
    if (!text || busy) return;
    ta.value = ''; msgs.push({ role: 'user', content: text }); busy = true; draw();
    try {
      // what is open on the page goes along (site: the chat and the day; accounts: the ledger in the hash) — set by the page as window.HubAskContext
      let context; try { context = typeof window.HubAskContext === 'function' ? window.HubAskContext() : undefined; } catch { context = undefined; }
      const r = await A.api('POST', '/api/assistant', { messages: msgs.map(m => ({ role: m.role, content: m.content })), page: location.pathname + (location.hash || ''), context });
      msgs.push({ role: 'assistant', content: r.answer || '—', used: r.used || [] });
    } catch (e) {
      msgs.push({ role: 'assistant', content: (e.data && e.data.error) || e.message || 'it did not answer', error: true });
    } finally { busy = false; draw(); panel.querySelector('textarea').focus(); }
  }

  function open(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    if (!on) { if (panel) { panel.remove(); panel = null; } return; }
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'ask';
    const devLink = A.me && A.me.admin && !A.me.viewAs ? '<a href="/dev" title="Dev requests — what needs code" style="color:inherit;opacity:.7;text-decoration:none;font-size:.78rem">🛠 dev</a>' : '';
    panel.innerHTML = `<div class="hd"><b>Ask</b><span class="sp"></span>${devLink}<button title="Start again">↻</button><button title="Close">✕</button></div>
      <div class="body"></div>
      <div class="ft"><textarea rows="1" placeholder="Ask about the ledgers…"></textarea><button>Send</button></div>`;
    document.body.append(panel);
    const [again, close] = panel.querySelectorAll('.hd button');
    again.onclick = () => { msgs = []; draw(); };
    close.onclick = () => open(false);
    panel.querySelector('.ft button').onclick = send;
    panel.querySelector('textarea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    draw();
    panel.querySelector('textarea').focus();
  }

  // the ✦ button: where Mario dragged it, and whether he switched it off from the menu (Mario 2026-10-07)
  const POS_KEY = 'askBtnPos', OFF_KEY = 'askBtnOff';
  function place(b, x, y) {
    const w = b.offsetWidth || 46, h = b.offsetHeight || 46;
    x = Math.max(4, Math.min(innerWidth - w - 4, x)); y = Math.max(4, Math.min(innerHeight - h - 4, y));
    b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.right = 'auto'; b.style.bottom = 'auto';
  }
  function askOff() { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } }
  window.HubAsk = {
    isOn: () => !askOff(),
    open: () => open(true),                      // the ☰ menu on /site opens the panel itself (Mario 2026-10-08)
    inMenu: /^\/site/.test(location.pathname),   // there the round button is not shown at all
    set(on) { try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, '1'); } catch {} const b = document.getElementById('ask-btn'); if (b) b.hidden = !on; if (!on && panel) open(false); },
    resetPlace() { try { localStorage.removeItem(POS_KEY); } catch {} location.reload(); },
  };
  function mount() {
    if (document.getElementById('ask-btn')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const b = document.createElement('button');
    b.id = 'ask-btn'; b.title = 'Ask the hub'; b.textContent = '✦';
    if (window.HubAsk.inMenu) b.hidden = true;
    // a chat page has its send button in that corner — ✦ sits above the message box there (Mario 2026-10-07: "ask ai overlaps send")
    if (/^\/site/.test(location.pathname)) b.style.bottom = (matchMedia('(max-width: 700px)').matches ? 92 : 96) + 'px';
    // moved by hand: press and drag it anywhere; the place is kept (Mario 2026-10-07: "allow to move the AI icon by hand")
    try { const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); if (pos) place(b, pos.x, pos.y); } catch {}
    let drag = null, moved = false;
    b.addEventListener('pointerdown', e => { const r = b.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY }; moved = false; try { b.setPointerCapture(e.pointerId); } catch {} });
    b.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      moved = true; place(b, e.clientX - drag.dx, e.clientY - drag.dy);
    });
    b.addEventListener('pointerup', () => {
      if (drag && moved) { const r = b.getBoundingClientRect(); try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top })); } catch {} }
      drag = null;
    });
    b.style.touchAction = 'none';
    b.onclick = e => { if (moved) { e.preventDefault(); moved = false; return; } open(!panel); };
    document.body.append(b);
    if (askOff()) b.hidden = true;
    let was = null; try { was = localStorage.getItem(KEY); } catch {}
    if (was === '1') open(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
