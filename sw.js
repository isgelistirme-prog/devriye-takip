/**
 * KARAKUŞ SW (Service Worker) - v9.0
 * Özellikler: Offline Cache, Background Sync, Network Fallback
 */
const CACHE_NAME = 'Karakuş-v9';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './logo.png',
  'https://unpkg.com/html5-qrcode'
];

// Install Event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    })
  );
  self.clients.claim();
});

// Fetch Event (Cache First)
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cachedRes => {
      return cachedRes || fetch(event.request).then(fetchRes => {
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request.url, fetchRes.clone());
          return fetchRes;
        });
      });
    })
  );
});

// Background Sync (Kuyruktaki işlemleri tetikleme)
self.addEventListener('sync', event => {
  if (event.tag === 'karakus-sync') {
    event.waitUntil(
      // Ana uygulamayı uyandır ve kuyruğu işlemesini sağla
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => {
          client.postMessage({ action: 'triggerQueueProcess' });
        });
      })
    );
  }
});

// Message Handler (App'ten gelen mesajları dinle)
self.addEventListener('message', event => {
  if (event.data && event.data.action === 'registerSync') {
    self.registration.sync.register('karakus-sync')
      .then(() => console.log('Background Sync registered'))
      .catch(err => console.warn('Background Sync not supported:', err));
  }
});
