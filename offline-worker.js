/* offline-worker.js
   Full-site offline caching using /offline-manifest.txt (batched so it won't die mid-run)
*/
const VERSION = "seraph-offline-manifest-v2";
const CORE_CACHE = `${VERSION}-core`;
const FILE_CACHE = `${VERSION}-files`;

const CORE_URLS = ["/", "/index.html", "/offline.html", "/offline-worker.js", "/offline-manifest.txt"];

function isQuotaError(err) {
  if (!err) return false;
  const msg = String(err && (err.message || err)).toLowerCase();
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    msg.includes("quota") ||
    msg.includes("storage") && msg.includes("exceed")
  );
}

async function getManifestPaths() {
  const res = await fetch("/offline-manifest.txt", { cache: "no-store" });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
  const txt = await res.text();
  const lines = txt.split(/\r?\n/);
  const paths = [];
  const seen = new Set();
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    // Your manifest has header labels like "png", "jpg", etc — only accept real paths.
    if (!s.startsWith("/")) continue;
    // Skip service-worker internal cache files if someone included them
    if (seen.has(s)) continue;
    seen.add(s);
    paths.push(s);
  }
  return paths;
}

async function putWithTimeout(cache, url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Cache only same-origin GET responses
    await cache.put(url, res.clone());
    return true;
  } finally {
    clearTimeout(t);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    self.skipWaiting();
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_URLS.map(u => new Request(u, { cache: "reload" })));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith("seraph-offline-") && !k.startsWith(VERSION)) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type !== "CACHE_MANIFEST_BATCH") return;

  const startAt = Math.max(0, Number(msg.startAt || 0));
  const batchSize = Math.max(1, Math.min(2000, Number(msg.batchSize || 300)));

  event.waitUntil((async () => {
    const client = event.source;
    const fileCache = await caches.open(FILE_CACHE);

    const paths = await getManifestPaths();

    // Inform the page of total once (ok if repeated)
    client?.postMessage({ type: "MANIFEST_INFO", total: paths.length });

    const end = Math.min(paths.length, startAt + batchSize);

    // Count already-cached as "done" for nicer progress
    let done = startAt;

    for (let i = startAt; i < end; i++) {
      const url = paths[i];

      // If already cached, skip quickly
      const hit = await fileCache.match(url);
      if (hit) {
        done = i + 1;
        if ((i - startAt) % 25 === 0) {
          client?.postMessage({ type: "CACHE_PROGRESS", done, total: paths.length, next: i + 1, last: url });
        }
        continue;
      }

      try {
        await putWithTimeout(fileCache, url, 45000);
      } catch (err) {
        if (isQuotaError(err)) {
          client?.postMessage({ type: "QUOTA_STOP", at: i, total: paths.length, next: i, last: url });
          return;
        }
        // Non-fatal: report and continue
        client?.postMessage({ type: "CACHE_ERROR", url, error: (err && err.message) ? err.message : String(err) });
      }

      done = i + 1;

      // Throttle progress messages + yield so the SW stays responsive
      if ((i - startAt) % 25 === 0) {
        client?.postMessage({ type: "CACHE_PROGRESS", done, total: paths.length, next: i + 1, last: url });
        await new Promise(r => setTimeout(r, 0));
      }
    }

    client?.postMessage({ type: "BATCH_DONE", next: end, total: paths.length });
  })());
});

// Fetch handling: offline-first for cached files, network fallback.
// Navigations: network-first with cached fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";

  // HTML navigations
  if (req.mode === "navigate" || accept.includes("text/html")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const fileCache = await caches.open(FILE_CACHE);
        fileCache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const core = await caches.open(CORE_CACHE);
        const fileCache = await caches.open(FILE_CACHE);
        return (await fileCache.match(req)) ||
               (await core.match("/")) ||
               (await core.match("/index.html")) ||
               new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  // Assets: cache-first
  event.respondWith((async () => {
    const fileCache = await caches.open(FILE_CACHE);
    const cached = await fileCache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) fileCache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      return new Response("Offline and not cached.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  })());
});
