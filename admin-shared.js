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
  let idToken = null, ready = false;
  try { A.session = localStorage.getItem('todo_session'); } catch {}

  const style = document.createElement('style');
  style.textContent = `
    #admin-login{position:fixed;inset:0;background:#1e1e2e;display:none;align-items:center;justify-content:center;z-index:1000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#cdd6f4;}
    .admin-login-card{background:#181825;border:1px solid #313244;border-radius:14px;padding:36px 32px;max-width:380px;width:90%;text-align:center;}
    .admin-login-card p{font-size:.95rem;line-height:1.45;margin:14px 0 20px;}
    .admin-login-card button{background:#F2A93B;color:#1e1e2e;border:0;border-radius:8px;padding:10px 22px;font-size:.95rem;font-weight:600;cursor:pointer;}
    .admin-login-sub{margin-top:14px;font-size:.72rem;color:#6c7086;}
    .admin-login-sub a{color:#89b4fa;}
    .admin-wordmark{font-family:"Century Gothic",CenturyGothic,AppleGothic,system-ui,sans-serif;letter-spacing:.18em;font-size:1.15rem;color:#cdd6f4;}
    .admin-wordmark span{color:#F2A93B;}`;
  document.head.appendChild(style);

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function overlay(html) {
    let el = document.getElementById('admin-login');
    if (!el) { el = document.createElement('div'); el.id = 'admin-login'; document.body.appendChild(el); }
    el.innerHTML = html;
    el.style.display = html ? 'flex' : 'none';
  }
  const card = (msg, btn, sub) => `<div class="admin-login-card"><div class="admin-wordmark">SHIFT <span>GROUP</span></div>
    <p>${msg}</p>${btn ? '<button onclick="Admin.signIn()">Sign in with Google</button>' : ''}<div class="admin-login-sub">${sub || ''}</div></div>`;

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
    try {
      localStorage.setItem('todo_session', s.token);
      localStorage.setItem('todo_session_user', JSON.stringify({ email: s.email, name: s.name }));
    } catch {}
  }
  function drop() {
    A.session = null;
    try { localStorage.removeItem('todo_session'); localStorage.removeItem('todo_session_user'); } catch {}
  }

  // true = the request was answered (allowed, no-app, or not-approved screen shown)
  async function tryMe(onReady) {
    try {
      const me = await A.api('GET', '/api/me');
      A.me = me;
      if (A.app && !(me.apps || []).includes(A.app)) {
        overlay(card(`${esc(me.email)} is signed in but has no access to <b>${esc(A.app)}</b> yet. Ask Mario to enable it.`, false,
          '<a href="/admin">← Back to the hub</a> &nbsp;·&nbsp; <a href="#" onclick="Admin.signOut();return false;">Sign out</a>'));
        return true;
      }
      if (!ready) { ready = true; overlay(''); onReady(me); }
      return true;
    } catch (e) {
      if (e.status === 403) {
        overlay(card(`${esc((e.data && e.data.email) || 'This account')} is not approved yet. Ask Mario to add you, then reload.`, true,
          'Or try a different Google account'));
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
      const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
      if (cfg.authDisabled) {   // local machine: no sign-in, everything open
        A.disabled = true;
        A.me = { email: 'local@shift', name: 'Mario', apps: ['todo', 'accounting'], admin: true, local: true };
        ready = true; overlay(''); onReady(A.me); return;
      }
      overlay(card('Checking session…'));
      if (A.session && await tryMe(onReady)) return;
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
    if (scopes && scopes.length) p.setCustomParameters({ prompt: 'consent' });
    const r = await fbAuth.signInWithPopup(p);
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
})();
