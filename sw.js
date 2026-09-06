const CACHE_NAME = "xau-sniper-clean-v2";

/* ===============================
   INSTALL
=============================== */

self.addEventListener("install", event => {
    self.skipWaiting();
});


/* ===============================
   ACTIVATE
=============================== */

self.addEventListener("activate", event => {

    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );

    self.clients.claim();
});


/* ===============================
   PUSH NOTIFICATION
=============================== */

self.addEventListener("push", event => {

    let data = {};

    try {

        if (event.data) {
            data = event.data.json();
        }

    } catch (error) {

        console.error(
            "Push JSON error:",
            error
        );

        data = {
            title: "XAU/USD Pro Sniper",
            body: event.data
                ? event.data.text()
                : "New signal"
        };

    }

    const title =
        data.title ||
        "🟡 XAU/USD Pro Sniper";

    const body =
        data.body ||
        "New trading signal";

    const options = {

        body: body,

        icon: data.icon ||
            "/icon.png",

        badge: data.icon ||
            "/icon.png",

        tag:
            data.tag ||
            "xau-signal",

        renotify: true,

        requireInteraction: true,

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


/* ===============================
   NOTIFICATION CLICK
=============================== */

self.addEventListener(
    "notificationclick",
    event => {

        event.notification.close();

        const url =
            event.notification?.data?.url ||
            "/";

        event.waitUntil(

            clients.matchAll({
                type: "window",
                includeUncontrolled: true
            }).then(clientList => {

                for (const client of clientList) {

                    if ("focus" in client) {

                        return client.focus();

                    }

                }

                if (clients.openWindow) {

                    return clients.openWindow(url);

                }

            })

        );

    }
);
