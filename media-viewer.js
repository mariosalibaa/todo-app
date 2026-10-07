// Hub rule (Mario, 2026-10-07): every photo / paper on the hub opens IN THE SAME PAGE — never a new Chrome tab. The hub
// runs as an installed Chrome app, where a new tab is a dead end. This file is injected into every page by server.js,
// so old pages and new ones follow the rule without doing anything.
//
//   - a click on a link that holds an <img>, or whose href is a picture / PDF / file endpoint, opens the overlay
//     instead of navigating (Odoo record links, external sites and pages are left alone)
//   - ‹ › / arrow keys / swipe walk through the other files on the page, Esc / ✕ / phone back closes, tap = zoom,
//     ⬇ downloads
//   - from code: HubViewer.open(url, { name, kind: 'image'|'pdf', list: [{url, name}] })
//   - opt out on one link: data-no-viewer, or a link with its own onclick handler (it has a viewer of its own)
(function () {
  if (window.HubViewer) return;
  const IMG = /\.(jpe?g|png|gif|webp|heic|bmp|svg)(\?|#|$)/i, PDF = /\.pdf(\?|#|$)/i;
  const FILEISH = /\/(file|files|media|image|thumb|attachment|odoo-file|content)(\/|\?|$)|\/web\/(content|image)\b|\/api\/[^?#]*\/(file|files|media|odoo-file|photo|scan|doc)s?\b/i;
  const isFileHref = h => !!h && !/^(mailto|tel|javascript):/i.test(h) && !/\/web#|\/odoo\/(?!.*\/web\/content)/i.test(h) && (IMG.test(h) || PDF.test(h) || FILEISH.test(h));
  const kindOf = (url, name, a) => PDF.test(name || '') || PDF.test(url) || (a && /pdf|📄/i.test(a.textContent || '')) ? 'pdf' : 'image';

  const css = `#hubmv{position:fixed;inset:0;z-index:2147483000;background:rgba(10,12,14,.95);display:none;flex-direction:column}
#hubmv.on{display:flex}
#hubmv .b{display:flex;align-items:center;gap:10px;padding:8px 12px;color:#e9edef;font:13px system-ui,sans-serif}
#hubmv .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
#hubmv .b button,#hubmv .b a{background:rgba(255,255,255,.12);color:#e9edef;border:0;border-radius:8px;padding:6px 12px;font-size:14px;cursor:pointer;text-decoration:none}
#hubmv .s{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;position:relative}
#hubmv .s img{max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in}
#hubmv .s img.full{max-width:none;max-height:none;cursor:zoom-out}
#hubmv .s iframe{width:100%;height:100%;border:0;background:#fff}
#hubmv .n{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:0;background:rgba(255,255,255,.15);color:#fff;font-size:28px;cursor:pointer;z-index:1}
#hubmv .n.p{left:12px}#hubmv .n.x{right:12px}#hubmv .n[hidden]{display:none}`;
  let box = null, list = [], at = 0;

  function build() {
    if (box) return box;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    box = document.createElement('div'); box.id = 'hubmv';
    box.innerHTML = '<div class="b"><button type="button" data-a="c">‹ Back</button><span class="t"></span><a data-a="d" download title="Download">⬇</a><button type="button" data-a="c" title="Close (Esc)">✕</button></div>'
      + '<div class="s"><button class="n p" type="button" data-a="p">‹</button><button class="n x" type="button" data-a="n">›</button></div>';
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (!a) { if (e.target.classList.contains('s')) close(); return; }
      if (a.dataset.a === 'c') { e.preventDefault(); close(); } else if (a.dataset.a === 'p') show(at - 1); else if (a.dataset.a === 'n') show(at + 1);
    });
    let x0 = null;
    box.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60 && !box.querySelector('img.full')) show(at + (dx < 0 ? 1 : -1)); });
    document.body.append(box);
    return box;
  }
  function clear() { box.querySelectorAll('.s img,.s iframe').forEach(x => x.remove()); }
  function show(i) {
    if (i < 0 || i >= list.length) return;
    at = i; const f = list[i], s = box.querySelector('.s'); clear();
    const asFrame = () => { const fr = document.createElement('iframe'); fr.src = f.url; s.prepend(fr); };
    if ((f.kind || kindOf(f.url, f.name)) === 'pdf') asFrame();
    else { const im = document.createElement('img'); im.src = f.url; im.onclick = () => im.classList.toggle('full'); im.onerror = () => { im.remove(); asFrame(); }; s.prepend(im); }
    box.querySelector('.t').textContent = (f.name || decodeURIComponent((f.url.split('?')[0].split('/').pop()) || 'file')) + (list.length > 1 ? `  ·  ${i + 1} / ${list.length}` : '');
    box.querySelector('[data-a=d]').href = f.url;
    box.querySelector('.p').hidden = i === 0; box.querySelector('.x').hidden = i === list.length - 1;
  }
  function open(url, opts = {}) {
    build();
    list = (opts.list && opts.list.length ? opts.list : [{ url, name: opts.name, kind: opts.kind }]).map(f => ({ ...f, url: new URL(f.url, location.href).href }));
    const abs = new URL(url, location.href).href;
    at = Math.max(0, list.findIndex(f => f.url === abs));
    if (!box.classList.contains('on')) { box.classList.add('on'); try { history.pushState({ hubmv: 1 }, ''); } catch {} }
    show(at);
  }
  function close() {
    if (!box || !box.classList.contains('on')) return;
    box.classList.remove('on'); clear();
    if (history.state && history.state.hubmv) history.back();
  }
  window.addEventListener('popstate', () => { if (box && box.classList.contains('on')) { box.classList.remove('on'); clear(); } });
  document.addEventListener('keydown', e => {
    if (!box || !box.classList.contains('on')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowLeft') show(at - 1); else if (e.key === 'ArrowRight') show(at + 1);
  }, true);

  // the links on the page that the viewer takes over
  const takes = a => a && a.href && !a.hasAttribute('data-no-viewer') && !a.hasAttribute('onclick') && !a.hasAttribute('download') && !a.closest('#hubmv')
    && (a.querySelector('img') ? isFileHref(a.getAttribute('href') || '') || IMG.test(a.href) || /\/api\//.test(a.href) : isFileHref(a.getAttribute('href') || ''));
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!takes(a)) return;
    e.preventDefault(); e.stopPropagation();
    const all = [...document.querySelectorAll('a[href]')].filter(x => takes(x) && x.offsetParent !== null);
    const seen = new Set(), files = [];
    for (const x of all) { const u = x.href; if (seen.has(u)) continue; seen.add(u); files.push({ url: u, name: x.getAttribute('title') || (x.textContent || '').trim().slice(0, 80) || '', kind: kindOf(u, x.textContent, x) }); }
    open(a.href, { list: files.length ? files : [{ url: a.href }] });
  }, true);

  window.HubViewer = { open, close };
})();
