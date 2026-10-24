import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { ActionRow, AgentRow, AgentState, Snapshot } from '../types'
import { formatDuration, renderGraph, shortTool } from './graph'

type Engine = Parameters<Hook<'tool.call'>>[0]

const PANE = 'agent-viewer'
const TITLE = 'Agents'
const MAIN = 'main'

const agents = atom({ plugin: 'agent-viewer', key: 'agents' } as const, [])
const actions = atom({ plugin: 'agent-viewer', key: 'actions' } as const, [])
const isHidingDone = atom({ plugin: 'agent-viewer', key: 'isHidingDone' } as const, false)
const frozen = atom({ plugin: 'agent-viewer', key: 'frozen' } as const, null)
const zoom = atom({ plugin: 'agent-viewer', key: 'zoom' } as const, 1)
const liveUrl = atom({ plugin: 'agent-viewer', key: 'liveUrl' } as const, null)
const liveError = atom({ plugin: 'agent-viewer', key: 'liveError' } as const, null)

// Vue interactive : un petit serveur local (server/server.mjs) reçoit l'état et le pousse à la page web
let server: { port: number; token: string } | null = null
let isDirty = true
let isPushing = false
let lastPushAt = 0

// Taille d'une cellule de police du panneau desktop, en pixels (estimation)
const CELL_W = 7.6
const CELL_H = 18
const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2]
const stepZoom = (z: number, dir: 1 | -1) => {
  const i = ZOOM_STEPS.findIndex(s => s >= z - 0.001)
  const at = i === -1 ? ZOOM_STEPS.length - 1 : i

  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))] ?? 1
}

const ICON: Record<AgentState, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }
const COLOR: Record<AgentState, string> = {
  running: 'warning',
  done: 'success',
  failed: 'error',
  stopped: 'inactive',
}
const LABEL: Record<AgentState, string> = {
  running: 'en cours',
  done: 'terminé',
  failed: 'échec',
  stopped: 'arrêté',
}

// Les arguments les plus parlants pour résumer un appel d'outil
const ARG_KEYS = ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'path', 'skill', 'prompt']

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const describe = (e: { tool: string }) => {
  const args = e as unknown as Record<string, unknown>
  const key = ARG_KEYS.find(k => typeof args[k] === 'string' && (args[k] as string).trim() !== '')
  const detail = key ? clip(String(args[key]).replace(/\s+/g, ' ').trim(), 160) : ''
  const tool = shortTool(e.tool)

  return { detail, label: detail ? `${tool} · ${clip(detail, 60)}` : tool }
}

const mainRow = (now: number): AgentRow => ({
  id: MAIN,
  type: 'principal',
  description: 'Agent principal',
  isBackground: false,
  state: 'done',
  startedAt: now,
  toolCount: 0,
  recentTools: [],
})

// Modifie la ligne d'un agent (crée celle du principal si besoin)
async function patch($: Engine, id: string, fn: (row: AgentRow) => AgentRow) {
  const now = await $.clock.now()
  await update($, agents, list => {
    const has = list.some(row => row.id === id)
    const base = has ? list : id === MAIN ? [mainRow(now), ...list] : list

    return base.map(row => (row.id === id ? fn(row) : row))
  })
  isDirty = true
}

// Lance le serveur local et lit son adresse ; la boucle dure autant que le serveur
async function startServer($: Engine) {
  if (server) return
  await update($, liveError, () => null)
  let buffer = ''
  let errors = ''
  try {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/server/server.mjs`] })
    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        errors = (errors + chunk.text).slice(-400)
        continue
      }
      buffer += chunk.text
      let end = buffer.indexOf('\n')
      while (end >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        const ready = /^READY (\d+) ([0-9a-f]{32})$/.exec(line)
        if (ready) {
          server = { port: Number(ready[1]), token: ready[2] ?? '' }
          isDirty = true
          await update($, liveUrl, () => `http://127.0.0.1:${ready[1]}/`)
        }
        end = buffer.indexOf('\n')
      }
    }
    if (errors) await update($, liveError, () => errors.trim())
  } catch (err) {
    await update($, liveError, () => `Impossible de lancer « node » : ${String(err)}`)
  }
  server = null
  await update($, liveUrl, () => null)
}

// Envoie l'état au serveur local quand il a changé (au plus ~4 fois par seconde), ou un signe de vie
async function push($: Engine) {
  if (!server || isPushing) return
  const now = await $.clock.now()
  const isHeartbeat = now - lastPushAt > 60_000
  if (!isDirty && !isHeartbeat) return
  isPushing = true
  isDirty = false
  lastPushAt = now
  try {
    const body = JSON.stringify({ agents: await read($, agents), actions: await read($, actions), now })
    const res = await $.http.fetch(`http://127.0.0.1:${server.port}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': server.token },
      body,
    })
    if (!res.ok) isDirty = true
  } catch {
    isDirty = true
  } finally {
    isPushing = false
  }
}

// Fige ou relance le graphe
async function toggleFreeze($: Engine) {
  const current = await read($, frozen)
  if (current) {
    await update($, frozen, () => null)

    return
  }
  const snapshot: Snapshot = { agents: await read($, agents), actions: await read($, actions), at: await $.clock.now() }
  await update($, frozen, () => snapshot)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'voir-agents',
      description: 'Ouvre le panneau qui montre quel agent fait quelle tâche',
    })
    await $.command.register({
      name: 'graphe-agents',
      description: "Donne l'adresse de la vue interactive des agents (zoom, déplacement, bulles)",
    })
    void $.ui.open({ id: PANE, title: TITLE })

    // Vue interactive : serveur local + envoi de l'état à chaque changement
    void startServer($)
    $.clock.every(250, () => void push($))

    return next(e)
  })

  on('command.run', { command: 'voir-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panneau Agents ouvert.' }
  })

  on('command.run', { command: 'graphe-agents' }, async $ => {
    const url = await read($, liveUrl)
    if (!url) {
      void startServer($)
      const error = await read($, liveError)

      return { text: error ? `La vue interactive n'a pas pu démarrer : ${error}` : 'La vue interactive démarre, relance la commande dans un instant.' }
    }

    return { text: `Vue interactive des agents : ${url}\nOuvre-la dans le navigateur à côté du chat (ou dans ton navigateur).` }
  })

  // L'agent principal démarre un tour à chaque message envoyé
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await patch($, MAIN, row => ({ ...row, state: 'running', startedAt: now, endedAt: undefined }))

    return next(e)
  })

  // Un sous-agent est lancé : on l'ajoute avec sa tâche
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId || e.resume) {
      if (e.resume) await patch($, e.resume.agentId, row => ({ ...row, state: 'running', endedAt: undefined }))

      return result
    }

    const now = await $.clock.now()
    const row: AgentRow = {
      id: result.agentId,
      type: e.fork ? 'fork' : e.subagentType,
      description: e.description || clip(e.prompt.replace(/\s+/g, ' '), 60),
      model: result.model,
      parentId: e.parentAgentId ?? MAIN,
      isBackground: e.background,
      state: 'running',
      startedAt: now,
      toolCount: 0,
      recentTools: [],
    }
    await update($, agents, list => [...list.filter(one => one.id !== row.id), row].slice(-60))
    isDirty = true

    return result
  })

  // Chaque appel d'outil est rattaché à l'agent qui le fait, et devient un nœud « action »
  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const { detail, label } = describe(e)
    const startedAt = await $.clock.now()
    const action: ActionRow = { id: e.tool_use_id, agentId: id, tool: e.tool, detail, startedAt }
    await update($, actions, list => [...list, action].slice(-150))
    await patch($, id, row => ({
      ...row,
      state: 'running',
      toolCount: row.toolCount + 1,
      currentTool: label,
      currentToolId: e.tool_use_id,
      currentToolName: e.tool,
    }))

    let isError = false
    try {
      const ran = await next(e)
      isError = !!(ran.deny || ran.isError)

      return ran
    } catch (err) {
      isError = true
      throw err
    } finally {
      const endedAt = await $.clock.now()
      await update($, actions, list => list.map(one => (one.id === action.id ? { ...one, endedAt, isError } : one)))
      await patch($, id, row => {
        const isMine = row.currentToolId === e.tool_use_id

        return {
          ...row,
          currentTool: isMine ? undefined : row.currentTool,
          currentToolId: isMine ? undefined : row.currentToolId,
          currentToolName: isMine ? undefined : row.currentToolName,
          recentTools: [...row.recentTools, label].slice(-3),
        }
      })
    }
  })

  // Fin d'un tour : le sous-agent (ou le principal) a fini
  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const state: AgentState = e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
    await patch($, e.agentId ?? MAIN, row => ({
      ...row,
      state,
      endedAt: now,
      currentTool: undefined,
      currentToolId: undefined,
      currentToolName: undefined,
    }))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const hideDone = await read($, isHidingDone)
    const snapshot = await read($, frozen)
    // Figé : on ne lit pas l'état en direct, donc le dessin ne bouge plus
    const list = snapshot ? snapshot.agents : await read($, agents)
    const acts = snapshot ? snapshot.actions : await read($, actions)
    const now = snapshot ? snapshot.at : await $.clock.now()

    const subs = list.filter(row => row.id !== MAIN)
    const running = subs.filter(row => row.state === 'running').length
    const url = await read($, liveUrl)
    const urlError = await read($, liveError)

    const liveRow = url ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color="success">●</Text>
        <Text dimColor>Vue interactive (zoom, déplacement, bulles) :</Text>
        <Text weight="semibold">{url}</Text>
      </Box>
    ) : (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Text color={urlError ? 'error' : 'warning'}>●</Text>
        <Text dimColor>{urlError ? `Vue interactive arrêtée : ${clip(urlError, 120)}` : 'Vue interactive : démarrage…'}</Text>
        {urlError && <Button key="restart" label="Relancer" onPress={() => startServer($)} />}
      </Box>
    )

    const toolbar = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text dimColor>
          {snapshot ? 'Figé · ' : ''}
          {running} actif{running > 1 ? 's' : ''} · {subs.length} sous-agent{subs.length > 1 ? 's' : ''}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="freeze"
            label={snapshot ? 'Reprendre le direct' : 'Figer'}
            variant={snapshot ? 'primary' : 'secondary'}
            onPress={() => toggleFreeze($)}
          />
          <Button
            key="toggle"
            label={hideDone ? 'Tout afficher' : 'Masquer terminés'}
            onPress={() => update($, isHidingDone, v => !v)}
          />
          <Button
            key="clear"
            label="Effacer"
            onPress={async () => {
              const kept = (await read($, agents)).filter(row => row.state === 'running' || row.id === MAIN)
              const ids = new Set(kept.filter(row => row.id !== MAIN).map(row => row.id))
              await update($, agents, () => kept)
              await update($, actions, l => l.filter(a => ids.has(a.agentId) || a.endedAt === undefined))
              await update($, frozen, () => null)
              isDirty = true
            }}
          />
        </Box>
      </Box>
    )

    // Desktop (et toute surface qui sait dessiner du SVG) : le graphe de nœuds
    if ('Svg' in ui) {
      const { Svg } = ui
      const z = await read($, zoom)
      // Le cadre interactif n'a pas de taille par lui-même : on la calcule depuis les cellules du panneau
      const cols = e.props.bodyColumns || 80
      const rows = Math.max(12, (e.props.scroll?.bodyRows || 40) - 4)
      const pixelWidth = Math.round(Math.max(320, cols * CELL_W - 8) * z)
      const pixelHeight = Math.round(Math.min(2400, Math.max(260, rows * CELL_H)) * z)
      // Unités du dessin un peu plus grandes que les pixels, pour garder des textes lisibles
      const width = Math.round(Math.min(1400, Math.max(700, pixelWidth * 1.3)))
      const height = Math.round(width * (pixelHeight / pixelWidth))
      const source = renderGraph({ agents: list, actions: acts, now, width, height, pixelWidth, pixelHeight, hideDone })

      return (
        <Box flexDirection="column" gap={1}>
          {toolbar}
          {liveRow}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>Taille</Text>
            <Button key="zoom-out" label="−" onPress={() => update($, zoom, v => stepZoom(v, -1))} />
            <Text dimColor>{Math.round(z * 100)} %</Text>
            <Button key="zoom-in" label="+" onPress={() => update($, zoom, v => stepZoom(v, 1))} />
          </Box>
          <Svg
            source={source}
            isInteractive
            width={pixelWidth}
            height={pixelHeight}
            alt={`Graphe des agents : ${running} actifs, ${subs.length} sous-agents, ${acts.length} actions`}
          />
        </Box>
      )
    }

    // Terminal : la liste en arbre
    const ordered: { row: AgentRow; depth: number }[] = []
    const ids = new Set(list.map(row => row.id))
    const walk = (parentId: string | undefined, depth: number) => {
      for (const row of list) {
        const parent = row.id === MAIN ? undefined : row.parentId && ids.has(row.parentId) ? row.parentId : MAIN
        if (parent !== parentId || (row.id !== MAIN && parentId === undefined)) continue
        ordered.push({ row, depth })
        if (depth < 6) walk(row.id, depth + 1)
      }
    }
    walk(undefined, 0)
    for (const row of list) if (!ordered.some(o => o.row.id === row.id)) ordered.push({ row, depth: 0 })
    const shown = ordered.filter(({ row }) => !hideDone || row.state === 'running' || row.id === MAIN)

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {liveRow}
        {subs.length === 0 && (
          <Text dimColor>Aucun sous-agent pour l'instant. Ils apparaîtront ici dès leur lancement.</Text>
        )}
        {shown.map(({ row, depth }) => {
          const elapsed = formatDuration((row.endedAt ?? now) - row.startedAt)
          const indent = '  '.repeat(depth) + (depth > 0 ? '└ ' : '')

          return (
            <Box key={`agent-${row.id}`} flexDirection="column">
              <Text>
                <Text dimColor>{indent}</Text>
                <Text color={COLOR[row.state]}>{ICON[row.state]} </Text>
                <Text weight="semibold">{row.description}</Text>
              </Text>
              <Text dimColor>
                {'  '.repeat(depth + 1)}
                {row.type}
                {row.model ? ` · ${row.model}` : ''}
                {row.isBackground ? ' · arrière-plan' : ''} · {LABEL[row.state]} · {elapsed} · {row.toolCount} outil
                {row.toolCount > 1 ? 's' : ''}
              </Text>
              {row.currentTool && (
                <Text color="claude">
                  {'  '.repeat(depth + 1)}→ {row.currentTool}
                </Text>
              )}
              {!row.currentTool && row.state === 'running' && row.recentTools.length > 0 && (
                <Text dimColor>
                  {'  '.repeat(depth + 1)}dernier : {row.recentTools[row.recentTools.length - 1]}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
