"use strict";

const CACHE = "movie-night-v25";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  // cache: "reload" bypasses the browser HTTP cache (GitHub Pages serves
  // max-age=600), otherwise a fresh install can re-cache stale files.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))
    )
  );
});

// New versions wait until the app's "Update now" button tells them to take over.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // API calls: network only (data must be fresh; errors handled by the app).
  if (url.hostname === "api.themoviedb.org") return;

  // Poster images: cache-first, populate as we go.
  if (url.hostname === "image.tmdb.org") {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
      )
    );
    return;
  }

  // App shell: cache-first with network fallback.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
