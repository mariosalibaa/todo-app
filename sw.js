// Minimal service worker: makes the app installable. Network-first passthrough —
// the app is live team data, so nothing is served stale; offline shows the
// last-cached shell for navigation only.
const SHELL = 'todo-shell-v1';
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
