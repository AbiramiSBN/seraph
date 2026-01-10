/* offline-worker.js
   Downloads EVERYTHING listed in /offline-manifest.txt (except .github)
   Chunked caching + progress messages to avoid dying mid-way.
*/
const VERSION = "seraph-full-offline-v1";
const CACHE_NAME = `${VERSION}-all`;

const MANIFEST_URL = "/offline-manifest.txt";
const CHUNK_SIZE = 250;        // adjust 100-400 if needed
const PER_FILE_TIMEOUT = 20000; // 20s per file

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    self.skipWaiting();
    // Precache just "/" so UI loads even before full download
    const cache = await caches.open(CACHE_NAME);
    try { await cache.add("/"); } catch {}
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith("seraph-full-offline-") && k !== CACHE_NAME) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

async function postToAll(msg) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

function isCacheablePath(p) {
  if (!p || typeof p !== "string") return false;

  // only same-origin absolute paths
  if (!p.startsWith("/")) return false;

  // skip .github + git + obvious junk
  if (p.startsWith("/.github/")) return false;
  if (p.startsWith("/.git/")) return false;
  if (p.endsWith("/.DS_Store") || p.endsWith(".DS_Store")) return false;

  return true;
}

async function fetchWithTimeout(req) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), PER_FILE_TIMEOUT);
  try {
    const res = await fetch(req, { signal: controller.signal, cache: "no-store" });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function readManifestList() {
  const res = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const text = await res.text();

  // Your manifest may contain section headers (png/jpg/js). We ignore non-/ lines.
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const paths = [];
  for (const line of lines) {
    if (!line.startsWith("/")) continue;
    if (!isCacheablePath(line)) continue;
    paths.push(line);
  }

  // Always include homepage + menus
  for (const must of ["/", "/index.html", "/games/index.html", "/apps/index.html", "/settings.html"]) {
    if (!paths.includes(must) && isCacheablePath(must)) paths.unshift(must);
  }

  // de-dupe
  return [...new Set(paths)];
}

async function cacheAllFromManifest() {
  const cache = await caches.open(CACHE_NAME);
  const list = await readManifestList();

  let done = 0;
  let failed = 0;

  await postToAll({ type: "offline-total", total: list.length });

  // Chunked to avoid SW watchdog kills
  for (let i = 0; i < list.length; i += CHUNK_SIZE) {
    const chunk = list.slice(i, i + CHUNK_SIZE);

    // fetch+put each file (best-effort)
    for (const path of chunk) {
      try {
        const req = new Request(path, { cache: "no-store" });
        const res = await fetchWithTimeout(req);
        if (res.ok) {
          await cache.put(req, res.clone());
          done++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }

      // progress ping (don’t spam too hard)
      if ((done + failed) % 25 === 0) {
        await postToAll({ type: "offline-progress", done, failed, total: list.length });
      }
    }

    // yield control between chunks
    await postToAll({ type: "offline-progress", done, failed, total: list.length });
    await new Promise(r => setTimeout(r, 50));
  }

  await postToAll({ type: "offline-finished", done, failed, total: list.length });
}

self.addEventListener("message", (event) => {
  const t = event.data?.type;
  if (t !== "DOWNLOAD_FOR_OFFLINE") return;

  event.waitUntil((async () => {
    try {
      await postToAll({ type: "offline-start" });
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

    // HTML: network-first (fresh online), fallback to cache when offline
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

    // Assets: cache-first
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
