/**
 * Service worker for the Athar dashboard PWA.
 *
 * Deliberately minimal, and deliberately narrow about what it caches:
 *
 *   - The app shell (HTML/JS/CSS) is cached so the dashboard opens instantly
 *     and survives a flaky connection to the box it is served from.
 *   - API responses are NEVER cached. They are one user's analytics, and a
 *     cache entry is readable by whoever opens the browser next. A stale
 *     dashboard is also worse than no dashboard.
 *   - The tracker script is never cached here; it is served to other origins
 *     with its own cache headers.
 */

const CACHE = 'athar-shell-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll fails atomically if any entry 404s; tolerate that rather than
      // leaving the worker permanently stuck in installing.
      .then((cache) => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/athar.js') return

  // Network-first: the dashboard should show the current build whenever it can,
  // and fall back to the cached shell only when the network is unavailable.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        // A cold deep link with no network still gets the shell, and the SPA
        // router takes it from there.
        return caches.match('/index.html')
      }),
  )
})
