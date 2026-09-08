const CACHE = "open-wardrobe-shell-v1";
const IMAGE_CACHE = "wardrobe-images-v1";
const ACTIVE_CACHES = new Set([CACHE, IMAGE_CACHE]);
const MAX_IMAGE_ENTRIES = 800;
const SHELL = ["/", "/manifest.webmanifest"];

async function trimImages(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_IMAGE_ENTRIES;
  if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((request) => cache.delete(request)));
}

async function fetchAndCacheImage(request, cache) {
  const response = await fetch(request);
  const contentType = response.headers.get("content-type") || "";
  if (response.ok && !response.redirected && contentType.startsWith("image/")) {
    await cache.put(request, response.clone());
    await trimImages(cache);
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => !ACTIVE_CACHES.has(key)).map((key) => caches.delete(key)))),
  ]));
  self.clients.claim();
});

// Entry points and assets this worker must never answer for.
//
// The prototype pages are separate Vite entry points, and the dev server's
// module graph is not cacheable at all. Without this, a worker registered by an
// earlier production run keeps intercepting on the same origin — and because
// the navigation handler below falls back to the cached "/" shell, a prototype
// URL comes back as the main app instead. That is invisible in a fresh profile
// and permanent in the browser you actually use.
const BYPASS = /^\/(prototype|@vite|@react-refresh|@fs\/|src\/|node_modules\/)/;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (BYPASS.test(url.pathname) || url.searchParams.has("t")) return;

  if (url.pathname.startsWith("/_ipx/")) {
    event.respondWith(caches.open(IMAGE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const update = fetchAndCacheImage(request, cache);
      if (cached) {
        event.waitUntil(update.catch(() => undefined));
        return cached;
      }
      return update;
    }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
      return response;
    // Offline fallback: this exact page if we have it, and only then the app
    // shell — and never the shell for some other entry point, which would
    // silently answer one page with a different one.
    }).catch(() => caches.match(request).then((cached) => cached
      || (url.pathname === "/" ? caches.match("/") : undefined))));
  }
});
