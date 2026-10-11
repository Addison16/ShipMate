// Shipmate service worker. Hand-written and deliberately small: it caches the app shell so the
// installed PWA can launch offline, and nothing else. It never touches /api, /healthz or the
// WebSocket; those always go to the network.
//
//   navigation        -> network first, fall back to the cached shell
//   /assets/* (hashed) -> cache first (file names change on every build)
//   icons, manifest   -> stale-while-revalidate
//   anything else     -> network only

const VERSION = "shipmate-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png"];

/** Decide how to handle a request. Exposed on `self` so the unit test can drive it. */
function strategyFor(method, url, mode, origin) {
  if (method !== "GET") return "network";
  const u = new URL(url);
  if (u.origin !== origin) return "network";
  const p = u.pathname;
  if (p === "/api" || p.startsWith("/api/") || p === "/healthz") return "network";
  if (p === "/sw.js") return "network";
  if (mode === "navigate") return "shell";
  if (p.startsWith("/assets/")) return "cache-first";
  if (p.startsWith("/icons/") || p === "/manifest.webmanifest" || p === "/favicon.svg") {
    return "revalidate";
  }
  return "network";
}
self.strategyFor = strategyFor;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function put(req, res) {
  if (!res?.ok || res.type !== "basic") return;
  const c = await caches.open(VERSION);
  await c.put(req, res);
}

async function shell(req) {
  try {
    const res = await fetch(req);
    // Keep the newest shell for offline launches. Every navigation serves index.html.
    if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
      await put("/", res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match("/");
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  await put(req, res.clone());
  return res;
}

async function revalidate(req) {
  const cached = await caches.match(req);
  const fresh = fetch(req)
    .then(async (res) => {
      await put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const s = strategyFor(req.method, req.url, req.mode, self.location.origin);
  if (s === "network") return;
  if (s === "shell") event.respondWith(shell(req));
  else if (s === "cache-first") event.respondWith(cacheFirst(req));
  else event.respondWith(revalidate(req));
});
