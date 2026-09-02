// sw.js — service worker for offline app-shell + last-known-lineup caching.
// Strategy: precache the static shell; navigations (HTML) network-first with a
// cached fallback; /api/* and static assets stale-while-revalidate (instant from
// cache, refreshed in the background). Bump VERSION to force a clean rollover.
const VERSION = "v8-2026-09-02";
const STATIC = `static-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const PRECACHE = [
  "/shared.css", "/nav.js", "/common.js",
  "/surface/style.css", "/surface/app.js",
  "/nfl/style.css", "/nfl/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== STATIC && k !== RUNTIME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Serve from cache immediately, revalidate in the background.
function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never intercept ESPN/CDN/analytics

  // HTML navigations: stale-while-revalidate — paint the cached shell INSTANTLY (hides
  // Render free-tier cold-start TTFB on a repeat visit), then refresh it in the background.
  // First visit (no cache) waits on the network, then falls back to the hub. The shell
  // rarely changes and lineups are fetched fresh via /api, so a page may be at most one
  // deploy behind until the background copy lands (VERSION bump bounds staleness).
  if (req.mode === "navigate") {
    e.respondWith(
      caches.open(RUNTIME).then((cache) => cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => cached || caches.match("/"));
        return cached || network;
      }))
    );
    return;
  }

  // Lineup/config APIs: stale-while-revalidate → instant last-known lineup offline.
  if (url.pathname.startsWith("/api/")) { e.respondWith(staleWhileRevalidate(req, RUNTIME)); return; }

  // Static assets (css/js/icons): stale-while-revalidate.
  e.respondWith(staleWhileRevalidate(req, STATIC));
});
