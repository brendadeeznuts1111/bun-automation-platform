// BUN-DEV PWA Service Worker
// Ref: https://web.dev/articles/install-criteria
// Chrome requires a service worker with a fetch handler for PWA installability.

const CACHE_NAME = "bun-dev-v1";
const STATIC_ASSETS = [
  "/dashboard",
  "/manifest.json",
  "/icons/icon-128.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Install: pre-cache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()),
  );
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Fetch: serve from cache, fall back to network
self.addEventListener("fetch", (event) => {
  // Only handle GET requests
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached response if available, otherwise fetch from network
      return cached || fetch(event.request).then((response) => {
        // Cache successful responses for same-origin requests
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached dashboard if available
        return caches.match("/dashboard");
      });
    }),
  );
});
