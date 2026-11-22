/* Morning Meeting background helper. It keeps a copy of the app on this phone so the app opens with no signal.
   The build fills in the version and file list below; a new version replaces the old copy. */
self.MM_VERSION = "2026.11.22-8cf348";

const CACHE = "mm-" + self.MM_VERSION;
const FILES = [
 "app.js",
 "fonts/barlow-condensed-latin-600-normal.woff2",
 "fonts/barlow-condensed-latin-700-normal.woff2",
 "fonts/barlow-latin-400-normal.woff2",
 "fonts/barlow-latin-500-normal.woff2",
 "fonts/barlow-latin-600-normal.woff2",
 "fonts/fonts.css",
 "icons/apple-touch-icon.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "index.html",
 "manifest.webmanifest",
 "styles.css",
 "vendor/README.txt",
 "vendor/lame.min.js",
 "version.js"
];
// It only answers for this app's own pages and files, so the other apps on the site are left alone.
const SCOPE = new URL(self.registration.scope);
const PAGES = new Set([SCOPE.pathname, SCOPE.pathname + "index.html"]);
const OWN = new Set(FILES.map(f => new URL(f, SCOPE).pathname));

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
    await Promise.all(keys.filter(k => k.startsWith("mm-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Google's AI is always reached over the web
  if (req.mode === "navigate") {
    if (!PAGES.has(url.pathname)) return;   // another app's page
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const page = await cache.match("index.html");
      if (page) return page;
      try { return await fetch(req); } catch (e) { return new Response("Morning Meeting needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
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
