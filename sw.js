// PIXORA service worker: caches the app shell only. Photos and /api responses are never cached.
const V="pixora-v2",ROOT=new URL("./",self.location).href,SHELL=[ROOT,ROOT+"manifest.webmanifest",ROOT+"config.js",ROOT+"icons/icon-192.png",ROOT+"icons/icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
 const u=new URL(e.request.url);
 if(e.request.method!=="GET"||u.origin!==location.origin)return;
 if(e.request.mode==="navigate"){e.respondWith(fetch(e.request).then(r=>{caches.open(V).then(c=>c.put(ROOT,r.clone()));return r}).catch(()=>caches.match(ROOT)));return}
 e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{if(r.ok)caches.open(V).then(x=>x.put(e.request,r.clone()));return r})));
});
