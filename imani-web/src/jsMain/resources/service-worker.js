/**
 * Service Worker for Imani Wallet PWA
 *
 * Provides offline support and caching for better performance.
 *
 * Strategy:
 * - Cache-first for static assets (HTML, CSS, JS, images)
 * - Network-first for API calls (with fallback to cache)
 * - Runtime caching for dynamic content
 */

const CACHE_NAME = 'imani-wallet-v1.0.0';
const RUNTIME_CACHE = 'imani-wallet-runtime-v1';

// Assets to cache immediately on install
const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/imani-wallet.js',
    '/skiko.wasm',
    // Add other critical assets here
];

// Install event - precache critical assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Precaching assets');
            return cache.addAll(PRECACHE_ASSETS);
        }).then(() => {
            console.log('[SW] Precaching complete');
            return self.skipWaiting(); // Activate immediately
        })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');

    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            console.log('[SW] Activation complete');
            return self.clients.claim(); // Take control immediately
        })
    );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and other non-http(s) requests
    if (!request.url.startsWith('http')) {
        return;
    }

    // Handle different types of requests
    if (isStaticAsset(url)) {
        // Cache-first strategy for static assets
        event.respondWith(cacheFirst(request));
    } else if (isApiRequest(url)) {
        // Network-first strategy for API calls
        event.respondWith(networkFirst(request));
    } else {
        // Default: network-first with cache fallback
        event.respondWith(networkFirst(request));
    }
});

/**
 * Cache-first strategy: Try cache, then network
 */
async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    if (cached) {
        console.log('[SW] Serving from cache:', request.url);
        return cached;
    }

    console.log('[SW] Fetching from network:', request.url);
    try {
        const response = await fetch(request);

        // Cache successful responses
        if (response.ok) {
            cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        console.error('[SW] Fetch failed:', error);
        // Return offline page or fallback
        return new Response('Offline - resource not cached', {
            status: 503,
            statusText: 'Service Unavailable',
        });
    }
}

/**
 * Network-first strategy: Try network, then cache
 */
async function networkFirst(request) {
    const cache = await caches.open(RUNTIME_CACHE);

    try {
        console.log('[SW] Fetching from network:', request.url);
        const response = await fetch(request);

        // Cache successful responses
        if (response.ok) {
            cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        console.log('[SW] Network failed, trying cache:', request.url);
        const cached = await cache.match(request);

        if (cached) {
            return cached;
        }

        console.error('[SW] No cache available:', error);
        return new Response('Offline - no cached data', {
            status: 503,
            statusText: 'Service Unavailable',
        });
    }
}

/**
 * Check if request is for a static asset
 */
function isStaticAsset(url) {
    const staticExtensions = ['.js', '.css', '.wasm', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'];
    return staticExtensions.some(ext => url.pathname.endsWith(ext));
}

/**
 * Check if request is an API call
 */
function isApiRequest(url) {
    // Check for mint API calls
    if (url.hostname.includes('cashu.space')) {
        return true;
    }

    // Check for Nostr relay connections (WebSocket)
    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
        return true;
    }

    return false;
}

// Message handling for cache management
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => caches.delete(cacheName))
                );
            })
        );
    }
});
