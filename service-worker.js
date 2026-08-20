const CACHE = "vocal-studio-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg"
];

const OFFLINE_PAGE = "./index.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Skip non-GET requests
  if (e.request.method !== "GET") return;
  
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) {
        // Return cached version, but also fetch and update cache in background
        const fetchPromise = fetch(e.request).then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE).then((cache) => {
              cache.put(e.request, responseClone);
            });
          }
          return response;
        }).catch(() => {
          // Network failed, return cached version
          return cached;
        });
        
        return cached;
      }
      
      // Not in cache, fetch from network
      return fetch(e.request).then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE).then((cache) => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Network failed and not in cache
        // Return offline page for navigation requests
        if (e.request.mode === "navigate") {
          return caches.match(OFFLINE_PAGE);
        }
        return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
      });
    })
  );
});
