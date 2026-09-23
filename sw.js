// Minimal service worker: makes the app installable. Network-first passthrough —
// the app is live team data, so nothing is served stale; offline shows the
// last-cached shell for navigation only.
const SHELL = 'todo-shell-v3';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(SHELL).then(c => c.put('/', copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('/'))
    );
  }
});

// Web push (2026-09-23): the server sends { title, body, url, tag }; a tap focuses the hub on that page
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Shift Hub', {
    body: d.body || '', icon: '/icons/hub-192.png', badge: '/icons/hub-192.png', tag: d.tag || undefined,
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const w of list) { if ('focus' in w) { w.navigate(url); return w.focus(); } }
    return clients.openWindow(url);
  }));
});
