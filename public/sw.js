const CACHE="folio-shell-v1";
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/offline.html","/favicon.svg"]))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("folio-")&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener("fetch",event=>{if(event.request.mode==="navigate")event.respondWith(fetch(event.request).catch(()=>caches.match("/offline.html")));});
