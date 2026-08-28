self.addEventListener("push", event => {

    let data = {};

    try {
        data = event.data
            ? event.data.json()
            : {};
    } catch(e) {}

    const title =
        data.title ||
        "XAU/USD Signal";

    const options = {

        body:
            data.body ||
            "New XAU/USD signal detected.",

        icon:
            "/icon-192.png",

        badge:
            "/icon-192.png",

        tag:
            data.tag ||
            "xauusd-signal",

        renotify:
            true,

        data:{
            url:
                data.url ||
                "/"
        }

    };

    event.waitUntil(
        self.registration.showNotification(
            title,
            options
        )
    );

});


self.addEventListener(
    "notificationclick",
    event => {

        event.notification.close();

        const url =
            event.notification.data?.url ||
            "/";

        event.waitUntil(

            clients
                .matchAll({
                    type:"window",
                    includeUncontrolled:true
                })
                .then(list => {

                    for(
                        const client of list
                    ){

                        if(
                            "focus" in client
                        ){

                            return client.focus();

                        }

                    }

                    return clients.openWindow(url);

                })

        );

    }
);
