/* Shared sign-in for the admin hub pages (hub.html, accounting.html).
   Same Firebase project and the same localStorage session key as todo.html,
   so one Google sign-in on this origin opens every app the account is allowed.
   Access itself is decided by the server (/api/me → apps[]); this file only
   shows the right screen for the answer it gets. */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyCRw6jemaSb8XvSUPfSTYamaeU3SNj0DBg",
    authDomain: "todo-app-f5c0d.firebaseapp.com",
    projectId: "todo-app-f5c0d",
    storageBucket: "todo-app-f5c0d.firebasestorage.app",
    messagingSenderId: "913223477512",
    appId: "1:913223477512:web:cdcfc6d54a927c4dc6a4bd"
  };
  firebase.initializeApp(firebaseConfig);
  const fbAuth = firebase.auth();
  fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

  const A = window.Admin = { user: null, me: null, session: null, disabled: false, app: null };
  // the service worker on every hub page (installable + web push); todo.html registered it alone before
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Web push (2026-09-23): status() → 'on' | 'off' | 'blocked' | 'unsupported'; enable() asks the browser and
  // stores the subscription on the server; disable() removes it. Used by the bell on the hub page.
  const b64ToBytes = b64 => { const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); };
  A.push = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:',
    async status() {
      if (!A.push.supported()) return 'unsupported';
      if (Notification.permission === 'denied') return 'blocked';
      const reg = await navigator.serviceWorker.getRegistration('/'); if (!reg) return 'off';
      return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    },
    async enable() {
      if (!A.push.supported()) throw new Error('this browser cannot receive notifications');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('notifications were not allowed');
      const reg = await navigator.serviceWorker.ready;
      const { key } = await A.api('GET', '/api/push/key');
      if (!key) throw new Error('push is not set up on the server');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await A.api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), ua: navigator.userAgent });
      return sub;
    },
    async disable() {
      const reg = await navigator.serviceWorker.getRegistration('/'); if (!reg) return;
      const sub = await reg.pushManager.getSubscription(); if (!sub) return;
      await A.api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    },
    test: () => A.api('POST', '/api/push/test'),
  };
  let idToken = null, ready = false;
  try { A.session = localStorage.getItem('todo_session'); } catch {}
  // The session also rides as a cookie, because an <img>, an <iframe> or a "Full size" tab
  // cannot send the Authorization header: the server takes the cookie on GET requests only
  // (photos and papers in the viewer — Mario, 2026-09-09: "photos are not opening").
  const cookie = tok => { try { document.cookie = 'todo_session=' + encodeURIComponent(tok || '') + '; path=/; samesite=lax' + (tok ? '; max-age=31536000' : '; max-age=0') + (location.protocol === 'https:' ? '; secure' : ''); } catch {} };
  if (A.session) cookie(A.session);

  const style = document.createElement('style');
  style.textContent = `
    #admin-login{position:fixed;inset:0;background:#1e1e2e;display:none;align-items:center;justify-content:center;z-index:1000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#cdd6f4;}
    .admin-login-card{background:#181825;border:1px solid #313244;border-radius:14px;padding:36px 32px;max-width:380px;width:90%;text-align:center;}
    .admin-login-card p{font-size:.95rem;line-height:1.45;margin:14px 0 20px;}
    .admin-login-card button{background:#F2A93B;color:#1e1e2e;border:0;border-radius:8px;padding:10px 22px;font-size:.95rem;font-weight:600;cursor:pointer;}
    .admin-login-sub{margin-top:14px;font-size:.72rem;color:#6c7086;}
    .admin-login-sub a{color:#89b4fa;}
    .admin-wordmark{font-family:"Century Gothic",CenturyGothic,AppleGothic,system-ui,sans-serif;letter-spacing:.18em;font-size:1.15rem;color:#cdd6f4;}
    .admin-wordmark span{color:#F2A93B;}
    .admin-alt{margin-top:16px;font-size:.82rem;color:#a6adc8;} .admin-alt a{color:#89b4fa;cursor:pointer;}
    .admin-inapp{margin-top:14px;font-size:.84rem;line-height:1.45;color:#f9e2af;background:#2a2433;border:1px solid #45475a;border-radius:10px;padding:10px 12px;} .admin-inapp.small{color:#a6adc8;background:transparent;border:0;padding:0;font-size:.76rem;} .admin-out{display:inline-block;margin-top:6px;color:#89b4fa;font-weight:600;text-decoration:none;}
    .admin-phone{display:flex;flex-direction:column;gap:10px;margin-top:8px;} .admin-phone input{font:inherit;font-size:1.05rem;padding:10px 12px;border-radius:8px;border:1px solid #45475a;background:#1e1e2e;color:#cdd6f4;text-align:center;letter-spacing:.04em;}
    .admin-phone .err{color:#f38ba8;font-size:.8rem;min-height:1em;}`;
  document.head.appendChild(style);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function overlay(html) {
    let el = document.getElementById('admin-login');
    if (!el) { el = document.createElement('div'); el.id = 'admin-login'; document.body.appendChild(el); }
    el.innerHTML = html;
    el.style.display = html ? 'flex' : 'none';
  }
  // Google refuses to sign in inside another app's browser (Telegram, Instagram, Facebook, Gmail links…):
  // the popup never comes back, or Google answers "this browser may not be secure". The card says so and
  // offers the one-tap way out to the real browser (Mario, 2026-09-23: "opening the hub from Telegram fails").
  const UA = navigator.userAgent || '';
  const inApp = /Telegram|FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|GSA\/|; wv\)|WebView/i.test(UA) || (/iPhone|iPad|iPod/.test(UA) && !/Safari\//.test(UA)) || (/Android/.test(UA) && /Version\/\d/.test(UA));
  const isIOS = /iPhone|iPad|iPod/.test(UA), isAndroid = /Android/.test(UA);
  const here = location.href.replace(/^https?:\/\//, '');
  const openOut = isIOS ? `<a class="admin-out" href="x-safari-https://${here}">Open in Safari ↗</a>` : isAndroid ? `<a class="admin-out" href="intent://${here}#Intent;scheme=https;package=com.android.chrome;end">Open in Chrome ↗</a>` : '';
  const inAppNote = inApp
    ? `<div class="admin-inapp"><b>You are inside another app's browser.</b> Google does not sign in from here. ${openOut || 'Open this address in Safari or Chrome.'}</div>`
    : (isIOS || isAndroid) && openOut ? `<div class="admin-inapp small">If the Google window does not come back (Telegram, Instagram…): ${openOut}</div>` : '';
  const card = (msg, btn, sub) => `<div class="admin-login-card"><div class="admin-wordmark">SHIFT <span>GROUP</span></div>
    <p>${msg}</p>${btn ? '<button onclick="Admin.signIn()">Sign in with Google</button>' + inAppNote + '<div class="admin-alt">No Google account? <a onclick="Admin.phoneUI()">Sign in with your phone number</a></div>' : ''}<div class="admin-login-sub">${sub || ''}</div></div>`;

  // ── SMS sign-in (Mario, 2026-09-14): for a worker without a Google account ──────────────────
  // Firebase phone auth: number → SMS code → same session as a Google account; the allowlist
  // holds the number in E.164 form (+96170123456) where an email would be.
  let confirmRes = null, captcha = null;
  A.phoneUI = function (step, err) {
    const body = step === 'code'
      ? `<p>Type the 6-digit code we sent by SMS to <b>${esc(A.phoneNo)}</b></p><div class="admin-phone"><input id="ph-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"><div class="err">${esc(err || '')}</div><button onclick="Admin.phoneCode()">Sign in</button></div><div class="admin-alt"><a onclick="Admin.phoneUI()">← other number</a></div>`
      : `<p>Your phone number — we send a code by SMS</p><div class="admin-phone"><input id="ph-no" type="tel" inputmode="tel" placeholder="+961 70 123 456" value="${esc(A.phoneNo || '+961 ')}"><div class="err">${esc(err || '')}</div><button onclick="Admin.phoneSend()">Send the code</button></div><div id="ph-captcha"></div><div class="admin-alt"><a onclick="Admin.signIn()">← Sign in with Google instead</a></div>`;
    overlay(`<div class="admin-login-card"><div class="admin-wordmark">SHIFT <span>GROUP</span></div>${body}</div>`);
    const inp = document.getElementById(step === 'code' ? 'ph-code' : 'ph-no'); if (inp) { inp.focus(); inp.onkeydown = e => { if (e.key === 'Enter') (step === 'code' ? A.phoneCode : A.phoneSend)(); }; }
  };
  A.phoneSend = async function () {
    const raw = (document.getElementById('ph-no') || {}).value || '';
    const no = '+' + raw.replace(/\D/g, '');
    if (!/^\+\d{8,15}$/.test(no)) return A.phoneUI('', 'Write the number with the country code, e.g. +961 70 123 456');
    A.phoneNo = no;
    try {
      if (captcha) { try { captcha.clear(); } catch {} captcha = null; }
      captcha = new firebase.auth.RecaptchaVerifier('ph-captcha', { size: 'invisible' });
      confirmRes = await fbAuth.signInWithPhoneNumber(no, captcha);
      A.phoneUI('code');
    } catch (e) { A.phoneUI('', e.code === 'auth/too-many-requests' ? 'Too many tries — wait a while.' : e.code === 'auth/invalid-phone-number' ? 'This number is not valid.' : (e.message || 'Could not send the SMS')); }
  };
  A.phoneCode = async function () {
    const code = ((document.getElementById('ph-code') || {}).value || '').replace(/\D/g, '');
    if (code.length !== 6 || !confirmRes) return A.phoneUI('code', 'The code has 6 digits');
    try { overlay(card('Checking…')); const r = await confirmRes.confirm(code); A.user = r.user; idToken = await r.user.getIdToken(); }   // onAuthStateChanged takes it from here
    catch (e) { A.phoneUI('code', e.code === 'auth/invalid-verification-code' ? 'Wrong code — try again' : e.code === 'auth/code-expired' ? 'The code expired — ask for a new one' : (e.message || 'Could not sign in')); }
  };

  const bearer = () => idToken || A.session || '';
  A.api = async function (method, path, body) {
    if (A.user) idToken = await A.user.getIdToken();
    const r = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + bearer() },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) {
      let data; try { data = await r.json(); } catch { data = { error: r.statusText }; }
      const err = new Error(data.error || ('HTTP ' + r.status)); err.status = r.status; err.data = data; throw err;
    }
    return r.status === 204 ? null : r.json();
  };

  async function mint() {
    const r = await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + idToken } });
    if (!r.ok) return;
    const s = await r.json();
    A.session = s.token;
    cookie(s.token);
    try {
      localStorage.setItem('todo_session', s.token);
      localStorage.setItem('todo_session_user', JSON.stringify({ email: s.email, name: s.name }));
    } catch {}
  }
  function drop() {
    A.session = null;
    cookie('');
    try { localStorage.removeItem('todo_session'); localStorage.removeItem('todo_session_user'); } catch {}
  }

  // true = the request was answered (allowed, no-app, or not-approved screen shown)
  async function tryMe(onReady, pre) {
    try {
      const me = pre ? await pre : await A.api('GET', '/api/me');
      if (me instanceof Error) throw me;
      A.me = me;
      const need = Array.isArray(A.app) ? A.app : A.app ? [A.app] : [];
      if (need.length && !need.some(k => (me.apps || []).includes(k))) {
        overlay(card(`${esc(me.email)} is signed in but has no access to <b>${esc(need.join(' / '))}</b> yet. Ask Mario to enable it.`, false,
          '<a href="/admin">← Back to the hub</a> &nbsp;·&nbsp; <a href="#" onclick="Admin.signOut();return false;">Sign out</a>'));
        return true;
      }
      if (!ready) { ready = true; overlay(''); onReady(me); }
      return true;
    } catch (e) {
      if (e.status === 403) {
        overlay(card(`${esc((e.data && e.data.email) || 'This account')} is not approved yet. Ask Mario to add you, then reload.`, true,
          'Or try a different account'));
        return true;
      }
      if (e.status === 401) drop();
      return false;
    }
  }

  // Gate a page: app = 'todo' | 'accounting' | null (hub: any approved account)
  A.require = function (app, onReady) {
    A.app = app;
    (async () => {
      // with a session already stored, ask who it is at the same time as the config —
      // one round trip instead of two before the page can start loading its own data
      const pre = A.session ? A.api('GET', '/api/me').catch(e => e) : null;
      const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
      if (cfg.authDisabled) {   // local machine: no sign-in, everything open
        A.disabled = true;
        A.me = { email: 'local@shift', name: 'Mario', apps: ['todo', 'accounting', 'partners', 'ajaltoun', 'daily', 'site', 'reports', 'excavation', 'crm'], admin: true, local: true };
        ready = true; overlay(''); onReady(A.me); return;
      }
      overlay(card('Checking session…'));
      if (A.session && await tryMe(onReady, pre)) return;
      fbAuth.onAuthStateChanged(async user => {
        if (!user) { if (!ready) overlay(card('Sign in with your Google account to continue', true)); return; }
        A.user = user; idToken = await user.getIdToken();
        if (!(A.session && await tryMe(onReady))) { await mint(); await tryMe(onReady); }
      });
    })();
  };

  // Popup sign-in; extra OAuth scopes (e.g. contacts) return a Google access token
  A.signIn = async function (scopes) {
    const p = new firebase.auth.GoogleAuthProvider();
    (scopes || []).forEach(s => p.addScope(s));
    // no forced re-consent: once the contact scopes are granted, the popup just closes
    let r;
    try { r = await fbAuth.signInWithPopup(p); }
    catch (e) {
      // an in-app browser blocks the popup: try the redirect flow before giving up (the page comes back through getRedirectResult)
      if (/popup-blocked|operation-not-supported|cancelled-popup|popup-closed/.test(String(e.code || '')) && !scopes) { await fbAuth.signInWithRedirect(p); return new Promise(() => {}); }
      throw e;
    }
    A.user = r.user; idToken = await r.user.getIdToken();
    return { user: r.user, accessToken: r.credential && r.credential.accessToken };
  };

  A.signOut = async function () {
    if (A.session) fetch('/api/session', { method: 'DELETE', headers: { Authorization: 'Bearer ' + A.session } }).catch(() => {});
    drop();
    await fbAuth.signOut().catch(() => {});
    location.href = '/admin';
  };

  A.esc = esc;

  // The Odoo company names are long and the columns are narrow, so the screen says what Mario says:
  // SHIFT GROUP SARL (USD) → S SARL (2026-09-25). Only the label — the stored value stays the Odoo name.
  const CO_SHORT = {
    'SHIFT GROUP SARL (USD)': 'S SARL',
    'SHIFT GROUP SARL': 'S SARL',
    'SHIFT GROUP SARL (LBP)': 'S SARL LBP',
    'SHIFT DEVELOPMENT': 'S DEV',
    'SHIFT GROUP OFFSHORE SAL': 'S OFFSHORE',
  };
  A.coShort = n => CO_SHORT[String(n == null ? '' : n).trim()] || n || '';

  // Dictate (a spoken/typed note → a form's fields) lives in /dictate.js so todo.html, which has its own
  // Firebase + apiCall, can use it too; this is the shortcut for the pages signed in through here.
  A.dictate = function (opts) { return window.Dictate ? window.Dictate({ api: A.api, ...opts }) : null; };

  // Breadcrumb for every hub page — Mario, 2026-09-12: "I should be able to understand where I am sitting inside the
  // software": ‹ Back goes one step up, and the full path Hub › Accounting › Accounts › Ziad cash is clickable at
  // every level. path = [[label, href], ..., [current label]] (the hub home is added in front).
  // Renders into #crumbs (or the element passed). Colors inherit from the bar it sits in.
  A.crumbs = function (path, el) {
    el = el || document.getElementById('crumbs'); if (!el) return;
    if (!document.getElementById('crumbs-css')) {
      const st = document.createElement('style'); st.id = 'crumbs-css';
      st.textContent = `.crumbs{display:flex;align-items:center;gap:6px;white-space:nowrap;min-width:0;}
        .crumbs .hback{color:var(--amber,#F2A93B);text-decoration:none;font-size:.86rem;font-weight:600;padding:5px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;opacity:1;margin-right:6px;}
        .crumbs .hback:hover{background:rgba(128,128,128,.15);}
        .crumbs a{color:inherit;text-decoration:none;opacity:.7;font-size:.9rem;} .crumbs a:hover{opacity:1;text-decoration:underline;}
        .crumbs .sep{opacity:.45;font-size:.85rem;} .crumbs .cur{font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;}
        @media (max-width:640px){.crumbs a:not(.hback):not(:nth-last-child(3)){display:none;} .crumbs .sep:not(:nth-last-child(2)){display:none;}}`;
      document.head.appendChild(st);
    }
    const full = [['Hub', '/admin?stay'], ...path];
    // Back = the nearest crumb that is another page; a crumb pointing at this same page (a tab, '#accounts') would
    // only change the hash and go nowhere (Mario, 2026-09-13: Back not working on mobile)
    const here = location.pathname.replace(/\/$/, '');
    const back = [...full.slice(0, -1)].reverse().find(c => (c[1] || '').split(/[?#]/)[0].replace(/\/$/, '') !== here) || full[0];
    el.className = 'crumbs';
    el.innerHTML = `<a class="hback" href="${esc(back[1])}" title="Back to ${esc(back[0])}">&lsaquo; Back</a>` +
      full.map((c, i) => (i ? '<span class="sep">›</span>' : '') + (i < full.length - 1 ? `<a href="${esc(c[1])}" title="${esc(c[0])}">${i === 0 ? '⌂ ' : ''}${esc(c[0])}</a>` : `<span class="cur">${esc(c[0])}</span>`)).join('');
  };

  // ── Phone layout for every hub page (Mario, 2026-09-13) ──────────────────────────────────────────────
  // Under 700px: the page's tab bar (nav.tabs) and the user line (#who) fold into a ☰ button at the top
  // right; Back + the path take their own row under the wordmark; every explanation (.lead, .note, small
  // muted footnotes) collapses to two lines with a "more" toggle. Nothing changes on a laptop.
  // ── Installed app (home-screen icon) has no browser chrome, so no reload (Mario, 2026-09-14) ──
  // Standalone mode only: a small ↻ button at the bottom left, and pull-down at the top of the page reloads.
  A.refreshUI = function () {
    if (!matchMedia('(display-mode: standalone)').matches && !navigator.standalone) return;
    if (document.getElementById('pwa-refresh')) return;
    const st = document.createElement('style');
    st.textContent = `#pwa-refresh{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:900;width:42px;height:42px;border-radius:50%;border:1px solid var(--surface1,#45475a);background:var(--mantle,#181825);color:var(--sub,#a6adc8);font-size:1.3rem;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;}
      /* in the header (next to ☰) it floats over nothing — the site chat's camera button was under it (Mario, 2026-09-14) */
      header #pwa-refresh{position:static;width:40px;height:36px;border-radius:9px;box-shadow:none;background:transparent;color:inherit;font-size:1.2rem;border-color:rgba(128,128,128,.4);margin-left:8px;}
      @media (max-width:700px){ header{grid-template-columns:1fr auto auto !important;} header #pwa-refresh{grid-column:2;grid-row:1;justify-self:end;margin:0;} header .mob-btn{grid-column:3;} }
      #pwa-refresh.spin{animation:pwa-spin .8s linear infinite;} @keyframes pwa-spin{to{transform:rotate(360deg)}}
      #ptr{position:fixed;top:0;left:0;right:0;text-align:center;font-size:.8rem;color:var(--amber,#F2A93B);padding:8px;z-index:901;pointer-events:none;opacity:0;transition:opacity .15s;background:var(--mantle,#181825);} #ptr.on{opacity:1;}`;
    document.head.appendChild(st);
    const btn = document.createElement('button'); btn.id = 'pwa-refresh'; btn.type = 'button'; btn.title = 'Reload'; btn.textContent = '↻';
    const reload = () => { btn.classList.add('spin'); location.reload(); };
    btn.onclick = reload; (document.querySelector('header') || document.body).appendChild(btn);
    const ptr = document.createElement('div'); ptr.id = 'ptr'; document.body.appendChild(ptr);
    // a real pull: 160px down and held at least 0.7 s — a short flick does nothing (Mario, 2026-09-14)
    const NEED = 160, HOLD = 700; let y0 = null, t0 = 0, pulled = 0;
    const top = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    document.addEventListener('touchstart', e => { y0 = top() ? e.touches[0].clientY : null; t0 = Date.now(); pulled = 0; }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (y0 === null) return; pulled = e.touches[0].clientY - y0;
      const ready = pulled > NEED && Date.now() - t0 > HOLD;
      if (pulled > 40) { ptr.textContent = ready ? '↻ release to reload' : pulled > NEED ? '… hold on' : '↓ keep pulling to reload'; ptr.classList.add('on'); } else ptr.classList.remove('on');
    }, { passive: true });
    document.addEventListener('touchend', () => { if (y0 !== null && pulled > NEED && Date.now() - t0 > HOLD) { ptr.textContent = '↻ reloading…'; reload(); } else ptr.classList.remove('on'); y0 = null; }, { passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => A.refreshUI()); else A.refreshUI();
  // the hub installs as its own app (Shift Hub, 2026-09-14): a service worker makes Android offer Install
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

  A.mobileUI = function () {
    if (document.getElementById('mob-css')) return;
    const st = document.createElement('style'); st.id = 'mob-css';
    st.textContent = `
      .mob-btn{display:none;} .mob-menu{display:none;}
      @media (max-width:700px){
        header{display:grid !important;grid-template-columns:1fr auto;align-items:center;gap:6px 10px;padding:10px 12px !important;}
        header .hleft{display:contents;} header .wordmark{grid-column:1;grid-row:1;} header nav.tabs{display:none !important;} header .who{display:none !important;}
        header .crumbs,header #crumbs{grid-column:1 / -1;grid-row:2;}
        .mob-btn{display:flex;grid-column:2;grid-row:1;justify-self:end;width:40px;height:36px;align-items:center;justify-content:center;border:1px solid rgba(128,128,128,.4);border-radius:9px;background:transparent;color:inherit;font-size:1.25rem;cursor:pointer;}
        .mob-menu{position:fixed;top:0;right:0;bottom:0;width:min(78vw,300px);background:var(--mantle,#181825);border-left:1px solid var(--surface0,#313244);z-index:1000;padding:14px;display:flex;flex-direction:column;gap:4px;box-shadow:-8px 0 30px rgba(0,0,0,.4);}
        .mob-menu[hidden]{display:none;} .mob-menu a,.mob-menu span.u{display:block;padding:12px 12px;border-radius:9px;color:var(--text,#cdd6f4);text-decoration:none;font-size:1rem;}
        .mob-menu a.on{color:var(--amber,#F2A93B);background:rgba(242,169,59,.12);font-weight:600;} .mob-menu .x{align-self:flex-end;font-size:1.3rem;padding:4px 10px;} .mob-menu .u{margin-top:auto;color:var(--sub,#a6adc8);font-size:.85rem;border-top:1px solid var(--surface0,#313244);padding-top:14px;}
        .mob-menu .u a{display:inline;padding:0;margin-left:10px;color:var(--overlay0,#6c7086);}
        .mob-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;} .mob-back[hidden]{display:none;}
        .fold-txt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;} .fold-txt.open{display:block;-webkit-line-clamp:unset;}
        .fold-more{display:inline-block;color:var(--amber,#F2A93B);font-size:.78rem;cursor:pointer;margin:2px 0 8px;}
      }`;
    document.head.appendChild(st);
    const hdr = document.querySelector('header'); if (!hdr) return;
    const tabs = hdr.querySelector('nav.tabs'), who = hdr.querySelector('.who, #who');
    if (tabs || who) {
      const btn = document.createElement('button'); btn.className = 'mob-btn'; btn.type = 'button'; btn.textContent = '☰'; btn.title = 'Menu';
      const back = document.createElement('div'); back.className = 'mob-back'; back.hidden = true;
      const menu = document.createElement('div'); menu.className = 'mob-menu'; menu.hidden = true;
      const fill = () => { menu.innerHTML = '<span class="x">✕</span>' + (tabs ? tabs.innerHTML : '') + (who && who.innerHTML.trim() ? `<span class="u">${who.innerHTML}</span>` : ''); menu.querySelector('.x').onclick = close; };
      const open = () => { fill(); menu.hidden = false; back.hidden = false; }, close = () => { menu.hidden = true; back.hidden = true; };
      btn.onclick = open; back.onclick = close;
      hdr.appendChild(btn); document.body.append(back, menu);
    }
    // explanations fold to two lines on the phone; a tap opens them
    const fold = el => {
      if (el.dataset.folded || el.textContent.trim().length < 160) return; el.dataset.folded = '1';   // short notes stay as they are
      el.classList.add('fold-txt');
      const more = document.createElement('span'); more.className = 'fold-more'; more.textContent = 'more…';
      more.onclick = () => { const o = el.classList.toggle('open'); more.textContent = o ? 'less' : 'more…'; };
      el.after(more);
    };
    const scan = () => { if (!matchMedia('(max-width:700px)').matches) return; for (const el of document.querySelectorAll('p.lead, .lead, .note, p.small.muted, .card > p.small')) fold(el); };
    scan(); new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    matchMedia('(max-width:700px)').addEventListener('change', scan);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => A.mobileUI()); else A.mobileUI();
})();
