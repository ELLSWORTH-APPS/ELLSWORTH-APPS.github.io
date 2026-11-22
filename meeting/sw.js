/* Morning Meeting background helper. It keeps a copy of the app on this phone so the app opens with no signal.
   The build fills in the version and file list below; a new version replaces the old copy. */
self.MM_VERSION = "2026.11.22-0d73ef";

const CACHE = "mm-" + self.MM_VERSION;
const FILES = [
 "app.js",
 "asr-worker.js",
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
 "vendor/ort/ort-wasm-simd-threaded.mjs",
 "vendor/ort/ort-wasm-simd-threaded.wasm",
 "vendor/ort/ort.wasm.min.js",
 "version.js"
];
// It only answers for this app's own pages and files, so the other apps on the site are left alone.
// It also marks them as this app's own (cross-origin isolation), which lets the speech engine use all the phone's cores.
const isolate = (res) => {
  if (!res || res.type === "opaque" || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};
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
  if (url.origin !== self.location.origin) return;   // Claude is always reached over the web
  if (req.mode === "navigate") {
    if (!PAGES.has(url.pathname)) return;   // another app's page
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const page = await cache.match("index.html");
      if (page) return isolate(page);
      try { return isolate(await fetch(req)); } catch (e) { return new Response("Morning Meeting needs signal the first time it opens.", { status: 503, headers: { "Content-Type": "text/plain" } }); }
    })());
    return;
  }
  if (!OWN.has(url.pathname)) return;   // not one of this app's files (the speech engine's model keeps its own copy)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return isolate(hit || await fetch(req));
  })());
});
