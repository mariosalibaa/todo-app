// Hub › Energy › Plants › <plant> on every plant page (Mario 2026-10-20: "allow me to go back one step to plants, or two
// steps to energy, or to the home page"). Shown to hub admins only: the owners open the same public pages and should not
// be sent to a hub sign-in. Include it as <script src="/plant-crumbs.js" data-name="Mahab" data-mid='[["CPR","/energy/plants/cpr"]]'>
// (data-mid = steps between Plants and the page); it asks /api/me and shows itself for an admin. Hides the page's lone
// "Hub" button (#hubLink) when it shows.
(function () {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.PlantCrumbs = {
    show(name, mid) {
      if (document.getElementById('plantCrumbs')) return;
      const steps = [['⌂ Hub', '/'], ['Energy', '/energy'], ['Plants', '/energy/plants'], ...(mid || [])];
      if (!document.getElementById('plantCrumbs-css')) {
        const st = document.createElement('style'); st.id = 'plantCrumbs-css';
        st.textContent = `#plantCrumbs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:1100px;margin:10px auto 0;padding:0 16px;font-size:.82rem;font-family:inherit;}
          #plantCrumbs a{color:#F2A93B;text-decoration:none;font-weight:600;padding:3px 9px;border:1px solid rgba(128,128,128,.35);border-radius:8px;}
          #plantCrumbs a:hover{background:rgba(128,128,128,.15);} #plantCrumbs .sep{opacity:.45;} #plantCrumbs b{font-weight:600;opacity:.85;}
          @media print{#plantCrumbs{display:none;}}`;
        document.head.appendChild(st);
      }
      const nav = document.createElement('nav'); nav.id = 'plantCrumbs';
      nav.innerHTML = steps.map(([t, h]) => `<a href="${esc(h)}">${esc(t)}</a>`).join('<span class="sep">›</span>') + `<span class="sep">›</span><b>${esc(name)}</b>`;
      const hub = document.getElementById('hubLink'); if (hub) hub.hidden = true;
      const head = document.querySelector('header');
      if (head) head.insertAdjacentElement('afterend', nav); else document.body.prepend(nav);
    },
  };
  const me = document.currentScript, name = me && me.dataset.name;
  let mid = []; try { mid = JSON.parse((me && me.dataset.mid) || '[]'); } catch {}
  if (name) fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null)
    .then(u => { if (u && u.admin) PlantCrumbs.show(name, mid); }).catch(() => {});
})();
