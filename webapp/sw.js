const cacheName = "cashflow-map-v36-member-access";
const assets = [
  "./",
  "./index.html",
  "./styles.css",
  "./journal.css",
  "./cashflow-visual.js",
  "./etf-data.js",
  "./portfolio-overlap.js",
  "./app.js",
  "./runtime-config.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const request = event.request;
  const url = new URL(request.url);
  if (url.pathname.includes("/api/")) return;
  const isAppShell = request.mode === "navigate" || [".html", ".css", ".js"].some((suffix) => url.pathname.endsWith(suffix));
  if (isAppShell) {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(cacheName).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
