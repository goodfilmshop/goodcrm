const CACHE_NAME = 'good-crm-shell-v3';
const APP_SHELL = [
  '/manifest.webmanifest',
  '/assets/good-crm-icon-192.png',
  '/assets/good-crm-icon-512.png',
  '/assets/good-crm-icon-180.png',
  '/assets/good-crm-favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation and API calls always need a fresh server decision. In
  // particular, do not make an old cached CRM shell available after a country
  // restriction or authentication check fails.
  if (event.request.mode === 'navigate' || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
