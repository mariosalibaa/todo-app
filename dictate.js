(function () {
// Dictate — one button that turns a spoken (or typed) note into a form's fields.
// Mario, 2026-09-21: "adding the dictate idea everywhere on the hub". Server: POST /api/ai/fill (ai-fill.js).
//   Dictate({ api, host, schema: () => ({name, shape, intro, fields:[{key,hint}], context:{LABEL:[names]}}), onFilled(fields, transcript), hint, note })
// `api(method, path, body)` = the page's own authenticated call (Admin.api on hub pages, apiCall in todo.html).
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
window.Dictate = function (opts) {
  const host = typeof opts.host === 'string' ? document.getElementById(opts.host) : opts.host;
  if (!host) return null;
  if (!document.getElementById('dictate-css')) {
    const st = document.createElement('style'); st.id = 'dictate-css';
    st.textContent = `.dictate{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .dictate button{background:none;border:1px solid rgba(128,128,128,.4);color:inherit;opacity:.85;border-radius:999px;padding:6px 13px;font-size:.82rem;cursor:pointer;display:inline-flex;align-items:center;gap:7px;font-family:inherit;}
      .dictate button:hover{border-color:var(--amber,#F2A93B);color:var(--amber,#F2A93B);opacity:1;}
      .dictate button.rec{border-color:#f38ba8;color:#f38ba8;opacity:1;animation:dictate-pulse 1s infinite;}
      .dictate button.busy{opacity:.55;cursor:wait;}
      @keyframes dictate-pulse{50%{background:rgba(243,139,168,.15);}}
      .dictate .heard{flex-basis:100%;font-size:.8rem;opacity:.8;border:1px dashed rgba(128,128,128,.5);border-radius:8px;padding:7px 11px;line-height:1.45;display:none;}
      .dictate .heard.on{display:block;} .dictate .heard b{font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;opacity:.7;display:block;margin-bottom:2px;}
      .dictate .heard.err{border-color:#f38ba8;color:#f38ba8;}
      .dictate .notebox{flex-basis:100%;display:none;gap:6px;flex-direction:column;} .dictate .notebox.on{display:flex;}
      .dictate .notebox textarea{width:100%;min-height:60px;background:rgba(0,0,0,.2);border:1px solid rgba(128,128,128,.4);color:inherit;border-radius:8px;padding:8px 10px;font:inherit;font-size:.88rem;}
      .dictate .notebox .row{display:flex;justify-content:flex-end;}`;
    document.head.appendChild(st);
  }
  host.classList.add('dictate');
  host.innerHTML = `<button type="button" class="mic">🎤 <span>Dictate</span></button>${opts.note === false ? '' : '<button type="button" class="note">✎ From a note</button>'}${opts.hint ? `<span style="font-size:.76rem;opacity:.6;line-height:1.4">${esc(opts.hint)}</span>` : ''}
    <div class="notebox"><textarea placeholder="Paste or type the note — a WhatsApp message, an email line… — then Fill"></textarea><div class="row"><button type="button" class="fill">Fill the fields</button></div></div>
    <div class="heard"></div>`;
  const mic = host.querySelector('.mic'), lbl = mic.querySelector('span'), heard = host.querySelector('.heard'), nb = host.querySelector('.notebox');
  let rec = null, chunks = [], t0 = 0;
  const show = (kind, txt, err) => { heard.innerHTML = `<b>${kind}</b>${esc(txt)}`; heard.classList.toggle('err', !!err); heard.classList.add('on'); };
  async function send(payload, kind) {
    mic.classList.add('busy'); lbl.textContent = 'Reading…';
    try {
      const schema = typeof opts.schema === 'function' ? opts.schema() : opts.schema;
      const j = await opts.api('POST', '/api/ai/fill', { ...payload, schema });
      show(kind, j.transcript || '');
      const f = j.fields, n = Array.isArray(f) ? f.length : Object.values(f || {}).filter(v => v !== '' && v != null).length;
      if (!n) show(kind, (j.transcript || '') + ' — nothing usable in that, try again.', true);
      else opts.onFilled(f, j.transcript || '');
    } catch (e) { show('Failed', e.message, true); }
    mic.classList.remove('busy'); lbl.textContent = 'Dictate again';
  }
  mic.onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (mic.classList.contains('busy')) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';   // iPhone records mp4, Chrome webm
      rec = new MediaRecorder(stream, { mimeType: mime }); chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mime }); rec = null; mic.classList.remove('rec');
        if (Date.now() - t0 < 700) { lbl.textContent = 'Dictate'; return; }
        const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        await send({ audioBase64: b64, mime }, 'Heard');
      };
      rec.start(); t0 = Date.now(); mic.classList.add('rec'); lbl.textContent = 'Listening… tap to stop';
      setTimeout(() => { if (rec) rec.stop(); }, 120000);   // 2-minute ceiling
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) { rec = null; show('Microphone', e.message, true); }
  };
  const noteBtn = host.querySelector('.note');
  if (noteBtn) noteBtn.onclick = () => { nb.classList.toggle('on'); if (nb.classList.contains('on')) nb.querySelector('textarea').focus(); };
  host.querySelector('.fill').onclick = () => { const t = nb.querySelector('textarea').value.trim(); if (t) send({ text: t }, 'Note'); };
  return { start: () => mic.click(), stop: () => { if (rec) rec.stop(); }, reset: () => { if (rec) rec.stop(); heard.classList.remove('on'); nb.classList.remove('on'); nb.querySelector('textarea').value = ''; lbl.textContent = 'Dictate'; } };
};
})();
