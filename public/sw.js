// sw.js — service worker for offline app-shell + last-known-lineup caching.
// Strategy: precache the static shell; navigations (HTML) network-first with a
// cached fallback; /api/* and static assets stale-while-revalidate (instant from
// cache, refreshed in the background). Bump VERSION to force a clean rollover.
const VERSION = "v1-2026-08-27";
const STATIC = `static-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const PRECACHE = [
  "/shared.css", "/nav.js",
  "/surface/style.css", "/surface/app.js",
  "/nfl/style.css", "/nfl/app.js", "/nfl/teams.js",
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

  // HTML navigations: network-first (freshest markup), fall back to the last
  // cached copy of this page, then the hub, so offline still shows something.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match("/")))
    );
    return;
  }

  // Lineup/config APIs: stale-while-revalidate → instant last-known lineup offline.
  if (url.pathname.startsWith("/api/")) { e.respondWith(staleWhileRevalidate(req, RUNTIME)); return; }

  // Static assets (css/js/icons): stale-while-revalidate.
  e.respondWith(staleWhileRevalidate(req, STATIC));
});
