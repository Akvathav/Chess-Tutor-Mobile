/**
 * sw.js — Chess Coach Mobile Service Worker
 * Aggressively caches all app assets for full Airplane mode operation.
 */

const CACHE_NAME = 'chess-coach-mobile-v1';

// All files to pre-cache on install
const PRECACHE_ASSETS = [
  '/game.html',
  '/style.css',
  '/game.js',
  '/engineWorker.js',
  '/manifest.json',
  '/lib/jquery-3.7.1.min.js',
  '/lib/chess.min.js',
  '/lib/chessboard-1.0.0.min.js',
  '/lib/chessboard-1.0.0.min.css',
  '/lib/stockfish.js',
  '/lib/stockfish.wasm',
  '/sounds/move.mp3',
  '/sounds/capture.mp3',
  '/sounds/good_move.mp3',
  '/sounds/blunder.mp3',
  '/sounds/siren.mp3',
  '/img/chesspieces/wikipedia/wK.png',
  '/img/chesspieces/wikipedia/wQ.png',
  '/img/chesspieces/wikipedia/wR.png',
  '/img/chesspieces/wikipedia/wB.png',
  '/img/chesspieces/wikipedia/wN.png',
  '/img/chesspieces/wikipedia/wP.png',
  '/img/chesspieces/wikipedia/bK.png',
  '/img/chesspieces/wikipedia/bQ.png',
  '/img/chesspieces/wikipedia/bR.png',
  '/img/chesspieces/wikipedia/bB.png',
  '/img/chesspieces/wikipedia/bN.png',
  '/img/chesspieces/wikipedia/bP.png',
];

// Install: pre-cache everything
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching assets');
      // Cache assets individually so one failure doesn't break everything
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] Could not cache ${url}:`, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache-first strategy (offline first)
self.addEventListener('fetch', (event) => {
  // Skip non-GET and cross-origin requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Serve from cache immediately, update in background
        const fetchUpdate = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then(cache =>
              cache.put(event.request, networkResponse.clone())
            );
          }
          return networkResponse;
        }).catch(() => {}); // Network error is fine — we have cache

        return cachedResponse;
      }

      // Not in cache: fetch from network and cache it
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
        return networkResponse;
      }).catch(() => {
        // Offline fallback for HTML pages
        if (event.request.destination === 'document') {
          return caches.match('/game.html');
        }
      });
    })
  );
});
