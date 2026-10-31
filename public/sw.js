// Service worker: push display + click routing only. Caches nothing (no private data offline).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let id = null;
  try {
    const d = event.data ? event.data.json() : {};
    if (typeof d.id === 'string' && /^[0-9a-f-]{36}$/.test(d.id)) id = d.id;
  } catch { /* ignore malformed payload */ }
  // iOS requires every push to show a notification. Generic text only.
  event.waitUntil(self.registration.showNotification('New upload ready', { data: { id }, tag: id || 'upload' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const path = id && /^[0-9a-f-]{36}$/.test(id) ? `/uploads/${id}` : '/inbox';
  event.waitUntil((async () => {
    const url = new URL(path, self.location.origin).href; // same-origin by construction
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        try {
          await c.focus();
          if ('navigate' in c) await c.navigate(url);
          return;
        } catch { /* uncontrolled or discarded client: fall through to openWindow */ }
      }
    }
    return self.clients.openWindow(url);
  })());
});
