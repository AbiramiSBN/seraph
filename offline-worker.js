/* offline-worker.js (Vercel-proof, no manifest required)
   - Precaches "/" so the main menu works offline
   - Runtime caches any same-origin GET you visit (assets/pages/games) so they become available offline after first open
   - Supports "DOWNLOAD_FOR_OFFLINE" (and "DOWNLOAD_CORE") messages from the homepage button
   - Sends a {type:"cached"} message back to all open windows when done
*/
const VERSION = "seraph-offline-vercel-v1";
const CORE_CACHE = `${VERSION}-core`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const CORE_URLS = ["/"]; // keep minimal and reliable on Vercel

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    self.skipWaiting();
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_URLS);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => (k.startsWith("seraph-offline-") && !k.startsWith(VERSION)) ? caches.delete(k) : null)
    );
    await self.clients.claim();
  })());
});

// User-triggered warm cache (caches "/" again) + notifies the page
self.addEventListener("message", (event) => {
  const t = event.data?.type;
  if (t !== "DOWNLOAD_FOR_OFFLINE" && t !== "DOWNLOAD_CORE") return;

  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_URLS);

    // tell all open tabs "cached"
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: "cached" });
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";
  const isHTML = req.mode === "navigate" || accept.includes("text/html");

  event.respondWith((async () => {
    const runtime = await caches.open(RUNTIME_CACHE);

    if (isHTML) {
      // Network-first so online stays fresh; offline falls back to cache.
      try {
        const fresh = await fetch(req);
        // Cache successful navigations (so pages you visited work offline later)
        if (fresh.ok) runtime.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await runtime.match(req)) || (await caches.match("/")) || new Response("Offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    // Assets: cache-first
    const cached = await runtime.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      if (fresh.ok) runtime.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response("Offline and not cached.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  })());
});
