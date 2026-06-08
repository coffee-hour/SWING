// A simple Service Worker to satisfy the PWA install requirement
const CACHE_NAME = "swing-mmo-v1";

self.addEventListener("install", (event) => {
    console.log("[Service Worker] Installed");
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    console.log("[Service Worker] Activated");
    return self.clients.claim();
});

// A basic fetch event listener
self.addEventListener("fetch", (event) => {
    // Just pass the request through to the network
    event.respondWith(fetch(event.request));
});
