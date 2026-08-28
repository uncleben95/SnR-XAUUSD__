self.addEventListener("push", event => {
    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {}

    event.waitUntil(
        self.registration.showNotification(
            data.title || "XAU/USD Signal",
            {
                body: data.body || "New signal detected.",
                icon: "/icon-192.png",
                badge: "/icon-192.png",
                tag: data.tag || "xauusd-signal",
                renotify: true,
                data: {
                    url: data.url || "/"
                }
            }
        )
    );
});

self.addEventListener("notificationclick", event => {

    event.notification.close();

    const url =
        event.notification.data?.url || "/";

    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true
        }).then(list => {

            for (const client of list) {
                if ("focus" in client) {
                    return client.focus();
                }
            }

            return clients.openWindow(url);
        })
    );
});
