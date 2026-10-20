// Hover read-out for every hub graph (Mario 2026-10-20: "show me data when I put the mouse on the graph, timing and
// temperature — make a rule everywhere in the hub"). A chart marks its <svg class="g-hover"> with data-pts = JSON of
// [[x, y, label], …] in viewBox units (x sorted) and data-vb = "W H"; this script adds a crosshair + a tooltip with the
// label of the nearest point, on mouse and on touch. Call GraphHover.attachAll() after (re)drawing.
(function () {
  let tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;background:#181825;color:#cdd6f4;border:1px solid #45475a;border-radius:8px;padding:6px 9px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);white-space:nowrap';
    document.body.appendChild(tip);
    return tip;
  }
  function attach(svg) {
    let pts = [];
    try { pts = JSON.parse(svg.dataset.pts || '[]'); } catch (e) { pts = []; }
    const [W, H] = (svg.dataset.vb || '640 220').split(' ').map(Number);
    const ns = 'http://www.w3.org/2000/svg';
    // a redrawn svg (innerHTML replaced) keeps its listeners: only refresh the points and put the marker back
    if (svg.__hover) { svg.__hover.pts = pts; if (!svg.contains(svg.__hover.g)) svg.appendChild(svg.__hover.g); return; }
    if (!pts.length) return;
    const g = document.createElementNS(ns, 'g'); g.setAttribute('class', 'g-hover-mark'); g.style.display = 'none';
    const line = document.createElementNS(ns, 'line'); line.setAttribute('y1', 0); line.setAttribute('y2', H); line.setAttribute('stroke', '#a6adc8'); line.setAttribute('stroke-dasharray', '3 3'); line.setAttribute('stroke-width', '1');
    const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('r', 4.5); dot.setAttribute('fill', '#F2A93B'); dot.setAttribute('stroke', '#1e1e2e'); dot.setAttribute('stroke-width', '1.5');
    g.appendChild(line); g.appendChild(dot); svg.appendChild(g);
    const st = svg.__hover = { pts, g };
    const move = ev => {
      const pts = st.pts; if (!pts.length) return;
      const r = svg.getBoundingClientRect(), cx = (ev.touches ? ev.touches[0].clientX : ev.clientX), cy = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      const vx = (cx - r.left) / r.width * W;
      let lo = 0, hi = pts.length - 1;   // nearest by x (pts sorted)
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] < vx) lo = m; else hi = m; }
      const p = Math.abs(pts[lo][0] - vx) <= Math.abs(pts[hi][0] - vx) ? pts[lo] : pts[hi];
      line.setAttribute('x1', p[0]); line.setAttribute('x2', p[0]); dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]);
      g.style.display = '';
      const t = ensureTip(); t.innerHTML = p[2]; t.style.display = 'block';
      const tw = t.offsetWidth, th = t.offsetHeight;
      let left = cx + 14, top = cy - th - 10;
      if (left + tw > window.innerWidth - 8) left = cx - tw - 14;
      if (top < 8) top = cy + 14;
      t.style.left = left + 'px'; t.style.top = top + 'px';
      if (ev.touches) ev.preventDefault();
    };
    const leave = () => { g.style.display = 'none'; if (tip) tip.style.display = 'none'; };
    svg.addEventListener('mousemove', move); svg.addEventListener('mouseleave', leave);
    svg.addEventListener('touchstart', move, { passive: false }); svg.addEventListener('touchmove', move, { passive: false }); svg.addEventListener('touchend', leave);
  }
  window.GraphHover = { attachAll: root => (root || document).querySelectorAll('svg.g-hover').forEach(attach), attach };
})();
