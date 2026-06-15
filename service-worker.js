/* Protagonist service worker.
 * Network-first with cache fallback: you always get the latest build when online, and the app
 * still works offline from the last-seen copy. (Cache-first was serving stale index.html/engine.js.) */
var CACHE = "protagonist-v2";
var ASSETS = ["./", "./index.html", "./engine.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
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
  var sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    fetch(e.request)
      .then(function (resp) {
        if (resp && resp.ok && sameOrigin) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); // keep cache fresh for offline
        }
        return resp;
      })
      .catch(function () { return caches.match(e.request); }) // offline -> last good copy
  );
});
