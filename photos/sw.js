/* Job Photos background helper. It keeps a copy of the app itself (no photos) so the app opens with no signal,
   and on Android it sends waiting photos by itself once there's service, even with the app closed.
   The build fills in the version and file list below; a new version replaces the old copy. */
self.JP_VERSION = "2026.11.20-dd912a";
importScripts("config.js", "store.js");

const CACHE = "jp-" + self.JP_VERSION;
const FILES = [
 "index.html",
 "app.js",
 "store.js",
 "styles.css",
 "config.js",
 "version.js",
 "manifest.webmanifest",
 "fonts/archivo.woff2",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "icons/apple-touch-icon.png"
];
// It only answers for this app's own pages and files, so the other apps on the same site are left alone.
const SCOPE = new URL(self.registration.scope);
const PAGES = new Set([SCOPE.pathname, SCOPE.pathname + "index.html"]);
const OWN = new Set(FILES.map(f => new URL(f, SCOPE).pathname));
const isOurPage = href => { try { return PAGES.has(new URL(href).pathname); } catch (e) { return false; } };

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Straight from the web, not the browser's short-term cache, so a new version is really new.
    await cache.addAll(FILES.map(f => new Request(f, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("jp-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // trips to the sheet always go to the web
  if (req.mode === "navigate") {
    if (!PAGES.has(url.pathname)) return;   // another app's page
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const page = await cache.match("index.html");
      if (page) return page;
      try { return await fetch(req); } catch (e) { return new Response("Job Photos needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }
  if (!OWN.has(url.pathname)) return;   // not one of this app's files
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});

// Android: the browser wakes this up once there's signal again, even with the app closed.
self.addEventListener("sync", event => {
  if (event.tag !== "jp-send") return;
  event.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(w => isOurPage(w.url));
    if (wins.some(w => w.visibilityState === "visible")) return;   // an open app sends its own
    const r = await JPStore.withLock(() => JPStore.pushAll({ parallel: 1 }));
    wins.forEach(w => w.postMessage({ t: "synced" }));
    if (r && !r.ok && r.offline) throw new Error("No signal yet");   // the browser tries again later
  })());
});

self.addEventListener("message", event => {
  if (event.data && event.data.t === "skip") self.skipWaiting();
});
