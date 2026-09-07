/* ── Phone preview: any hub page inside a real iPhone-sized frame ───────────
   Loaded by every page (hub, accounting, accounts, transfers, wise, budget,
   dashboard). The media queries inside an iframe follow the IFRAME's width,
   so 430px in here IS the phone rendering — same code path, same layout.
   Never mounts inside the preview itself (no phones in phones). */
(function () {
  if (window.top !== window.self) return;          // we are the preview
  if (window.__phonePreview) return;
  window.__phonePreview = true;
  // budget.html and todo.html ship their own preview (budget has a separate
  // ?mobile=1 build, todo hides its own buttons inside the frame) — don't double up
  if (window.openPhonePreview || window.openPhone) return;

  const DEVICES = [
    ['430x932', 'iPhone 15/16 Pro Max · 430×932'],
    ['393x852', 'iPhone 15/16 Pro · 393×852'],
    ['390x844', 'iPhone 14 · 390×844'],
    ['375x667', 'iPhone SE · 375×667'],
    ['820x1180', 'iPad Air · 820×1180'],
  ];
  let W = 430, H = 932;
  try { const s = localStorage.getItem('hub_phone_size'); if (s && /^\d+x\d+$/.test(s)) [W, H] = s.split('x').map(Number); } catch {}

  const css = document.createElement('style');
  css.textContent = `
    .pp-btn{position:fixed;right:14px;bottom:14px;z-index:900;width:38px;height:38px;border-radius:50%;
      border:1px solid rgba(0,0,0,.15);background:#fff;color:#333;font-size:17px;line-height:1;cursor:pointer;
      box-shadow:0 2px 10px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;opacity:.55;}
    .pp-btn:hover{opacity:1;}
    .pp-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:none;
      align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:16px;
      font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
    .pp-ov.on{display:flex;}
    .pp-bar{display:flex;gap:8px;align-items:center;color:#fff;flex-wrap:wrap;justify-content:center;}
    .pp-bar select,.pp-bar button{font:inherit;padding:5px 10px;border-radius:7px;border:1px solid #555;
      background:#2a2a33;color:#eee;cursor:pointer;}
    .pp-bar button:hover{background:#3a3a45;}
    .pp-fit{position:relative;}
    .pp-frame{background:#000;border-radius:44px;padding:11px;box-shadow:0 20px 60px rgba(0,0,0,.6);
      position:absolute;top:0;left:0;transform-origin:top left;}
    .pp-frame iframe{border:0;border-radius:34px;background:#fff;display:block;}
    .pp-hint{color:#aaa;font-size:11px;}`;
  document.head.appendChild(css);

  const ov = document.createElement('div');
  ov.className = 'pp-ov';
  ov.innerHTML = `
    <div class="pp-bar">
      <select id="pp-size">${DEVICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button id="pp-rot" title="Portrait / landscape">⟳ Rotate</button>
      <button id="pp-rel" title="Reload the preview">↻ Reload</button>
      <button id="pp-new" title="Open this page in a normal tab at phone width">↗ New tab</button>
      <button id="pp-close">✕ Close</button>
    </div>
    <div class="pp-fit" id="pp-fit"><div class="pp-frame" id="pp-frame"><iframe id="pp-iframe" title="Phone preview"></iframe></div></div>
    <div class="pp-hint">Shift+P opens and closes this · the frame is the live page, so anything you do in it is real</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  const btn = document.createElement('button');
  btn.className = 'pp-btn'; btn.title = 'Preview this page on a phone (Shift+P)'; btn.textContent = '📱';
  btn.onclick = open;

  function mount() {
    document.body.appendChild(ov);
    document.body.appendChild(btn);
    ov.querySelector('#pp-size').value = W + 'x' + H;
    ov.querySelector('#pp-size').onchange = e => { [W, H] = e.target.value.split('x').map(Number); save(); layout(); };
    ov.querySelector('#pp-rot').onclick = () => { [W, H] = [H, W]; layout(); };
    ov.querySelector('#pp-rel').onclick = () => { try { frame().contentWindow.location.reload(); } catch { frame().src = frame().src; } };
    ov.querySelector('#pp-new').onclick = () => window.open(location.href, '_blank', `width=${W},height=${H}`);
    ov.querySelector('#pp-close').onclick = close;
  }
  const frame = () => ov.querySelector('#pp-iframe');
  function save() { try { localStorage.setItem('hub_phone_size', W + 'x' + H); } catch {} }

  function layout() {
    const f = frame(), box = ov.querySelector('#pp-frame'), fit = ov.querySelector('#pp-fit');
    f.style.width = W + 'px'; f.style.height = H + 'px';
    const scale = Math.min(1, (window.innerHeight - 120) / (H + 22), (window.innerWidth - 40) / (W + 22));
    box.style.transform = `scale(${scale})`;
    fit.style.width = (W + 22) * scale + 'px';
    fit.style.height = (H + 22) * scale + 'px';
  }
  function open() {
    ov.classList.add('on');
    const f = frame();
    if (!f.src || f.src === 'about:blank') f.src = location.href;
    layout();
  }
  function close() { ov.classList.remove('on'); }

  window.addEventListener('resize', () => { if (ov.classList.contains('on')) layout(); });
  window.addEventListener('keydown', e => {
    if (e.key === 'P' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
      e.preventDefault(); ov.classList.contains('on') ? close() : open();
    }
  });

  window.PhonePreview = { open, close };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
