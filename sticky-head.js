// Hub rule (Mario, 2026-10-16): on every hub table the header row stays at the top while you scroll down, until
// the end of the table. Works even inside an overflow-x:auto card (where CSS position:sticky cannot): a copy of
// the header is laid over the page, under the page's own sticky top bar, lined up with the table's columns and its
// sideways scroll. Clicks on the copy go to the real header (sorting keeps working).
// Every hub .html loads this file; verify-hub.mjs flags a page that does not. Opt out: <table data-no-sticky>.
(function () {
  if (window.__stickyHead) return; window.__stickyHead = true;
  const MIN_ROWS = 4;
  const clones = new Map();
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c; } return getComputedStyle(document.body).backgroundColor || '#111'; };
  // the bottom of whatever is pinned at the top of the window (the page header, the hub bar…)
  function topOffset() {
    let off = 0;
    for (const el of document.querySelectorAll('body > *, header, nav, .topbar, .hub-bar')) {
      if (el.dataset && el.dataset.stickyClone !== undefined) continue;
      const cs = getComputedStyle(el); if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect(); if (r.height > 0 && r.top <= 1 && r.bottom > off && r.bottom < innerHeight / 2 && r.width > innerWidth / 2) off = r.bottom;
    }
    return off;
  }
  function hide(c) { if (c) c.wrap.style.display = 'none'; }
  function build(t) {
    const old = clones.get(t); if (old) old.wrap.remove();
    const wrap = document.createElement('div'); wrap.dataset.stickyClone = '';
    wrap.style.cssText = 'position:fixed;z-index:45;overflow:hidden;display:none;pointer-events:auto;box-shadow:0 2px 4px rgba(0,0,0,.25)';
    const tbl = t.cloneNode(false); tbl.removeAttribute('id'); tbl.style.margin = '0'; tbl.style.tableLayout = 'fixed'; tbl.style.position = 'relative';
    const head = t.tHead.cloneNode(true); head.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
    tbl.appendChild(head); wrap.appendChild(tbl); document.body.appendChild(wrap);
    // a click on the copy acts on the real header cell (sort, fold…)
    const src = [...t.tHead.querySelectorAll('th,td')], dst = [...head.querySelectorAll('th,td')];
    dst.forEach((d, i) => d.addEventListener('click', e => { e.preventDefault(); if (src[i]) src[i].click(); }));
    const c = { wrap, tbl, head, sig: t.tHead.innerHTML };
    clones.set(t, c); return c;
  }
  function update() {
    const top = topOffset();
    for (const [t, c] of clones) if (!t.isConnected) { c.wrap.remove(); clones.delete(t); }
    for (const t of document.querySelectorAll('table')) {
      if (t.dataset.noSticky !== undefined || t.closest('[data-sticky-clone]')) continue;
      const th = t.tHead, c0 = clones.get(t);
      if (!th || !th.rows.length || !th.rows[0].cells.length) { hide(c0); continue; }
      if (getComputedStyle(th.rows[0].cells[0]).position === 'sticky') { hide(c0); continue; }   // the page pins it itself
      const rows = [...t.tBodies].reduce((n, b) => n + b.rows.length, 0);
      const r = t.getBoundingClientRect(), hr = th.getBoundingClientRect();
      if (rows < MIN_ROWS || !t.offsetParent || hr.height === 0 || hr.top >= top || r.bottom - hr.height <= top) { hide(c0); continue; }
      let L = 0, R = innerWidth;
      for (let p = t.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) { const pr = p.getBoundingClientRect(); L = Math.max(L, pr.left); R = Math.min(R, pr.right); }
      }
      if (R - L < 40) { hide(c0); continue; }
      const c = c0 && c0.sig === th.innerHTML ? c0 : build(t);
      // slide up with the table's last row instead of covering the next block
      const y = Math.min(top, r.bottom - hr.height);
      Object.assign(c.wrap.style, { display: 'block', top: y + 'px', left: L + 'px', width: (R - L) + 'px', height: hr.height + 'px', background: bgOf(t) });
      c.tbl.style.width = r.width + 'px'; c.tbl.style.left = (r.left - L) + 'px';
      const sc = [...th.querySelectorAll('th,td')], dc = [...c.head.querySelectorAll('th,td')];
      sc.forEach((s, i) => { const d = dc[i]; if (!d) return; const w = s.getBoundingClientRect().width; d.style.boxSizing = 'border-box'; d.style.width = w + 'px'; d.style.minWidth = w + 'px'; d.style.maxWidth = w + 'px'; });
    }
  }
  let raf = 0; const kick = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
  addEventListener('scroll', kick, true); addEventListener('resize', kick);
  setInterval(update, 1000);   // tables drawn or redrawn after load
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update); else update();
})();
