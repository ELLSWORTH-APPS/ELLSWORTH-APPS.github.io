/* Materials background helper. It keeps a copy of the app on this phone so it opens with no signal.
   The build fills in the version and file list below; a new version replaces the old copy. */
const VERSION = "2026.11.27-8cf5c5";
const CACHE = "mat-" + VERSION;
const FILES = [
 "config.js",
 "fonts/fonts.css",
 "fonts/fredoka-latin-wght-normal.woff2",
 "fonts/nunito-latin-wght-normal.woff2",
 "icons/apple-touch-icon.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "index.html",
 "manifest.webmanifest",
 "version.js"
];
// It only answers for this app's own pages and files, so the other apps on the same site are left alone.
const SCOPE = new URL(self.registration.scope);
const OWN = new Set(FILES.map(f => new URL(f, SCOPE).pathname));
const PAGES = new Set([SCOPE.pathname, SCOPE.pathname + "index.html"]);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(f => new Request(f, { cache: "reload" })));   // straight from the web, so a new version is really new
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("mat-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // the trip to the sheet always goes to the web
  if (req.mode === "navigate") {
    if (!PAGES.has(url.pathname)) return;
    // The page: the copy on the phone right away; the web only if the copy is missing.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match("index.html")) || fetch(req);
    })());
    return;
  }
  if (!OWN.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
  })());
});
