const CACHE_NAME="xau-sniper-v5";
self.addEventListener("install",e=>e.waitUntil(self.skipWaiting()));
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));

self.addEventListener("push",event=>{
  let data={};
  try{ data=event.data?event.data.json():{}; }catch{
    data={title:"XAU/USD Pro Sniper",body:event.data?event.data.text():"New signal"};
  }
  const title=data.title||"XAU/USD Pro Sniper";
  event.waitUntil(self.registration.showNotification(title,{
    body:data.body||"New XAU/USD signal",
    icon:data.icon||"/icon.png",
    badge:data.badge||"/icon.png",
    tag:data.tag||"xau-signal",
    renotify:true,
    requireInteraction:false,
    data:{url:data?.data?.url||data.url||"/"}
  }));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification?.data?.url||"/";
  event.waitUntil(
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const c of list){
        if("focus"in c){ c.focus(); if("navigate"in c)c.navigate(url); return; }
      }
      if(self.clients.openWindow)return self.clients.openWindow(url);
    })
  );
});
