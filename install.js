// Every hub page can be put on the home screen / desktop as its own app (Mario 2026-10-07: "add to home screen on
// Android from /site, with an Install button — allow it for every page in the hub"). server.js gives each page its own
// manifest (/app.webmanifest?p=<path>: start_url = that page, id = that page), so /site installs as "Shift WhatsApp",
// /accounting/accounts as its own icon, and so on. This file registers the service worker (Chrome needs it to offer the
// install) and shows a small "Install" pill when Chrome says the page can be installed. iPhone has no install prompt:
// Safari → Share → Add to Home Screen does the same there, using the same manifest.
(function () {
  if (window.__hubInstall) return; window.__hubInstall = true;
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const KEY = 'hubInstallHidden:' + location.pathname;
  let hidden = false; try { hidden = localStorage.getItem(KEY) === '1'; } catch {}
  let deferred = null;
  const inMenu = /^\/site/.test(location.pathname);   // the chat page keeps its corners free: Install sits in the ☰ menu (Mario 2026-10-08)
  window.HubInstall = { can: () => !!deferred, async prompt() { if (!deferred) return; const d = deferred; deferred = null; d.prompt(); try { await d.userChoice; } catch {} const b = document.getElementById('hub-install'); if (b) b.remove(); } };
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferred = e;
    if (inMenu || hidden || document.getElementById('hub-install')) return;
    const b = document.createElement('div'); b.id = 'hub-install';
    b.style.cssText = 'position:fixed;left:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:1460;display:flex;align-items:center;gap:2px;'
      + 'background:#1e1e2e;color:#fff;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25);font:600 13px system-ui,sans-serif;';
    b.innerHTML = '<button type="button" data-i="go" style="all:unset;cursor:pointer;padding:8px 6px 8px 14px">⬇ Install</button>'
      + '<button type="button" data-i="x" title="Hide" style="all:unset;cursor:pointer;padding:8px 12px 8px 6px;opacity:.6">✕</button>';
    b.addEventListener('click', async ev => {
      const t = ev.target.closest('[data-i]'); if (!t) return;
      if (t.dataset.i === 'x') { try { localStorage.setItem(KEY, '1'); } catch {} b.remove(); return; }
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch {}
      deferred = null; b.remove();
    });
    document.body.append(b);
  });
  window.addEventListener('appinstalled', () => { const b = document.getElementById('hub-install'); if (b) b.remove(); });
})();
