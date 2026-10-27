// Hub local de la vue interactive des agents, partagé par toutes les sessions Claude Code qui ont le mod.
//
//   node server.mjs --ensure   trouve le hub qui tourne, ou en lance un (détaché), puis affiche « HUB <port> »
//   node server.mjs --hub      le hub lui-même
//
// Le hub :
// - n'écoute que sur 127.0.0.1 et refuse tout autre nom d'hôte (protection contre le DNS rebinding)
// - GET /          la page du graphe          GET /events  flux en direct (Server-Sent Events)
// - GET /hub-info  « je suis bien le hub »
// - POST /state    une session envoie son état     POST /end  une session se termine
//   Les POST exigent l'en-tête x-agent-viewer et refusent toute origine de page web étrangère :
//   un site ouvert dans le navigateur ne peut donc rien y envoyer.
// - s'arrête seul après 15 minutes sans aucune session ni aucune page ouverte.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const APP = 'agent-viewer-hub'
const VERSION = 4
const FIRST_PORT = 47321
const LAST_PORT = 47340
const IDLE_MS = 15 * 60 * 1000
const LIVE_MS = 70 * 1000
const FORGET_MS = 30 * 60 * 1000
const MAX_BODY = 8 * 1024 * 1024
const MAX_CHAT = 4000

// ---------- Recherche du hub ----------

function hubInfo(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/hub-info', timeout: 600 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => { body += d })
      res.on('end', () => {
        try {
          const info = JSON.parse(body)
          // Un hub d'une version plus ancienne ne compte pas : on en démarre un à jour à côté
          resolve(info && info.app === APP && (info.version || 0) >= VERSION ? info : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

async function findHub() {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (await hubInfo(port)) return port
  }
  return 0
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function ensure() {
  let port = await findHub()
  if (!port) {
    // Lancé détaché : le hub survit à la session qui l'a démarré, et s'arrête seul quand plus personne ne l'utilise
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hub'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    for (let i = 0; i < 40 && !port; i++) {
      await sleep(150)
      port = await findHub()
    }
  }
  if (!port) {
    console.error('Le hub ne répond pas (ports ' + FIRST_PORT + ' à ' + LAST_PORT + ').')
    process.exit(1)
  }
  process.stdout.write(`HUB ${port}\n`)
}

// ---------- Le hub ----------

function hub() {
  const pageUrl = new URL('../web/graph.html', import.meta.url)
  /** id de session -> { id, title, cwd, agents, actions, lastSeen, ended } */
  const sessions = new Map()
  const clients = new Set()
  /** id de session -> messages écrits dans la page, en attente que la session les relève */
  const inboxes = new Map()
  let lastActivity = Date.now()
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

  const snapshot = () => {
    const now = Date.now()
    return JSON.stringify({
      now,
      sessions: [...sessions.values()].map(s => ({ ...s, isLive: !s.ended && now - s.lastSeen < LIVE_MS })),
    })
  }
  const broadcast = () => {
    const frame = `data: ${snapshot()}\n\n`
    for (const res of clients) res.write(frame)
  }

  const isAllowedPost = req => {
    if (req.headers['x-agent-viewer'] !== '1') return false
    const origin = req.headers.origin
    return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  }

  const readJson = (req, res, then) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        then(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        send(res, 400, 'JSON invalide')
      }
    })
  }

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '')
    if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, 'Hôte refusé')
    const { pathname } = new URL(req.url || '/', 'http://127.0.0.1')

    if (req.method === 'GET' && pathname === '/hub-info') {
      return send(res, 200, JSON.stringify({ app: APP, version: VERSION, sessions: sessions.size }), 'application/json')
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        return send(res, 200, await readFile(pageUrl), 'text/html; charset=utf-8')
      } catch {
        return send(res, 500, 'Page du graphe introuvable')
      }
    }
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`retry: 1500\ndata: ${snapshot()}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && pathname === '/state') {
      if (!isAllowedPost(req)) return send(res, 403, 'Refusé')
      return readJson(req, res, body => {
        const s = body && body.session
        if (!s || typeof s.id !== 'string' || !Array.isArray(body.agents) || !Array.isArray(body.actions)) {
          return send(res, 400, 'État invalide')
        }
        sessions.set(s.id, {
          id: s.id,
          title: typeof s.title === 'string' ? s.title : '',
          cwd: typeof s.cwd === 'string' ? s.cwd : '',
          agents: body.agents,
          actions: body.actions,
          request: body.request && typeof body.request === 'object' ? body.request : null,
          chat: Array.isArray(body.chat) ? body.chat.slice(-200) : [],
          final: body.final && typeof body.final === 'object' ? body.final : null,
          lastSeen: Date.now(),
          ended: false,
        })
        lastActivity = Date.now()
        broadcast()
        send(res, 204)
      })
    }
    // La page envoie un message à un agent : il attend dans la boîte de la session
    if (req.method === 'POST' && pathname === '/chat') {
      if (!isAllowedPost(req)) return send(res, 403, 'Refusé')
      return readJson(req, res, body => {
        const { sessionId, agentId, text } = body || {}
        if (typeof sessionId !== 'string' || typeof agentId !== 'string' || typeof text !== 'string' || !text.trim()) return send(res, 400, 'Message invalide')
        if (!sessions.has(sessionId)) return send(res, 404, 'Session inconnue')
        if (text.length > MAX_CHAT) return send(res, 413, 'Message trop long')
        const list = inboxes.get(sessionId) || []
        const msg = { id: randomUUID(), agentId, text: text.trim(), at: Date.now() }
        list.push(msg)
        inboxes.set(sessionId, list.slice(-50))
        send(res, 200, JSON.stringify({ id: msg.id }), 'application/json')
      })
    }
    // La session relève ses messages (et seulement elle : en-tête exigé)
    if (req.method === 'GET' && pathname === '/inbox') {
      if (req.headers['x-agent-viewer'] !== '1') return send(res, 403, 'Refusé')
      const sessionId = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('session') || ''
      const list = inboxes.get(sessionId) || []
      inboxes.delete(sessionId)
      return send(res, 200, JSON.stringify(list), 'application/json')
    }
    if (req.method === 'POST' && pathname === '/end') {
      if (!isAllowedPost(req)) return send(res, 403, 'Refusé')
      return readJson(req, res, body => {
        const s = body && sessions.get(body.id)
        if (s) {
          s.ended = true
          s.agents = s.agents.map(a => (a.state === 'running' ? { ...a, state: 'stopped', currentTool: undefined, currentToolName: undefined } : a))
          broadcast()
        }
        send(res, 204)
      })
    }
    send(res, 404, 'Introuvable')
  })

  // Entretien : signe de vie aux pages, oubli des vieilles sessions, arrêt quand plus personne n'utilise le hub
  setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) if (now - s.lastSeen > FORGET_MS) sessions.delete(id)
    if (clients.size) lastActivity = Math.max(lastActivity, now)
    broadcast()
    if (now - lastActivity > IDLE_MS) process.exit(0)
  }, 15_000)

  const listen = p => {
    server.once('error', async err => {
      if (err.code !== 'EADDRINUSE') throw err
      if (await hubInfo(p)) process.exit(0)   // un autre hub vient de démarrer : on le laisse faire
      if (p < LAST_PORT) listen(p + 1)
      else process.exit(1)
    })
    server.listen(p, '127.0.0.1', () => { port = p })
  }
  listen(FIRST_PORT)
}

if (process.argv.includes('--hub')) hub()
else ensure().catch(err => {
  console.error(String(err))
  process.exit(1)
})
