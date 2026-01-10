/* offline-worker.js
   - Caches everything in /offline-manifest.txt (excluding .github)
   - Uses limited concurrency + timeouts so it doesn’t freeze on one file
   - Sends progress + current path back to the page
*/
const VERSION = "seraph-full-offline-v3";
const CACHE_NAME = `${VERSION}-all`;

const MANIFEST_URL = "/offline-manifest.txt";

// Tune these:
const CONCURRENCY = 2;          // 4–8 is usually safe
const PER_FILE_TIMEOUT = 25000; // 25s
const RETRIES = 1;              // retry once on transient failures

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    self.skipWaiting();
    const cache = await caches.open(CACHE_NAME);
    try { await cache.add("/"); } catch {}
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map(k => (k.startsWith("seraph-full-offline-") && k !== CACHE_NAME) ? caches.delete(k) : null)
    );
    await self.clients.claim();
  })());
});

async function postToAll(msg) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

function isCacheablePath(p) {
  if (!p || typeof p !== "string") return false;
  if (!p.startsWith("/")) return false;
  if (p.startsWith("/.github/")) return false;
  if (p.startsWith("/.git/")) return false;
  if (p.includes("/node_modules/")) return false;
  if (p.endsWith(".DS_Store")) return false;
  return true;
}

async function readManifestList() {
  const res = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const text = await res.text();

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const paths = [];
  for (const line of lines) {
    if (!line.startsWith("/")) continue;
    if (!isCacheablePath(line)) continue;
    paths.push(line);
  }

  // Always include core pages
  for (const must of ["/", "/index.html", "/games/index.html", "/apps/index.html", "/settings.html"]) {
    if (!paths.includes(must) && isCacheablePath(must)) paths.unshift(must);
  }

  return [...new Set(paths)];
}

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, wrapped: (async () => {
    try { return await promise(controller.signal); }
    finally { clearTimeout(timeout); }
  })()};
}

async function fetchAndCache(cache, path) {
  const req = new Request(path, { cache: "no-store" });

  // If already cached, skip quickly
  const existing = await cache.match(req);
  if (existing) return { ok: true, skipped: true, status: 200 };

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const { wrapped } = withTimeout(async (signal) => {
        // IMPORTANT: same-origin only
        const res = await fetch(req, { signal, cache: "no-store", redirect: "follow" });
        return res;
      }, PER_FILE_TIMEOUT);

      const res = await wrapped;

      // Skip non-OK (404 etc). Don’t hang.
      if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 };

      // Cache it
      await cache.put(req, res.clone());
      return { ok: true, skipped: false, status: res.status };
    } catch (e) {
      // retry once on transient abort/network
      if (attempt >= RETRIES) return { ok: false, status: 0, err: String(e?.message || e) };
    }
  }

  return { ok: false, status: 0 };
}

async function cacheAllFromManifest() {
  const cache = await caches.open(CACHE_NAME);
  const list = await readManifestList();

  let done = 0;
  let failed = 0;
  let skipped = 0;

  await postToAll({ type: "offline-total", total: list.length });

  // Simple worker pool
  let idx = 0;

  async function worker(workerId) {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;

      const path = list[i];

      // tell page what file we’re on (helps debug “stuck at N”)
      await postToAll({ type: "offline-current", index: i + 1, total: list.length, path });

      const r = await fetchAndCache(cache, path);

      if (r.ok) {
        if (r.skipped) skipped++;
        else done++;
      } else {
        failed++;
      }

      // progress update every ~10 processed items across all workers
      const processed = done + failed + skipped;
      if (processed % 10 === 0) {
        await postToAll({ type: "offline-progress", done, failed, skipped, total: list.length });
      }
    }
  }

  await postToAll({ type: "offline-start" });

  // start pool
  const pool = Array.from({ length: CONCURRENCY }, (_, n) => worker(n));
  await Promise.all(pool);

  await postToAll({ type: "offline-finished", done, failed, skipped, total: list.length });
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "DOWNLOAD_FOR_OFFLINE") return;

  event.waitUntil((async () => {
    try {
      await cacheAllFromManifest();
    } catch (e) {
      await postToAll({ type: "offline-error", message: String(e?.message || e) });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    const accept = req.headers.get("accept") || "";
    const isHTML = req.mode === "navigate" || accept.includes("text/html");

    if (isHTML) {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(req)) || (await cache.match("/")) || new Response("Offline.", { status: 503 });
      }
    }

    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response("Offline and not cached.", { status: 503 });
    }
  })());
});
