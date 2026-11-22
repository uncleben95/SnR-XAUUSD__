const CACHE_NAME = "xau-sniper-v5";

self.addEventListener("install", event => {
  self.skipWaiting();
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

self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: "XAU/USD Pro Sniper",
      body: event.data
        ? event.data.text()
        : "New XAU/USD signal"
    };
  }

  const title =
    data.title || "XAU/USD Pro Sniper";

  const options = {
    body:
      data.body || "New XAU/USD signal",

    icon:
      data.icon || "/icon.png",

    badge:
      data.badge || "/icon.png",

    tag:
      data.tag || "xau-signal",

    renotify: true,

    requireInteraction: false,

    data: {
      url:
        (data.data && data.data.url) ||
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

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const url =
    (event.notification.data &&
      event.notification.data.url) ||
    "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(clientList => {

      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) {
            client.navigate(url);
          }

          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
