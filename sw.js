/* Spark service worker — offline-first app shell */
const CACHE = "spark-v8";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2/dist/zip.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  const isZipLib = url.href.includes("cdn.jsdelivr.net/npm/@zip.js");
  if (e.request.method !== "GET" || (!sameOrigin && !isZipLib)) return; // embeds, jina, twitter -> network

  if (sameOrigin) {
    /* network-first for the app shell: always get the latest when online,
       fall back to cache when offline. */
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  /* zip library: cache-first (immutable) */
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((resp) => {
      if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return resp;
    }))
  );
});
