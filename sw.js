const CACHE_NAME = "xau-sniper-clean-v1";

self.addEventListener("install", event => {
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.map(key => caches.delete(key))
            )
        )
    );

    self.clients.claim();
});
