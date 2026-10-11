// Shipmate service worker. Hand-written and deliberately small: it caches the app shell so the
// installed PWA can launch offline, and shows push notifications. It never touches /api,
// /healthz or the WebSocket; those always go to the network.
//
//   navigation        -> network first, fall back to the cached shell
//   /assets/* (hashed) -> cache first (file names change on every build)
//   icons, manifest   -> stale-while-revalidate
//   anything else     -> network only

const VERSION = "shipmate-v2";
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

// ---------- push notifications ----------
//
// The server sends { kind, title, body, url, tag, approval? } (PushPayload in @shipmate/core).
// Approval notifications get Approve and Deny buttons that answer with the one-time token in the
// payload, never with cookies. Where buttons are not supported (iOS), a tap opens the approval.

/** The title and options for showNotification. Exposed on `self` so the unit test can drive it. */
function notificationFor(data) {
  const d = data && typeof data === "object" ? data : {};
  const options = {
    body: typeof d.body === "string" ? d.body : "",
    tag: typeof d.tag === "string" ? d.tag : undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: safeUrl(d.url), approval: d.approval || null },
  };
  if (d.kind === "approval" && d.approval && d.approval.id && d.approval.token) {
    options.actions = [
      { action: "allow", title: "Approve" },
      { action: "deny", title: "Deny" },
    ];
    options.requireInteraction = true;
    options.renotify = true;
  }
  return { title: typeof d.title === "string" && d.title ? d.title : "Shipmate", options };
}
self.notificationFor = notificationFor;

/** Only paths in this app; anything else opens the Bridge. */
function safeUrl(url) {
  // The URL parser reads "/\evil.example" as "//evil.example", so backslashes are refused too.
  return typeof url === "string" &&
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !url.includes("\\")
    ? url
    : "/";
}
self.safeUrl = safeUrl;

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const { title, options } = notificationFor(data);
  event.waitUntil(self.registration.showNotification(title, options));
});

async function openApp(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const mine = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (mine) {
    // The app routes by hash, so the page moves itself instead of reloading.
    mine.postMessage({ type: "shipmate:navigate", url });
    return mine.focus();
  }
  return self.clients.openWindow(url);
}

async function answer(approval, decision, url) {
  try {
    const res = await fetch(`/api/push/act/approvals/${encodeURIComponent(approval.id)}`, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: approval.token, decision }),
    });
    if (res.ok) return;
  } catch {
    // Offline or the server is down: fall through and open the app.
  }
  await openApp(url);
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  const url = safeUrl(data.url);
  if ((event.action === "allow" || event.action === "deny") && data.approval) {
    event.waitUntil(answer(data.approval, event.action, url));
  } else {
    event.waitUntil(openApp(url));
  }
});
