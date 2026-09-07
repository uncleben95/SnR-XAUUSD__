const CACHE_NAME="xau-sniper-v4";
self.addEventListener("install",e=>{self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("push",event=>{
 let data={};try{data=event.data?event.data.json():{};}catch(e){data={title:"XAU/USD Pro Sniper",body:event.data?event.data.text():"New signal"};}
 const title=data.title||"🟢 XAU/USD Pro Sniper";
 event.waitUntil(self.registration.showNotification(title,{body:data.body||"New XAU/USD signal",icon:data.icon||"/icon.png",badge:data.icon||"/icon.png",tag:"xau-signal-"+Date.now(),renotify:true,data:{url:"/"}}));
});
self.addEventListener("notificationclick",event=>{
 event.notification.close();
 event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
   for(const c of list){if("focus"in c)return c.focus();}
   if(clients.openWindow)return clients.openWindow("/");
 }));
});
