// Манифест отключения service worker.
// Удаляет все свои кэши и снимает регистрацию — сайт работает без SW,
// поэтому каждая новая версия подхватывается мгновенно.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) => c.navigate(c.url)))
  );
});

self.addEventListener('fetch', () => {
  // Ничего не перехватываем — сеть работает напрямую.
});