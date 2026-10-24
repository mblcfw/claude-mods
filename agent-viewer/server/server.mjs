// Petit serveur local de la vue interactive des agents.
// - n'écoute que sur 127.0.0.1 et refuse tout autre nom d'hôte (protection contre le DNS rebinding)
// - GET /         : la page du graphe
// - GET /events   : flux en direct (Server-Sent Events) de l'état
// - POST /state   : le mod envoie l'état, avec le jeton secret affiché au démarrage
// Il s'arrête tout seul s'il ne reçoit plus rien du mod pendant 15 minutes.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const FIRST_PORT = 47321
const LAST_PORT = 47340
const IDLE_MS = 15 * 60 * 1000
const MAX_BODY = 8 * 1024 * 1024

const token = randomBytes(16).toString('hex')
const pageUrl = new URL('../web/graph.html', import.meta.url)
let state = { agents: [], actions: [], now: Date.now() }
let lastPost = Date.now()
const clients = new Set()
let port = 0

const send = (res, status, body = '', type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

const broadcast = () => {
  const frame = `data: ${JSON.stringify(state)}\n\n`
  for (const res of clients) res.write(frame)
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, 'Hôte refusé')

  const { pathname } = new URL(req.url || '/', 'http://127.0.0.1')

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      return send(res, 200, await readFile(pageUrl), 'text/html; charset=utf-8')
    } catch {
      return send(res, 500, 'Page du graphe introuvable')
    }
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`retry: 1500\ndata: ${JSON.stringify(state)}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'POST' && pathname === '/state') {
    if (req.headers['x-token'] !== token) return send(res, 403, 'Jeton invalide')
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const next = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!next || !Array.isArray(next.agents) || !Array.isArray(next.actions)) return send(res, 400, 'État invalide')
        state = next
        lastPost = Date.now()
        broadcast()
        send(res, 204)
      } catch {
        send(res, 400, 'JSON invalide')
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/ping') {
    if (req.headers['x-token'] !== token) return send(res, 403, 'Jeton invalide')
    lastPost = Date.now()
    return send(res, 204)
  }

  send(res, 404, 'Introuvable')
})

// Garde les flux ouverts et s'arrête si le mod a disparu
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
  if (Date.now() - lastPost > IDLE_MS) process.exit(0)
}, 15_000).unref()

// Le port habituel peut être encore pris un instant par l'instance précédente (rechargement du mod) :
// on le réessaie quelques fois avant de passer au suivant.
const listen = (p, triesLeft) => {
  server.once('error', err => {
    if (err.code !== 'EADDRINUSE') throw err
    if (triesLeft > 0) setTimeout(() => listen(p, triesLeft - 1), 250)
    else if (p < LAST_PORT) listen(p + 1, 0)
    else {
      console.error('Aucun port libre entre', FIRST_PORT, 'et', LAST_PORT)
      process.exit(1)
    }
  })
  server.listen(p, '127.0.0.1', () => {
    port = p
    process.stdout.write(`READY ${port} ${token}\n`)
  })
}
listen(FIRST_PORT, 12)
