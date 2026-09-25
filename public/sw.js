const CACHE="folio-shell-v2";
self.addEventListener("install",event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/offline.html","/favicon.svg"])))})
self.addEventListener("activate",event=>event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("folio-")&&k!==CACHE).map(k=>caches.delete(k))))])));
self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(url.origin===self.location.origin&&url.pathname.startsWith("/_next/static/")){event.respondWith(fetch(event.request,{cache:"no-store"}));return}if(event.request.mode==="navigate")event.respondWith(fetch(event.request,{cache:"no-store"}).catch(()=>caches.match("/offline.html")));});
