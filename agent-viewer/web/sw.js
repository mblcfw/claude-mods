// Service worker de l'appli « Agents » : garde une copie de la page et des icônes,
// pour que l'appli installée s'ouvre même quand le hub est arrêté (elle l'explique alors).
// Le direct (/events), le chat (/chat) et le reste ne sont jamais mis en cache.
const CACHE = 'agent-viewer-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return
  // Réseau d'abord : la page suit toujours la version du mod ; la copie ne sert que si le hub ne répond pas
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(url.pathname, copy))
        }
        return res
      })
      .catch(() => caches.match(url.pathname)),
  )
})
