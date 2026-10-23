// Light or dark background, chosen per page (Mario, 2026-10-17: "allow to choose each page in the hub, white or black
// background"). Every hub page loads this in <head> (server.js withViewer), so the choice applies before the first paint.
// The ☀ / ☾ button bottom-left flips the page; the choice is kept per page path in this browser.
(function () {
  if (window.__hubTheme) return; window.__hubTheme = true;
  const KEY = 'hub.theme:' + (location.pathname.replace(/\/+$/, '') || '/');
  const root = document.documentElement;
  let saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  // the two palettes, written over the page's own colour variables (most pages share the same names)
  const css = `
:root[data-theme="light"]{--base:#f3f4f6;--mantle:#ffffff;--crust:#eceef2;--surface0:#e2e5ea;--surface1:#cbd0d8;--surface2:#b4bac5;--text:#1f2330;--sub:#4b5161;--subtext0:#4b5161;--overlay0:#767c8c;--overlay1:#666c7c;
  --amber:#b8730a;--green:#2f8a2a;--red:#c8263f;--blue:#1e5fd8;--orange:#d9580a;--peach:#d9580a;--yellow:#a77412;--mauve:#7c3aed;
  --bg:#f3f4f6;--panel:#ffffff;--panel2:#eef0f3;--line:#e2e5ea;--ink:#1f2330;--muted:#767c8c;--card:#ffffff;--paper:#f3f4f6;--bar:#eef0f3;color-scheme:light;}
:root[data-theme="light"] body{background:var(--base);color:var(--text);}
:root[data-theme="dark"]{--base:#1e1e2e;--mantle:#181825;--crust:#11111b;--surface0:#313244;--surface1:#45475a;--surface2:#585b70;--text:#cdd6f4;--sub:#a6adc8;--subtext0:#a6adc8;--overlay0:#6c7086;--overlay1:#7f849c;
  --amber:#F2A93B;--green:#a6e3a1;--red:#f38ba8;--blue:#89b4fa;--orange:#fab387;--peach:#fab387;--yellow:#f9e2af;--mauve:#cba6f7;
  --bg:#1e1e2e;--panel:#181825;--panel2:#313244;--line:#313244;--ink:#cdd6f4;--muted:#6c7086;--card:#181825;--paper:#1e1e2e;--bar:#181825;--me:#2b3d2b;color-scheme:dark;}
:root[data-theme="dark"] body{background:var(--base);color:var(--text);}
.hub-theme-btn{position:fixed;left:14px;bottom:62px;z-index:60;width:34px;height:34px;border-radius:50%;border:1px solid var(--surface1,#888);background:var(--mantle,#222);color:var(--text,#eee);font-size:16px;line-height:1;cursor:pointer;opacity:.75;box-shadow:0 2px 6px rgba(0,0,0,.25);}
.hub-theme-btn:hover{opacity:1;}
.hub-logo-btn{bottom:104px;font-size:14px;}
:root[data-logo="right"] .wordmark{margin-left:auto;text-align:right;}
@media print{.hub-theme-btn{display:none;}}`;
  const st = document.createElement('style'); st.id = 'hub-theme-css'; st.textContent = css;
  (document.head || root).appendChild(st);
  const lum = c => { const m = String(c).match(/\d+(\.\d+)?/g); if (!m) return 1; const [r, g, b] = m.map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  function isLight() { return root.dataset.theme ? root.dataset.theme === 'light' : lum(getComputedStyle(document.body).backgroundColor) > 0.5; }
  function paint(btn) { const l = isLight(); btn.textContent = l ? '☾' : '☀'; btn.title = l ? 'dark background for this page' : 'white background for this page'; }
  function mount() {
    if (document.querySelector('.hub-theme-btn')) return;
    const btn = document.createElement('button'); btn.className = 'hub-theme-btn'; btn.type = 'button';
    btn.onclick = () => { const next = isLight() ? 'dark' : 'light'; root.dataset.theme = next; try { localStorage.setItem(KEY, next); } catch (e) {} paint(btn); };
    document.body.appendChild(btn); paint(btn);
    // Logo side, one choice for the whole hub (Mario, 2026-10-23: "make it option on hub to move logo to right").
    // The wordmark is moved to the end of its header; a marker keeps its old place so ⇄ can put it back.
    const LKEY = 'hub.logoSide';
    const mark = document.querySelector('header .wordmark') || document.querySelector('.wordmark');
    if (!mark) return;
    const home = document.createComment('wordmark'); mark.before(home);
    const bar = mark.closest('header') || mark.parentElement;
    function place(side) {
      if (side === 'right') { root.dataset.logo = 'right'; bar.appendChild(mark); }
      else { delete root.dataset.logo; home.after(mark); }
    }
    let side = null; try { side = localStorage.getItem(LKEY); } catch (e) {}
    place(side);
    const lb = document.createElement('button'); lb.className = 'hub-theme-btn hub-logo-btn'; lb.type = 'button'; lb.textContent = '⇄';
    const tip = () => { lb.title = root.dataset.logo === 'right' ? 'logo on the left' : 'logo on the right'; };
    lb.onclick = () => { const next = root.dataset.logo === 'right' ? 'left' : 'right'; place(next); try { localStorage.setItem(LKEY, next); } catch (e) {} tip(); };
    tip(); document.body.appendChild(lb);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
