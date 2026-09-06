const CACHE_NAME = "xau-sniper-clean-v2";

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


/* =========================================================
   PUSH NOTIFICATION
========================================================= */

self.addEventListener("push", event => {

    let data = {};

    try {
        data = event.data
            ? event.data.json()
            : {};
    } catch (e) {
        data = {
            title: "XAU/USD Pro Sniper",
            body: event.data
                ? event.data.text()
                : "New signal"
        };
    }

    const title =
        data.title ||
        "🟢 XAU/USD Pro Sniper";

    const options = {

        body:
            data.body ||
            "New XAU/USD signal",

        icon:
            data.icon ||
            "/icon.png",

        badge:
            "/icon.png",

        tag:
            "xau-signal",

        renotify:
            true,

        data: {
            url: "/"
        }
    };

    event.waitUntil(
        self.registration.showNotification(
            title,
            options
        )
    );

});


/* =========================================================
   NOTIFICATION CLICK
========================================================= */

self.addEventListener(
    "notificationclick",
    event => {

        event.notification.close();

        event.waitUntil(

            clients.matchAll({
                type: "window",
                includeUncontrolled: true
            }).then(clientList => {

                for(const client of clientList){

                    if("focus" in client){

                        return client.focus();

                    }

                }

                if(clients.openWindow){

                    return clients.openWindow("/");

                }

            })

        );

    }
);
