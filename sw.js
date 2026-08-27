const CACHE_NAME = "xau-sniper-v3-1";

const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.json",
    "/icon.png"
];

self.addEventListener("install", event => {

    event.waitUntil(

        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())

    );

});

self.addEventListener("activate", event => {

    event.waitUntil(

        caches.keys()
            .then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== CACHE_NAME)
                        .map(key => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())

    );

});

self.addEventListener("fetch", event => {

    const request = event.request;

    /*
     * API jangan cache.
     * Kita nak harga XAU/USD sentiasa fresh.
     */

    if (
        request.url.includes("/api/xau")
    ) {
        return;
    }

    event.respondWith(

        fetch(request)
            .then(response => {

                if (
                    response &&
                    response.status === 200 &&
                    response.type !== "opaque"
                ) {

                    const copy = response.clone();

                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(request, copy);
                        });

                }

                return response;

            })
            .catch(() => {

                return caches.match(request);

            })

    );

});
