// PIXORA service worker. Caches the app shell only. Photos and /api calls are never cached.
// Bump V whenever any shipped file changes so installed apps refresh.
const V = "pixora-v2";
const SHELL = [
  "./", "index.html", "config.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  // Only handle same-origin GETs. Everything else (the Worker API, uploads) goes straight to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // Pages: network first so updates show up, fall back to cache when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(V).then((c) => c.put("index.html", copy)); return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  // Static shell files: cache first, then network.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
