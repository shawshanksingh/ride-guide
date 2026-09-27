// Service worker: app shell offline, route files network-first, map tiles + routing cached as you use them.
const VERSION = 'v3';
const SHELL = `shell-${VERSION}`, DATA = `data-${VERSION}`, TILES = 'tiles-v1';
const SHELL_FILES = ['./', 'index.html', 'app.css', 'nav.js', 'music.js', 'app.js', 'leaflet.js', 'leaflet.css',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const MAX_TILES = 1500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, DATA, TILES].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES); const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trimTiles(); } return r; }
      catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.hostname === 'routing.openstreetmap.de') {
    e.respondWith(caches.open(DATA).then(async c => {
      try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }
      catch (err) { const hit = await c.match(e.request); return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('.json')) { // route files: network-first so new routes show up
      e.respondWith(caches.open(DATA).then(async c => {
        try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }
        catch (err) { return (await c.match(e.request, { ignoreSearch: true })) || (await caches.match(e.request, { ignoreSearch: true })) || Response.error(); }
      }));
      return;
    }
    // stale-while-revalidate: instant offline start, updates picked up on the next launch
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit || Response.error());
      return hit || net;
    }));
  }
});
