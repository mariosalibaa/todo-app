// The line behind a receipt, edited from anywhere: the Site chat tag, the Ajaltoun detail list (and any page that
// loads admin-shared.js). One sheet: description, amount + out/in, note, partner, company, project + division,
// extra expenses (each its own line — one Odoo bill per line), ✓ accept, ✓ book in Odoo, ↩ hold.
// Everything goes through the accounts API the grid itself uses; nothing new is written from here.
// Mario, 2026-09-23: "add note, additional expenses like transportation 25$, partner, company … book in odoo —
// same as account grid in hub". Usage: LineSheet.open(accountId, txId, { onChange })
(() => {
  const A = window.Admin;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const AJ_IDS = new Set([69, 59, 60, 61, 62, 63, 64]);
  const REFS = { partners: null, companies: null, analytic: null, sections: null, p: null };
  async function loadRefs() {
    if (REFS.p) return REFS.p;
    REFS.p = Promise.all([
      A.api('GET', '/api/accounting/partners').then(r => { REFS.partners = r.partners || []; REFS.companies = r.companies || []; }).catch(() => { REFS.partners = []; REFS.companies = []; }),
      A.api('GET', '/api/accounting/analytic').then(r => { REFS.analytic = Array.isArray(r) ? r : []; }).catch(() => { REFS.analytic = []; }),
      A.api('GET', '/api/ajaltoun/sections').then(r => { REFS.sections = Array.isArray(r) ? r : (r && r.sections) || []; }).catch(() => { REFS.sections = []; }),
    ]);
    return REFS.p;
  }
  const CSS = `
  #ls-overlay{position:fixed;inset:0;z-index:960;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;}
  @media(min-width:700px){#ls-overlay{align-items:center;}}
  .ls{width:min(580px,100%);max-height:90vh;overflow:auto;padding:14px 16px 16px;box-sizing:border-box;background:var(--mantle,#1e1e2e);color:var(--text,#cdd6f4);border-radius:16px 16px 0 0;font-size:.9rem;box-shadow:0 -4px 30px rgba(0,0,0,.3);}
  @media(min-width:700px){.ls{border-radius:16px;}}
  .ls label{display:block;font-size:.72rem;color:var(--sub,var(--muted,#a6adc8));margin-top:8px;} .ls input,.ls select{display:block;width:100%;margin-top:3px;padding:8px 10px;font:inherit;font-size:.9rem;background:var(--crust,var(--base,#181825));color:inherit;border:1px solid var(--surface0,#45475a);border-radius:8px;box-sizing:border-box;}
  .ls .ls-row{display:flex;gap:8px;align-items:flex-end;} .ls .ls-row label{flex:1;} .ls .ls-row>input{margin-top:6px;}
  .ls .ls-head{font-size:.92rem;margin-bottom:4px;} .ls .ls-state{display:block;font-size:.74rem;margin-top:2px;} .ls .ls-state.waiting{color:#e0a020;} .ls .ls-state.accepted{color:#3fb950;} .ls .ls-state.booked{color:#89b4fa;} .ls .ls-state.cancelled{color:#f38ba8;}
  .ls .ls-extra{margin-top:10px;padding:8px 10px;border:1px dashed var(--surface1,#585b70);border-radius:10px;} .ls .hint{font-size:.74rem;color:var(--sub,var(--muted,#a6adc8));} .ls .ls-extra .ls-row{margin-top:6px;} .ls .ls-extra button.x{background:none;border:0;color:#f38ba8;font-size:1rem;cursor:pointer;} .ls .ls-add{margin-top:8px;background:none;border:1px solid var(--surface1,#585b70);border-radius:8px;padding:6px 10px;font:inherit;font-size:.8rem;color:inherit;cursor:pointer;}
  .ls .ls-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;} .ls .ls-actions button{padding:9px 14px;border-radius:10px;border:0;font:inherit;font-size:.88rem;cursor:pointer;background:var(--surface1,#585b70);color:inherit;} .ls .ls-actions button.ok{background:#128c7e;color:#fff;} .ls .ls-actions button.warn{background:#fde2e4;color:#b3261e;} .ls .ls-actions button.ghost{background:transparent;color:var(--sub,var(--muted,#a6adc8));} .ls .ls-actions button:disabled{opacity:.5;}
  .ls .err{color:#f38ba8;font-size:.78rem;margin-top:6px;white-space:pre-wrap;} .ls .ls-bal{font-weight:400;color:var(--sub,var(--muted,#a6adc8));}
  .ls .ls-links{font-size:.76rem;margin-top:4px;} .ls .ls-links a{color:#89b4fa;}
  /* a real dropdown, not <datalist>: Safari on the iPhone shows nothing for a datalist (Mario, 2026-09-24) */
  .ls .combo{position:relative;display:block;} .ls .combo input{padding-right:30px;}
  .ls .combo .caret{position:absolute;right:2px;top:3px;bottom:0;width:28px;background:none;border:0;color:var(--sub,#a6adc8);font-size:.8rem;cursor:pointer;}
  .ls .combo .menu{position:absolute;left:0;right:0;top:100%;margin-top:2px;z-index:6;background:var(--crust,#181825);border:1px solid var(--surface0,#45475a);border-radius:8px;max-height:210px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.35);-webkit-overflow-scrolling:touch;}
  .ls .combo .menu div{padding:9px 10px;font-size:.88rem;cursor:pointer;border-bottom:1px solid var(--surface0,#45475a);} .ls .combo .menu div:last-child{border-bottom:0;}
  .ls .combo .menu div.on,.ls .combo .menu div:hover{background:var(--surface1,#585b70);} .ls .combo .menu .none{color:var(--sub,#a6adc8);cursor:default;}`;
  let S = null;   // { acc, txId, t, extra: [], onChange, bal }
  const g = id => document.getElementById(id);
  function close() { const o = g('ls-overlay'); if (o) o.remove(); S = null; }
  async function open(acc, txId, opts) {
    if (!g('ls-css')) { const st = document.createElement('style'); st.id = 'ls-css'; st.textContent = CSS; document.head.appendChild(st); }
    close();
    const o = document.createElement('div'); o.id = 'ls-overlay'; o.innerHTML = `<div class="ls"><div class="hint">Loading the line…</div></div>`;
    o.onclick = e => { if (e.target === o) close(); };
    document.body.appendChild(o);
    try {
      const [t] = await Promise.all([A.api('GET', `/api/accounting/accounts/${acc}/tx/${txId}`), loadRefs()]);
      S = { acc, txId, t, extra: [], onChange: (opts || {}).onChange || null, bal: null };
      draw();
      A.api('GET', `/api/accounting/accounts/${acc}/balance`).then(b => { if (S && S.acc === acc) { S.bal = b; const el = g('ls-bal'); if (el) el.textContent = ' · balance ' + b.balance.toFixed(2); } }).catch(() => {});
    } catch (e) { o.querySelector('.ls').innerHTML = `<div class="err">${esc(e.message)}</div><div class="ls-actions"><button class="ghost" onclick="LineSheet.close()">Close</button></div>`; }
  }
  // the clock time the paper carries: the WhatsApp/chat message's minute, else when the line was written
  const when = t => { const iso = t.waAt || t.createdAt; if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  const secName = id => { const x = (REFS.sections || []).find(s => s.id === id); return x ? x.name : (id || ''); };
  function draw() {
    const o = g('ls-overlay'); if (!o || !S) return;
    const t = S.t, amt = t.debit || t.credit || 0, side = t.debit ? 'debit' : 'credit';
    const isAj = AJ_IDS.has(+t.analyticId);
    const booked = !!t.bookedMove, accepted = !!t.waAccepted, odoo = t.src === 'odoo';
    const cancelled = !booked && !odoo && !!t.excluded && !t.review;
    const stateTxt = booked ? `in Odoo ✓✓ ${esc(t.bookedMove.name || '')}` : odoo ? 'an Odoo entry' : cancelled ? 'cancelled — off the ledger, kept on the paper' : accepted ? 'accepted ✓ — counts on the ledger, not in Odoo yet' : 'proposal — not counted until you accept it';
    const lock = booked || odoo;
    o.querySelector('.ls').innerHTML = `
    <div class="ls-head"><b>${esc(t.account ? t.account.name : S.acc)}</b> · ${esc(t.date)}${when(t) ? ' ' + esc(when(t)) : ''}<span class="ls-bal" id="ls-bal">${S.bal ? ' · balance ' + S.bal.balance.toFixed(2) : ''}</span><span class="ls-state ${booked ? 'booked' : cancelled ? 'cancelled' : accepted ? 'accepted' : 'waiting'}">${stateTxt}</span>
      <div class="ls-links"><a href="/accounting/accounts?id=${esc(S.acc)}" target="_blank" rel="noopener">open on the ledger ↗</a>${t.bookedMove && t.bookedMove.id ? ` · <a href="https://shift2.odoo.com/web#model=account.move&view_type=form&id=${+t.bookedMove.id}" target="_blank" rel="noopener">open in Odoo ↗</a>` : ''}</div></div>
    <label>Description<input id="ls-desc" value="${esc(t.description || '')}" ${lock ? 'disabled' : ''}></label>
    <div class="ls-row"><label>Amount<input id="ls-amt" type="number" step="0.01" inputmode="decimal" value="${amt}" ${lock ? 'disabled' : ''}></label>
      <label>Money<select id="ls-side" ${lock ? 'disabled' : ''}><option value="debit" ${side === 'debit' ? 'selected' : ''}>out (paid)</option><option value="credit" ${side === 'credit' ? 'selected' : ''}>in (received)</option></select></label></div>
    <label>Note<input id="ls-note" value="${esc(t.note || '')}" placeholder="what it was for"></label>
    <label>Partner (supplier)<input id="ls-partner" list="ls-partners" value="${esc(t.partnerName || '')}" placeholder="type to search Odoo partners" ${lock ? 'disabled' : ''}><datalist id="ls-partners">${(REFS.partners || []).slice(0, 3000).map(x => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
    <div class="ls-row"><label>Company<select id="ls-co" ${lock ? 'disabled' : ''}><option value="">—</option>${(REFS.companies || []).map(c => `<option value="${esc(c.name)}" ${t.company === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${t.company && !(REFS.companies || []).some(c => c.name === t.company) ? `<option selected>${esc(t.company)}</option>` : ''}</select></label>
      <label>Project<span class="combo"><input id="ls-proj" autocomplete="off" value="${esc(t.analyticName || '')}" placeholder="type or pick a project" ${lock ? 'disabled' : ''}>${lock ? '' : '<button type="button" class="caret" tabindex="-1">▾</button>'}<div class="menu" id="ls-proj-menu" hidden></div></span></label></div>
    <label id="ls-div-wrap" ${isAj ? '' : 'hidden'}>Division (Ajaltoun work section — type a new name to create one)<input id="ls-div" list="ls-divs" value="${esc(secName(t.section))}" placeholder="prefab, excavation, stone walls…"><datalist id="ls-divs">${(REFS.sections || []).map(x => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
    ${lock ? '' : `<div class="ls-extra"><div class="hint">Additional expenses on the same paper — each becomes its own line on this ledger (one Odoo bill per line)</div>
      ${S.extra.map((x, i) => `<div class="ls-row"><input placeholder="e.g. transport" value="${esc(x.description)}" oninput="LineSheet.S.extra[${i}].description=this.value"><input type="number" step="0.01" inputmode="decimal" placeholder="25" value="${x.amount || ''}" oninput="LineSheet.S.extra[${i}].amount=this.value" style="max-width:110px"><button class="x" onclick="LineSheet.S.extra.splice(${i},1);LineSheet.draw()">✕</button></div>`).join('')}
      <button class="ls-add" onclick="LineSheet.S.extra.push({description:'',amount:''});LineSheet.draw();setTimeout(()=>{const l=document.querySelectorAll('.ls-extra input');l[l.length-2]&&l[l.length-2].focus()},0)">+ add an expense</button></div>`}
    <div class="ls-actions">
      <button onclick="LineSheet.save()">Save</button>
      ${!accepted && !lock ? `<button class="ok" onclick="LineSheet.save('accept')">✓ Accept</button>` : ''}
      ${accepted && !lock ? `<button class="ok" onclick="LineSheet.save('book')">✓ Book in Odoo</button><button class="warn" onclick="LineSheet.hold()">↩ hold</button>` : ''}
      ${!lock && !cancelled ? `<button class="warn" onclick="LineSheet.cancelEntry()">✕ Cancel entry</button>` : ''}
      ${cancelled ? `<button onclick="LineSheet.restoreEntry()">↩ Put it back</button>` : ''}
      <button class="ghost" onclick="LineSheet.close()">Close</button></div>
    <div class="err" id="ls-err"></div>`;
    wireProjCombo();
  }
  // Project autocomplete: type to filter, tap to choose, ▾ shows them all. Plain divs, so it
  // works on the iPhone (a <datalist> does not) and the list is readable with one thumb.
  function wireProjCombo() {
    const inp = g('ls-proj'), menu = g('ls-proj-menu'); if (!inp || !menu || inp.disabled) return;
    const caret = menu.parentNode.querySelector('.caret');
    let hi = -1, shown = [];
    const all = () => (REFS.analytic || []);
    const hide = () => { menu.hidden = true; hi = -1; };
    function show(list) {
      shown = list.slice(0, 60);
      menu.innerHTML = shown.length
        ? shown.map((x, i) => `<div data-i="${i}" class="${i === hi ? 'on' : ''}">${esc(x.name)}</div>`).join('')
        : '<div class="none">no project matches</div>';
      menu.hidden = false;
      menu.querySelectorAll('div[data-i]').forEach(d => {
        d.onmousedown = e => e.preventDefault();                 // keep the focus, let the click land
        d.onclick = () => pick(shown[+d.dataset.i]);
      });
    }
    function filter() {
      const q = inp.value.trim().toLowerCase();
      show(!q ? all() : all().filter(x => x.name.toLowerCase().includes(q)));
    }
    function pick(x) { if (!x) return; inp.value = x.name; hide(); projChanged(); }
    inp.oninput = () => { filter(); projChanged(); };
    inp.onfocus = () => filter();
    inp.onblur = () => setTimeout(hide, 180);
    inp.onkeydown = e => {
      if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return filter();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        hi = Math.max(0, Math.min(shown.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
        show(shown); menu.children[hi] && menu.children[hi].scrollIntoView({ block: 'nearest' }); e.preventDefault();
      } else if (e.key === 'Enter') { if (!menu.hidden && hi >= 0) { pick(shown[hi]); e.preventDefault(); } }
      else if (e.key === 'Escape') hide();
    };
    if (caret) caret.onclick = () => { if (menu.hidden) { inp.focus(); filter(); } else hide(); };
  }
  function projChanged() {
    const name = g('ls-proj').value.trim();
    const a = (REFS.analytic || []).find(x => x.name.toLowerCase() === name.toLowerCase());
    g('ls-div-wrap').hidden = !(a && AJ_IDS.has(+a.id));
  }
  // a division typed by name → its id; an unknown name is created on the server (admin) and joins the list
  async function sectionId() {
    if (g('ls-div-wrap').hidden) return null;
    const name = g('ls-div').value.trim(); if (!name) return null;
    const hit = (REFS.sections || []).find(s => s.name.toLowerCase() === name.toLowerCase() || s.id === name.toLowerCase());
    if (hit) return hit.id;
    const r = await A.api('POST', '/api/ajaltoun/sections', { name });
    if (r && r.section) { REFS.sections.push(r.section); return r.section.id; }
    throw new Error('could not create the division "' + name + '"');
  }
  async function fields() {
    const partnerName = g('ls-partner').value.trim(), projName = g('ls-proj').value.trim();
    const partner = (REFS.partners || []).find(x => x.name.toLowerCase() === partnerName.toLowerCase());
    const proj = (REFS.analytic || []).find(x => x.name.toLowerCase() === projName.toLowerCase());
    const amt = Math.round((+g('ls-amt').value || 0) * 100) / 100, side = g('ls-side').value;
    return {
      description: g('ls-desc').value.trim(), note: g('ls-note').value.trim(),
      debit: side === 'debit' ? amt : 0, credit: side === 'credit' ? amt : 0,
      partnerId: partner ? partner.id : null, partnerName, partnerSrc: partnerName ? 'manual' : '',
      company: g('ls-co').value, companySrc: g('ls-co').value ? 'manual' : '',
      analyticId: proj ? proj.id : null, analyticName: projName, analyticSrc: projName ? 'manual' : '',
      section: await sectionId(),
    };
  }
  // book one line exactly the way the accounts grid does (its bookAny): a line that has a TYPE (expense, labour,
  // vendor, transfer) goes through book-row — the same entry ✓ accept makes; a line with no type but a partner and
  // a company is paid from this account's cash journal through the rules route. If the first refuses, the other is
  // tried, and both reasons are reported (Mario, 2026-09-24: "book in odoo not working").
  async function bookOne(txId, section) {
    const t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${txId}`);
    if (t.bookedMove) return t.bookedMove.name || '';
    const byRow = async () => { const r = await A.api('POST', `/api/accounting/accounts/${S.acc}/book-row`, { txId }); return r.move || ''; };
    const byPay = async () => {
      // an official SARL bill that was refused for a missing project must NOT slip out as a plain payment
      if (t.vat && (t.official || t.company === 'SHIFT GROUP SARL (USD)')) throw new Error('official bill — fix what the message above says, it books in the SARL');
      if (!t.partnerId) throw new Error('the partner is not one of Odoo\'s — pick it from the list');
      if (!t.company) throw new Error('the company is missing');
      const r = await A.api('POST', `/api/accounting/accounts/${S.acc}/book`, { ids: [txId], post: true });
      const one = (r.results || [])[0] || {}; if (one.error) throw new Error(one.error);
      A.api('POST', `/api/accounting/accounts/${S.acc}/odoo-check`, { ids: [txId] }).catch(() => {});
      return one.move || '';
    };
    // a worker's ledger (his workbook, or his Odoo partner) books its rows as bills from him; any other wallet pays
    // the supplier from its own cash journal — the way the grid's Pay does
    const worker = !!(t.account && (t.account.odooPartner || t.account.excel));
    const first = worker ? byRow : byPay, second = worker ? byPay : byRow;
    let move = '', why = '';
    try { move = await first(); }
    catch (e) { why = e.message; try { move = await second(); } catch (e2) { throw new Error(why + (e2.message && e2.message !== why ? ' · and: ' + e2.message : '')); } }
    if (section && move) A.api('POST', '/api/ajaltoun/section', { lineId: 'move:' + String(move).replace(/\//g, '-'), section }).catch(() => {});
    return move;
  }
  async function save(action) {
    const err = g('ls-err'); err.textContent = '';
    const btns = [...document.querySelectorAll('.ls-actions button')]; btns.forEach(b => b.disabled = true);
    try {
      const t = S.t, lock = !!t.bookedMove || t.src === 'odoo';
      const f = await fields();
      // 1. the hub first: the line itself …
      if (!lock) {
        if (!f.debit && !f.credit) throw new Error('an amount is needed');
        const patch = { ...f };
        if (action === 'accept' || action === 'book') Object.assign(patch, { waAccepted: true, excluded: false, review: false, dupOf: null });
        await A.api('PATCH', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`, patch);
      } else await A.api('PATCH', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`, { note: f.note, section: f.section });
      // … then the extra expenses as their own lines: same day, partner, company, project, division; money out; accepted
      const made = [];
      for (const x of S.extra) {
        const a = Math.round((+x.amount || 0) * 100) / 100; if (!a || !String(x.description || '').trim()) continue;
        const r = await A.api('POST', `/api/accounting/accounts/${S.acc}/tx`, { date: t.date, description: String(x.description).trim() + ' · ' + (f.description || t.description || '').slice(0, 60), debit: a, credit: 0,
          note: 'with ' + (f.description || t.description || '').slice(0, 80), partnerId: f.partnerId, partnerName: f.partnerName, company: f.company, analyticId: f.analyticId, analyticName: f.analyticName,
          section: f.section, nature: t.nature && t.nature !== 'note' ? t.nature : 'expense', waAccepted: true,
          // it belongs to the same paper: same minute, same chat message, and it points back at the line it came with
          fromTxId: S.txId, postId: t.postId || null, waAt: t.waAt || null, waFrom: t.waFrom || null });
        made.push(r.id);
      }
      S.extra = [];
      // 2. then Odoo: the line, and each extra line after it
      if (action === 'book') {
        await bookOne(S.txId, f.section);
        const fails = [];
        for (const id of made) { try { await bookOne(id, f.section); } catch (e) { fails.push(e.message); } }
        if (fails.length) throw new Error('Booked the line; the extra line(s) stay on the hub: ' + fails.join(' · '));
      }
      S.t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`);
      if (S.onChange) { try { await S.onChange(); } catch {} }
      draw();
      const note = [made.length ? `${made.length} expense${made.length > 1 ? 's' : ''} added to the ledger` : '', action === 'book' ? 'booked in Odoo' : action === 'accept' ? 'accepted' : 'saved'].filter(Boolean).join(' · ');
      const ok = g('ls-err'); if (ok) { ok.style.color = '#3fb950'; ok.textContent = note; }
      if (action === 'book') setTimeout(close, 900);
    } catch (e) {
      err.style.color = ''; err.textContent = e.message; btns.forEach(b => b.disabled = false);
      try { S.t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`); if (S.onChange) await S.onChange(); } catch {}
    }
  }
  // Cancel an entry (Mario, 2026-09-24): the line leaves the ledger and the balance but the paper,
  // the photo and the chat message stay — nothing is deleted, and "put it back" undoes it.
  // A line already in Odoo cannot be cancelled here: that entry is deleted in Odoo.
  async function cancelEntry() {
    if (!S) return;
    if (S.t.bookedMove) { g('ls-err').textContent = 'this one is already in Odoo — delete it there first'; return; }
    if (!confirm('Cancel this entry? It comes off the ledger and out of the balance. The photo stays.')) return;
    try {
      await A.api('PATCH', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`, { excluded: true, review: false, waAccepted: false });
      S.t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`);
      if (S.onChange) { try { await S.onChange(); } catch {} }
      draw(); const ok = g('ls-err'); if (ok) { ok.style.color = '#3fb950'; ok.textContent = 'cancelled — off the ledger'; }
    } catch (e) { g('ls-err').textContent = e.message; }
  }
  async function restoreEntry() {
    if (!S) return;
    try {
      await A.api('PATCH', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`, { review: true });
      S.t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`);
      if (S.onChange) { try { await S.onChange(); } catch {} }
      draw(); const ok = g('ls-err'); if (ok) { ok.style.color = '#3fb950'; ok.textContent = 'back as a proposal — waiting for your ✓'; }
    } catch (e) { g('ls-err').textContent = e.message; }
  }
  async function hold() {
    try { await A.api('PATCH', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`, { waAccepted: false }); S.t = await A.api('GET', `/api/accounting/accounts/${S.acc}/tx/${S.txId}`); if (S.onChange) await S.onChange(); draw(); }
    catch (e) { g('ls-err').textContent = e.message; }
  }
  window.LineSheet = { open, close, draw, save, hold, cancelEntry, restoreEntry, projChanged, get S() { return S; } };
})();
