/**
 * The service worker: freshness, and offline play.
 *
 * GitHub Pages serves everything with a ten-minute cache lifetime, so an open
 * tab -- and often a plain reload -- can keep running a build that has already
 * been replaced, with each module expiring on its own stagger. That is the lag
 * between a deploy and the game actually changing.
 *
 * So every request for this origin goes to the network with the HTTP cache
 * stepped over entirely, and what comes back is kept only as a fallback for
 * when the network is not there at all. The trade is one round trip per file
 * against ever wondering which version you are playing -- and the fallback
 * means the city is playable on a train, which the old arrangement never was.
 *
 * The page registers this with the version in the URL, so a release is a new
 * script to the browser and installs at once rather than waiting on its own
 * update check. Registration also passes `updateViaCache: 'none'`, so this
 * file is never itself served from the cache it exists to bypass.
 */

const CACHE = 'metropolis-offline';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop anything an earlier naming scheme left behind.
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(freshest(request));
});

async function freshest(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok && response.type === 'basic') {
      // Keep a copy for the offline case. A failure here -- storage full, or
      // blocked in a private window -- must not cost the player the response.
      try {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      } catch { /* not worth failing the page over */ }
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // A reload while offline asks for the page itself; any cached copy of the
    // shell will do, and the modules behind it are cached alongside it.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./') || await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
