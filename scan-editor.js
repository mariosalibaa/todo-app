// Scan editor (Mario, 2026-09-24) — the photo the Shift WhatsApp camera takes is
// never sent raw any more: it opens here first, the way a scanner app works.
//   1. CROP   — the paper is found automatically (bright blob → its four corners),
//               the four handles are draggable, ↺/↻ rotate, "Auto" re-detects,
//               "Full" gives up and takes the whole frame.
//   2. FINISH — the quad is warped flat (projective, bilinear) and the look is chosen:
//               Colour / Grey / B&W, Enhance on-off (shadow removal + white balance),
//               and the output size (Small 1200 / Medium 1600 / Large 2200 px).
// Everything is plain canvas — no OpenCV, nothing to download on a phone line.
// Returns a Promise: the JPEG Blob, or null when Mario cancels.
window.ScanEditor = (function () {
  const LS = 'scanEditor.prefs';
  const SIZES = { s: 1200, m: 1600, l: 2200 };
  const prefs = Object.assign({ mode: 'color', enhance: true, size: 'm', auto: true }, readPrefs());
  function readPrefs() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
  function savePrefs() { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch {} }

  const CSS = `
  .scanx{position:fixed;inset:0;z-index:1200;background:#101215;color:#e7e9ea;display:flex;flex-direction:column;
    font:inherit;-webkit-user-select:none;user-select:none;touch-action:none;}
  .scanx .top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;padding-top:calc(10px + env(safe-area-inset-top));font-size:.9rem;}
  .scanx .top b{font-weight:600;font-size:.95rem;}
  .scanx .top button{background:none;border:0;color:#e7e9ea;font:inherit;font-size:.95rem;padding:6px 8px;cursor:pointer;}
  .scanx .top button.go{color:#25d366;font-weight:700;}
  .scanx .stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:6px;}
  .scanx .stage canvas{position:absolute;max-width:100%;max-height:100%;}
  .scanx .bar{padding:8px 10px calc(10px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;background:#16181c;}
  .scanx .seg{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
  .scanx .seg button{flex:1;min-width:64px;background:#23262b;border:0;border-radius:10px;color:#cfd3d8;font:inherit;font-size:.82rem;padding:9px 6px;cursor:pointer;}
  .scanx .seg button.on{background:#25d366;color:#0b1a10;font-weight:700;}
  .scanx .seg button.ic{flex:0 0 auto;min-width:46px;font-size:1rem;}
  .scanx .lbl{font-size:.68rem;color:#8b9298;text-align:center;letter-spacing:.04em;text-transform:uppercase;}
  .scanx .busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(16,18,21,.6);font-size:.9rem;}
  `;

  function open(file) {
    return new Promise(async resolve => {
      if (!document.getElementById('scanx-css')) {
        const st = document.createElement('style'); st.id = 'scanx-css'; st.textContent = CSS; document.head.appendChild(st);
      }
      let src;                                        // working ImageData-bearing canvas (rotations applied)
      try { src = await loadCanvas(file, 2600); } catch { return resolve(file); }

      const root = document.createElement('div'); root.className = 'scanx';
      root.innerHTML = `
        <div class="top"><button id="sxCancel">Cancel</button><b id="sxTitle">Crop</b><button class="go" id="sxNext">Next ›</button></div>
        <div class="stage" id="sxStage"><canvas id="sxView"></canvas><canvas id="sxOver"></canvas></div>
        <div class="bar" id="sxBar"></div>`;
      document.body.appendChild(root);
      const stage = root.querySelector('#sxStage'), view = root.querySelector('#sxView'), over = root.querySelector('#sxOver');
      let quad = detect(src), step = 1, warped = null, fit = null;

      // ── stage 1: the crop ──────────────────────────────────────────────
      function layout() {
        const box = stage.getBoundingClientRect();
        const s = Math.min((box.width - 12) / src.width, (box.height - 12) / src.height);
        fit = { s, w: Math.round(src.width * s), h: Math.round(src.height * s) };
        [view, over].forEach(c => { c.width = fit.w; c.height = fit.h; c.style.width = fit.w + 'px'; c.style.height = fit.h + 'px'; });
        view.getContext('2d').drawImage(src, 0, 0, fit.w, fit.h);
        drawQuad();
      }
      function drawQuad() {
        const g = over.getContext('2d'); g.clearRect(0, 0, over.width, over.height);
        const p = quad.map(([x, y]) => [x * fit.s, y * fit.s]);
        g.save();
        g.beginPath(); g.rect(0, 0, over.width, over.height);
        g.moveTo(p[0][0], p[0][1]); for (let i = 3; i >= 1; i--) g.lineTo(p[i][0], p[i][1]); g.closePath();
        g.fillStyle = 'rgba(16,18,21,.55)'; g.fill('evenodd'); g.restore();
        g.beginPath(); g.moveTo(p[0][0], p[0][1]); p.slice(1).forEach(q => g.lineTo(q[0], q[1])); g.closePath();
        g.strokeStyle = '#25d366'; g.lineWidth = 2; g.stroke();
        p.forEach(q => { g.beginPath(); g.arc(q[0], q[1], 11, 0, 7); g.fillStyle = 'rgba(37,211,102,.25)'; g.fill(); g.strokeStyle = '#25d366'; g.lineWidth = 2.5; g.stroke(); });
      }
      let drag = -1;
      over.addEventListener('pointerdown', e => {
        const r = over.getBoundingClientRect(), x = (e.clientX - r.left) / fit.s, y = (e.clientY - r.top) / fit.s;
        let best = -1, bd = 40 / fit.s;
        quad.forEach(([qx, qy], i) => { const d = Math.hypot(qx - x, qy - y); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { drag = best; over.setPointerCapture(e.pointerId); }
      });
      over.addEventListener('pointermove', e => {
        if (drag < 0) return;
        const r = over.getBoundingClientRect();
        quad[drag] = [clamp((e.clientX - r.left) / fit.s, 0, src.width), clamp((e.clientY - r.top) / fit.s, 0, src.height)];
        drawQuad();
      });
      ['pointerup', 'pointercancel'].forEach(t => over.addEventListener(t, () => { drag = -1; }));

      // ── stage 2: the look ──────────────────────────────────────────────
      function preview() {
        const busy = document.createElement('div'); busy.className = 'busy'; busy.textContent = 'Working…'; stage.appendChild(busy);
        setTimeout(() => {
          const box = stage.getBoundingClientRect();
          const out = outSize(quad, 900);
          const img = process(warp(src, quad, out.w, out.h), prefs.mode, prefs.enhance);
          const s = Math.min((box.width - 12) / out.w, (box.height - 12) / out.h, 1);
          view.width = out.w; view.height = out.h;
          view.style.width = Math.round(out.w * s) + 'px'; view.style.height = Math.round(out.h * s) + 'px';
          view.getContext('2d').putImageData(img, 0, 0);
          over.width = over.height = 0; over.style.width = over.style.height = '0px';
          busy.remove();
        }, 10);
      }
      function bar() {
        const b = root.querySelector('#sxBar');
        b.innerHTML = step === 1 ? `
          <div class="lbl">Crop</div>
          <div class="seg">
            <button class="ic" data-act="rotl" title="Rotate left">↺</button>
            <button data-act="auto">Auto detect</button>
            <button data-act="full">Whole photo</button>
            <button class="ic" data-act="rotr" title="Rotate right">↻</button>
          </div>` : `
          <div class="lbl">Colour</div>
          <div class="seg">
            <button data-g="mode" data-v="color" class="${prefs.mode === 'color' ? 'on' : ''}">Colour</button>
            <button data-g="mode" data-v="gray" class="${prefs.mode === 'gray' ? 'on' : ''}">Grey</button>
            <button data-g="mode" data-v="bw" class="${prefs.mode === 'bw' ? 'on' : ''}">B &amp; W</button>
            <button data-g="mode" data-v="raw" class="${prefs.mode === 'raw' ? 'on' : ''}">Original</button>
          </div>
          <div class="lbl">Clean-up &amp; size</div>
          <div class="seg">
            <button data-act="enh" class="${prefs.enhance ? 'on' : ''}">✨ Enhance</button>
            <button data-g="size" data-v="s" class="${prefs.size === 's' ? 'on' : ''}">Small</button>
            <button data-g="size" data-v="m" class="${prefs.size === 'm' ? 'on' : ''}">Medium</button>
            <button data-g="size" data-v="l" class="${prefs.size === 'l' ? 'on' : ''}">Large</button>
          </div>`;
        b.querySelectorAll('button').forEach(btn => btn.onclick = () => {
          const act = btn.dataset.act, g = btn.dataset.g;
          if (act === 'rotl' || act === 'rotr') { src = rotate(src, act === 'rotr'); quad = prefs.auto ? detect(src) : fullQuad(src); layout(); return; }
          if (act === 'auto') { prefs.auto = true; savePrefs(); quad = detect(src); drawQuad(); return; }
          if (act === 'full') { prefs.auto = false; savePrefs(); quad = fullQuad(src); drawQuad(); return; }
          if (act === 'enh') { prefs.enhance = !prefs.enhance; savePrefs(); bar(); preview(); return; }
          if (g === 'mode') { prefs.mode = btn.dataset.v; savePrefs(); bar(); preview(); return; }
          if (g === 'size') { prefs.size = btn.dataset.v; savePrefs(); bar(); return; }
        });
      }

      function close(val) { window.removeEventListener('resize', onResize); root.remove(); resolve(val); }
      const onResize = () => { if (step === 1) layout(); else preview(); };
      window.addEventListener('resize', onResize);
      root.querySelector('#sxCancel').onclick = () => { if (step === 2) { step = 1; root.querySelector('#sxTitle').textContent = 'Crop'; root.querySelector('#sxNext').textContent = 'Next ›'; root.querySelector('#sxCancel').textContent = 'Cancel'; bar(); layout(); } else close(null); };
      root.querySelector('#sxNext').onclick = async () => {
        if (step === 1) {
          step = 2; root.querySelector('#sxTitle').textContent = 'Scan';
          root.querySelector('#sxNext').textContent = 'Send ✓'; root.querySelector('#sxCancel').textContent = '‹ Back';
          bar(); preview(); return;
        }
        const busy = document.createElement('div'); busy.className = 'busy'; busy.textContent = 'Preparing…'; stage.appendChild(busy);
        await new Promise(r => setTimeout(r, 10));
        const out = outSize(quad, SIZES[prefs.size] || 1600);
        const img = process(warp(src, quad, out.w, out.h), prefs.mode, prefs.enhance);
        const c = document.createElement('canvas'); c.width = out.w; c.height = out.h;
        c.getContext('2d').putImageData(img, 0, 0);
        const q = prefs.mode === 'bw' ? 0.9 : 0.85;
        c.toBlob(blob => close(blob || null), 'image/jpeg', q);
      };

      if (!prefs.auto) quad = fullQuad(src);
      bar(); layout();
    });
  }

  // ── image loading ────────────────────────────────────────────────────────
  function loadCanvas(file, max) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src); res(c);
      };
      img.onerror = rej; img.src = URL.createObjectURL(file);
    });
  }
  function rotate(cv, cw) {
    const c = document.createElement('canvas'); c.width = cv.height; c.height = cv.width;
    const g = c.getContext('2d');
    if (cw) { g.translate(c.width, 0); g.rotate(Math.PI / 2); } else { g.translate(0, c.height); g.rotate(-Math.PI / 2); }
    g.drawImage(cv, 0, 0); return c;
  }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const fullQuad = cv => [[0, 0], [cv.width, 0], [cv.width, cv.height], [0, cv.height]];

  // ── paper detection: Otsu on a thumbnail, biggest bright blob, its 4 extremes ──
  function detect(cv) {
    const W = 320, H = Math.max(1, Math.round(cv.height * W / cv.width));
    const t = document.createElement('canvas'); t.width = W; t.height = H;
    t.getContext('2d').drawImage(cv, 0, 0, W, H);
    const d = t.getContext('2d').getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) { const v = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0; g[i] = v; hist[v]++; }
    const th = otsu(hist, g.length);
    // biggest 4-connected bright component
    const lab = new Int32Array(W * H).fill(-1), stack = new Int32Array(W * H);
    let best = null;
    for (let s = 0; s < g.length; s++) {
      if (lab[s] !== -1 || g[s] < th) continue;
      let sp = 0, n = 0; stack[sp++] = s; lab[s] = s;
      const px = [];
      while (sp) {
        const i = stack[--sp]; n++; px.push(i);
        const x = i % W, y = (i / W) | 0;
        if (x > 0 && lab[i - 1] === -1 && g[i - 1] >= th) { lab[i - 1] = s; stack[sp++] = i - 1; }
        if (x < W - 1 && lab[i + 1] === -1 && g[i + 1] >= th) { lab[i + 1] = s; stack[sp++] = i + 1; }
        if (y > 0 && lab[i - W] === -1 && g[i - W] >= th) { lab[i - W] = s; stack[sp++] = i - W; }
        if (y < H - 1 && lab[i + W] === -1 && g[i + W] >= th) { lab[i + W] = s; stack[sp++] = i + W; }
      }
      if (!best || n > best.n) best = { n, px };
    }
    if (!best || best.n < g.length * 0.12) return fullQuad(cv);      // nothing paper-like → whole frame
    let tl = null, tr = null, br = null, bl = null, a = 1e9, b = -1e9, c = -1e9, e = 1e9;
    for (const i of best.px) {
      const x = i % W, y = (i / W) | 0;
      if (x + y < a) { a = x + y; tl = [x, y]; }
      if (x + y > b) { b = x + y; br = [x, y]; }
      if (x - y > c) { c = x - y; tr = [x, y]; }
      if (x - y < e) { e = x - y; bl = [x, y]; }
    }
    const k = cv.width / W, q = [tl, tr, br, bl].map(([x, y]) => [clamp(x * k, 0, cv.width), clamp(y * k, 0, cv.height)]);
    // a degenerate or tiny quad is worse than no crop at all
    const side = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
    if (Math.min(side(q[0], q[1]), side(q[1], q[2]), side(q[2], q[3]), side(q[3], q[0])) < Math.min(cv.width, cv.height) * 0.2) return fullQuad(cv);
    return q;
  }
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = i; }
    }
    return th;
  }

  // ── projective warp of the quad onto a flat page (Heckbert's unit-square map) ──
  function outSize(quad, max) {
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const w = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2, h = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(8, Math.round(w * s)), h: Math.max(8, Math.round(h * s)) };
  }
  function warp(cv, quad, outW, outH) {
    const sw = cv.width, sh = cv.height;
    const sd = cv.getContext('2d').getImageData(0, 0, sw, sh).data;
    const [x0, y0] = quad[0], [x1, y1] = quad[1], [x2, y2] = quad[2], [x3, y3] = quad[3];
    const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
    let a, b, c, dd, e, f, g, h;
    const det = dx1 * dy2 - dx2 * dy1;
    if ((sx === 0 && sy === 0) || det === 0) {
      g = h = 0; a = x1 - x0; b = x3 - x0; c = x0; dd = y1 - y0; e = y3 - y0; f = y0;
    } else {
      g = (sx * dy2 - dx2 * sy) / det; h = (dx1 * sy - sx * dy1) / det;
      a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
      dd = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    const out = new ImageData(outW, outH), od = out.data;
    for (let j = 0, o = 0; j < outH; j++) {
      const v = (j + 0.5) / outH;
      for (let i = 0; i < outW; i++, o += 4) {
        const u = (i + 0.5) / outW, w = g * u + h * v + 1;
        let X = (a * u + b * v + c) / w, Y = (dd * u + e * v + f) / w;
        X = clamp(X, 0, sw - 1.001); Y = clamp(Y, 0, sh - 1.001);
        const xi = X | 0, yi = Y | 0, fx = X - xi, fy = Y - yi;
        const p00 = (yi * sw + xi) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        od[o] = sd[p00] * w00 + sd[p10] * w10 + sd[p01] * w01 + sd[p11] * w11;
        od[o + 1] = sd[p00 + 1] * w00 + sd[p10 + 1] * w10 + sd[p01 + 1] * w01 + sd[p11 + 1] * w11;
        od[o + 2] = sd[p00 + 2] * w00 + sd[p10 + 2] * w10 + sd[p01 + 2] * w01 + sd[p11 + 2] * w11;
        od[o + 3] = 255;
      }
    }
    return out;
  }

  // ── the scanner look ─────────────────────────────────────────────────────
  // Enhance = divide the picture by its own blurred self (that kills the shadow of the
  // hand and the table light), then stretch what is left. B&W thresholds on top of it.
  function process(img, mode, enhance) {
    const d = img.data, W = img.width, H = img.height, N = W * H;
    const lum = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) lum[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
    let bg = null;
    if (enhance || mode === 'bw') bg = background(lum, W, H);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const L = lum[i] || 1;
      let nl = L;
      if (bg) nl = clamp(L / Math.max(bg[i], 1) * 235, 0, 255);
      if (enhance) nl = clamp((nl - 18) * 255 / (225 - 18), 0, 255);       // black point / white point
      if (mode === 'bw') { const v = nl < 190 ? 0 : 255; d[p] = d[p + 1] = d[p + 2] = v; continue; }
      if (mode === 'gray') { d[p] = d[p + 1] = d[p + 2] = nl; continue; }
      if (mode === 'raw') continue;
      const k = nl / L;                                                     // colour: keep the hue, lift the paper
      d[p] = clamp(sat(d[p], L) * k, 0, 255);
      d[p + 1] = clamp(sat(d[p + 1], L) * k, 0, 255);
      d[p + 2] = clamp(sat(d[p + 2], L) * k, 0, 255);
    }
    return img;
  }
  const sat = (c, L) => L + (c - L) * 1.12;
  // background = the picture blurred hard, computed on a small copy and read back bilinearly
  function background(lum, W, H) {
    const w = Math.max(8, Math.round(W / 24)), h = Math.max(8, Math.round(H / 24));
    const small = new Float32Array(w * h), cnt = new Float32Array(w * h);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(h - 1, (y * h / H) | 0);
      for (let x = 0; x < W; x++) { const k = sy * w + Math.min(w - 1, (x * w / W) | 0); small[k] += lum[y * W + x]; cnt[k]++; }
    }
    for (let i = 0; i < small.length; i++) small[i] /= (cnt[i] || 1);
    const blur = boxMax(boxBlur(small, w, h, 2), w, h, 2);                  // blur, then dilate: text must not darken the paper
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = clamp(y * h / H - 0.5, 0, h - 1), y0 = fy | 0, y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = clamp(x * w / W - 0.5, 0, w - 1), x0 = fx | 0, x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
        out[y * W + x] = (blur[y0 * w + x0] * (1 - tx) + blur[y0 * w + x1] * tx) * (1 - ty)
                       + (blur[y1 * w + x0] * (1 - tx) + blur[y1 * w + x1] * tx) * ty;
      }
    }
    return out;
  }
  function boxBlur(a, w, h, r) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const yy = y + j, xx = x + i; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += a[yy * w + xx]; n++;
      }
      o[y * w + x] = s / n;
    }
    return o;
  }
  function boxMax(a, w, h, r) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const yy = y + j, xx = x + i; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        if (a[yy * w + xx] > m) m = a[yy * w + xx];
      }
      o[y * w + x] = m;
    }
    return o;
  }

  return { open, _detect: detect, _warp: warp, _process: process, _outSize: outSize, prefs };
})();
