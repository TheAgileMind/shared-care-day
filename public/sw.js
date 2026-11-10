const CACHE_PREFIX = 'shared-care-day-pwa-static-'
// Bump this version when the generic offline page or icons change.
const CACHE_NAME = `${CACHE_PREFIX}v1`
const PUBLIC_ASSETS = [
  ['/offline.html', 'text/html'],
  ['/icons/app-192.png', 'image/png'],
  ['/icons/app-512.png', 'image/png'],
  ['/icons/apple-touch-icon.png', 'image/png'],
]

// Only generic public assets enter Cache Storage. Never cache app HTML or API data.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await Promise.all(PUBLIC_ASSETS.map(async ([path, contentType]) => {
      const response = await fetch(new Request(path, {
        credentials: 'omit', redirect: 'error', cache: 'reload',
      }))
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith(contentType)) {
        throw new Error('Public offline asset unavailable')
      }
      await cache.put(path, response)
    }))
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  // This single-page app enters at /. All API/auth routes and writes pass through.
  if (request.method !== 'GET' || request.mode !== 'navigate'
    || url.origin !== self.location.origin || url.pathname !== '/') return

  event.respondWith((async () => {
    try {
      return await fetch(request, { cache: 'no-store' })
    } catch {
      const cache = await caches.open(CACHE_NAME)
      return await cache.match('/offline.html') || Response.error()
    }
  })())
})
