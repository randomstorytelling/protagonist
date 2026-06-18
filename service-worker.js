/* Protagonist service worker.
 * Network-first with cache fallback: you always get the latest build when online, and the app
 * still works offline from the last-seen copy. (Cache-first was serving stale index.html/engine.js.) */
var CACHE = "protagonist-v4";
var ASSETS = ["./", "./index.html", "./engine.js", "./manifest.json", "./icon.svg",
              "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // BEST-EFFORT precache: one transient asset failure during a deploy must NOT abort install (addAll is
      // atomic and would leave no offline shell). Cache what we can now; the network-first handler backfills the rest.
      return Promise.all(ASSETS.map(function (a) {
        return fetch(a, { cache: "no-store" }).then(function (r) { if (r && r.ok) return c.put(a, r); }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  var sameOrigin = url.origin === self.location.origin;
  // never serve the SW script from cache — the browser must always see the freshest copy to detect updates
  if (sameOrigin && url.pathname.indexOf("service-worker.js") !== -1) return;
  e.respondWith(
    fetch(e.request)
      .then(function (resp) {
        if (resp && resp.ok && sameOrigin) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); // keep cache fresh for offline
        }
        return resp;
      })
      .catch(function () {
        // offline -> last good copy. For an uncached asset or a navigation, fall back to the app shell so we
        // never resolve to `undefined` (a hard offline failure). Navigations always get index.html.
        return caches.match(e.request).then(function (hit) {
          if (hit) return hit;
          return caches.match("./index.html").then(function (idx) {
            if (idx) return idx;
            return caches.match("./").then(function (shell) {
              // last resort: always return a real Response (never undefined, which would throw a TypeError)
              return shell || new Response("Offline — open the app once while online to cache it.", { status: 503, headers: { "Content-Type": "text/plain" } });
            });
          });
        });
      })
  );
});
