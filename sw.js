/* Service worker: يخلّي البرنامج يفتح بدون نت. ملفات البرنامج نفسها network-first (التحديثات بتوصل دايمًا)،
   ومكتبات CDN والخطوط cache-first. طلبات Firebase/الداتا مبتتعدّاش من هنا (Firestore بيتولاها بتخزينه المحلي). */
const VER = 'dorosi-shell-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = ['www.gstatic.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(VER).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VER).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin === location.origin){
    e.respondWith(
      fetch(req).then(res=>{
        if(res && res.ok){ const copy = res.clone(); caches.open(VER).then(c=>c.put(req, copy)); }
        return res;
      }).catch(()=> caches.match(req, {ignoreSearch:true}).then(r=> r || (req.mode==='navigate' ? caches.match('index.html') : undefined)))
    );
  }else if(CDN.includes(url.hostname)){
    e.respondWith(
      caches.match(req).then(hit=> hit || fetch(req).then(res=>{
        if(res && (res.ok || res.type==='opaque')){ const copy = res.clone(); caches.open(VER).then(c=>c.put(req, copy)); }
        return res;
      }))
    );
  }
});
