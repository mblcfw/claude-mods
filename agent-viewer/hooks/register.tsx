import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { ActionRow, AgentRow, AgentState, ChatMessage, EngineStatus, FinalInfo, RequestInfo, TaskItem, TaskStatus } from '../types'

type Engine = Parameters<Hook<'tool.call'>>[0]

const PANE = 'agent-viewer'
const TITLE = 'Agents'
const MAIN = 'main'

const agents = atom({ plugin: 'agent-viewer', key: 'agents' } as const, [])
const actions = atom({ plugin: 'agent-viewer', key: 'actions' } as const, [])
const liveUrl = atom({ plugin: 'agent-viewer', key: 'liveUrl' } as const, null)
const liveError = atom({ plugin: 'agent-viewer', key: 'liveError' } as const, null)
const sessionTitle = atom({ plugin: 'agent-viewer', key: 'sessionTitle' } as const, null)
const request = atom({ plugin: 'agent-viewer', key: 'request' } as const, null)
const final = atom({ plugin: 'agent-viewer', key: 'final' } as const, null)
const chat = atom({ plugin: 'agent-viewer', key: 'chat' } as const, [])
let isPolling = false

// Consigne ajoutée à chaque sous-agent : tenir une liste de tâches, pour que ses % soient réels
const PROGRESS_TOOL = 'mcp__agent-viewer__progress'
const TASK_HINT =
  '\n\n(Progress tracking: before anything else, call the tool `mcp__agent-viewer__progress` with your plan as a short task list ' +
  '(2 to 6 tasks, status pending / in_progress / completed). Call it again each time a task starts or ends, ' +
  'and once more right before your final answer, with every finished task marked completed. ' +
  'The user follows your progress through it. If that tool is missing, use TodoWrite the same way.)'
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']
const asStatus = (v: unknown): TaskStatus => (TASK_STATUSES.includes(v as TaskStatus) ? (v as TaskStatus) : 'pending')
const ENGINE_STATUSES: readonly EngineStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']

// Vue interactive : un hub local (server/server.mjs), partagé par toutes les sessions qui ont le mod,
// reçoit l'état de chaque session et le pousse à la page web
let hub: { port: number } | null = null
let isDirty = true
let isPushing = false
let isEnsuring = false
let lastPushAt = 0
let lastEnsureAt = 0

// Couleur et libellé de chaque état dans le résumé du panneau (les mêmes que la vue complète)
type Shown = 'run' | 'done' | 'wait' | 'fail' | 'stopped' | 'alert'
const SHOWN: Record<Shown, { color: string; label: string; mark: string }> = {
  run: { color: 'text', label: 'en cours', mark: '●' },
  done: { color: '#86d982', label: 'terminé', mark: '✓' },
  wait: { color: '#a98cf5', label: 'en attente', mark: '◌' },
  fail: { color: '#ef5f5f', label: 'échec', mark: '✗' },
  stopped: { color: '#ef5f5f', label: 'arrêté', mark: '■' },
  alert: { color: '#ff8a3d', label: 'alerte', mark: '!' },
}
const shownOf = (a: AgentRow): Shown =>
  a.alert ? 'alert'
  : a.state === 'failed' || a.status === 'failed' ? 'fail'
  : a.state === 'stopped' || a.status === 'killed' ? 'stopped'
  : a.status === 'pending' || a.status === 'waiting' || a.status === 'idle' ? 'wait'
  : a.state === 'running' || a.status === 'running' ? 'run'
  : 'done'
// % d'un agent : tâches faites ÷ total ; rien si pas de liste, ou liste jamais mise à jour
const pctOf = (a: AgentRow): number | null => {
  const tasks = a.tasks ?? []
  if (!tasks.length) return null
  const done = tasks.filter(t => t.status === 'completed').length
  const sh = shownOf(a)
  if ((sh === 'done' || sh === 'fail' || sh === 'stopped') && (a.taskUpdates ?? 0) <= 1 && done < tasks.length) return null
  return Math.round((done / tasks.length) * 100)
}
const segBar = (p: number | null, width = 20) => {
  if (p === null) return '·'.repeat(width)
  const full = Math.round((p / 100) * width)
  return '▮'.repeat(full) + '▯'.repeat(width - full)
}
const shortTool = (tool: string) => (tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool)

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

// Met à jour la liste de tâches d'un agent
async function setTasks($: Engine, id: string, fn: (tasks: TaskItem[]) => TaskItem[]) {
  await patch($, id, row => ({ ...row, tasks: fn(row.tasks ?? []).slice(0, 40), taskUpdates: (row.taskUpdates ?? 0) + 1 }))
}

// Lit un appel d'outil de liste de tâches et l'applique à la liste de l'agent
async function trackTasks($: Engine, id: string, tool: string, args: Record<string, unknown>) {
  const list = tool === 'TodoWrite' ? args.todos : tool === PROGRESS_TOOL ? args.tasks : undefined
  if (Array.isArray(list)) {
    const todos = list as Array<Record<string, unknown>>
    await setTasks($, id, () => todos.map(t => ({ content: clip(String(t.content ?? ''), 120), status: asStatus(t.status) })))
    return
  }
  // Le plan de l'app desktop (update_plan) : une liste entière, ou « avancer / fait / commencer »
  if (/update_plan$/.test(tool)) {
    if (Array.isArray(args.items)) {
      const items = args.items as Array<Record<string, unknown>>
      await setTasks($, id, () => items.map(t => ({ content: clip(String(t.content ?? ''), 120), status: asStatus(t.status) })))
      return
    }
    await setTasks($, id, list => {
      const next = list.map(t => ({ ...t }))
      if (args.advance) {
        const cur = next.findIndex(t => t.status === 'in_progress')
        if (cur >= 0) next[cur]!.status = 'completed'
        const nxt = next.findIndex((t, i) => i > cur && t.status === 'pending')
        if (nxt >= 0) next[nxt]!.status = 'in_progress'
      }
      if (Array.isArray(args.done)) for (const n of args.done as number[]) if (next[n - 1]) next[n - 1]!.status = 'completed'
      if (typeof args.start === 'number' && next[args.start - 1]) next[args.start - 1]!.status = 'in_progress'
      return next
    })
    return
  }
  if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
    const taskId = args.taskId
    await setTasks($, id, list =>
      args.status === 'deleted'
        ? list.filter(t => t.id !== taskId)
        : list.map(t =>
            t.id === taskId
              ? { ...t, status: args.status ? asStatus(args.status) : t.status, content: typeof args.subject === 'string' ? clip(args.subject, 120) : t.content }
              : t,
          ),
    )
  }
}

// Recopie le statut de chaque boucle d'agent donné par Claude Code (en attente, terminé, échec…)
async function syncStatuses($: Engine) {
  let list: Awaited<ReturnType<Engine['agent']['list']>>
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const byId = new Map(list.map(a => [a.id, a.status]))
  let changed = false
  await update($, agents, rows =>
    rows.map(row => {
      const st = byId.get(row.id)
      if (!st || st === row.status || !ENGINE_STATUSES.includes(st)) return row
      changed = true
      return { ...row, status: st }
    }),
  )
  if (changed) isDirty = true
}

// Trouve le hub qui tourne déjà (lancé par une autre session) ou en démarre un, puis note son adresse
async function ensureHub($: Engine) {
  if (hub || isEnsuring) return
  isEnsuring = true
  lastEnsureAt = await $.clock.now()
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/server/server.mjs`, '--ensure'], { timeoutMs: 15_000 })
    const found = /HUB (\d+)/.exec(ran.stdout)
    if (ran.exitCode === 0 && found) {
      hub = { port: Number(found[1]) }
      isDirty = true
      await update($, liveError, () => null)
      await update($, liveUrl, () => `http://127.0.0.1:${found[1]}/`)
    } else {
      await update($, liveError, () => clip((ran.stderr || ran.stdout || `code ${ran.exitCode}`).trim(), 300))
    }
  } catch (err) {
    await update($, liveError, () => `Impossible de lancer « node » : ${String(err)}`)
  } finally {
    isEnsuring = false
  }
}

// Envoie l'état de cette session au hub quand il a changé (au plus ~4 fois par seconde), et un signe de vie
// toutes les 20 s. Si le hub a disparu (la page et les autres sessions continuent), on en relance un.
async function push($: Engine) {
  if (isPushing) return
  const now = await $.clock.now()
  if (!hub) {
    if (now - lastEnsureAt > 5_000) void ensureHub($)
    return
  }
  const isHeartbeat = now - lastPushAt > 20_000
  if (!isDirty && !isHeartbeat) return
  isPushing = true
  isDirty = false
  lastPushAt = now
  try {
    const session = { id: await $.session.id(), cwd: await $.session.cwd(), title: (await read($, sessionTitle)) ?? '' }
    const body = JSON.stringify({ session, agents: await read($, agents), actions: await read($, actions), request: await read($, request), final: await read($, final), chat: (await read($, chat)).slice(-200), now })
    const res = await $.http.fetch(`http://127.0.0.1:${hub.port}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-viewer': '1' },
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    hub = null
    isDirty = true
    await update($, liveUrl, () => null)
  } finally {
    isPushing = false
  }
}

// Ajoute un message au chat (gardé dans l'état de la session)
async function addChat($: Engine, msg: ChatMessage) {
  await update($, chat, list => [...list, msg].slice(-200))
  isDirty = true
}

// Relève les messages écrits dans la page et les remet à leur agent
async function pollInbox($: Engine) {
  if (!hub || isPolling) return
  isPolling = true
  try {
    const sessionId = await $.session.id()
    const res = await $.http.fetch(`http://127.0.0.1:${hub.port}/inbox?session=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-agent-viewer': '1' },
    })
    if (!res.ok) return
    const list = JSON.parse(res.text) as Array<{ id: string; agentId: string; text: string }>
    for (const m of list) {
      if (typeof m.text !== 'string' || typeof m.agentId !== 'string') continue
      const text = m.text.slice(0, 4000)
      const now = await $.clock.now()
      // Tout passe par l'agent principal, comme un message de l'utilisateur dans la session :
      // - pour lui, le texte tel quel ;
      // - pour un sous-agent, une demande de transmission : l'agent principal envoie lui-même le message
      //   avec SendMessage, sous les règles d'autorisation habituelles (le mod n'en contourne aucune).
      let prompt = text
      if (m.agentId !== MAIN) {
        const target = (await read($, agents)).find(row => row.id === m.agentId)
        const name = target ? `« ${target.description} » (${target.type}, id ${m.agentId})` : `d'id ${m.agentId}`
        prompt =
          `[Chat agent-viewer] Transmets ce message, mot pour mot, au sous-agent ${name} avec SendMessage ` +
          `(to: "${m.agentId}"), puis continue sans rien faire d'autre :\n\n${text}`
      }
      await addChat($, { id: m.id, agentId: m.agentId, from: 'user', text, at: now, status: 'queued' })
      try {
        await $.prompt.submit({ text: prompt, asUser: true })
        await update($, chat, l => l.map(c => (c.id === m.id ? { ...c, status: 'sent' as const } : c)))
      } catch (err) {
        await update($, chat, l => l.map(c => (c.id === m.id ? { ...c, status: 'failed' as const, reason: String(err) } : c)))
      }
      isDirty = true
    }
  } catch {
    // hub momentanément absent : on réessaiera
  } finally {
    isPolling = false
  }
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
    // L'outil que les agents appellent pour annoncer leur liste de tâches (leurs % viennent de là)
    await $.tool.register({
      name: 'progress',
      description:
        'Report your task list so the user can follow your progress. Call it first with your plan, then each time a task starts or ends. ' +
        'Send the whole list every time.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })

    // Vue interactive : hub partagé + envoi de l'état de cette session à chaque changement
    void ensureHub($)
    $.clock.every(250, () => void push($))
    $.clock.every(1500, () => void syncStatuses($))
    $.clock.every(1000, () => void pollInbox($))

    return next(e)
  })

  on('command.run', { command: 'voir-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panneau Agents ouvert.' }
  })

  on('command.run', { command: 'graphe-agents' }, async $ => {
    const url = await read($, liveUrl)
    if (!url) {
      void ensureHub($)
      const error = await read($, liveError)

      return { text: error ? `La vue interactive n'a pas pu démarrer : ${error}` : 'La vue interactive démarre, relance la commande dans un instant.' }
    }

    return { text: `Vue interactive des agents (toutes les sessions) : ${url}\nOuvre-la dans le navigateur à côté du chat (ou dans ton navigateur).` }
  })

  // La session se termine : le hub la marque comme terminée tout de suite
  on('session.end', async ($, e, next) => {
    if (hub) {
      try {
        await $.http.fetch(`http://127.0.0.1:${hub.port}/end`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-viewer': '1' },
          body: JSON.stringify({ id: e.sessionId }),
        })
      } catch {
        // le hub n'est plus là : rien à signaler
      }
    }

    return next(e)
  })

  // L'agent principal démarre un tour à chaque message envoyé
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    // Le premier message sert de nom à la session dans la vue de toutes les sessions
    // Seul un message tapé par la personne compte comme « Demande » (pas un rapport de sous-agent,
    // une notification de tâche, ni un relais du chat agent-viewer)
    const typed = !e.isMeta && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    const raw = e.text.replace(/\s+/g, ' ').trim()
    const text = typed && !raw.startsWith('[Chat agent-viewer]') ? raw : ''
    if (text && !text.startsWith('/') && !(await read($, sessionTitle))) {
      await update($, sessionTitle, () => clip(text, 70))
    }
    await patch($, MAIN, row => ({ ...row, state: 'running', startedAt: now, endedAt: undefined }))
    if (text && !text.startsWith('/')) {
      const req: RequestInfo = { text: clip(text, 300), at: now }
      const fin: FinalInfo = { state: 'waiting', at: now }
      await update($, request, () => req)
      await update($, final, () => fin)
    }

    return next(e)
  })

  // Un sous-agent est lancé : on l'ajoute avec sa tâche
  on('agent.spawn', async ($, e, next) => {
    // Partie du projet : l'étape du plan de l'agent principal en cours à ce moment
    const mainTasks = (await read($, agents)).find(row => row.id === MAIN)?.tasks ?? []
    const step = mainTasks.findIndex(t => t.status === 'in_progress')
    const part = step >= 0 ? `Étape ${step + 1} · ${mainTasks[step]!.content}` : undefined
    // Demande au sous-agent de tenir une liste de tâches (pas pour une reprise, un fork ou un workflow)
    const canHint = !e.resume && !e.fork && !e.workflow && !e.prompt.includes('Progress tracking:')
    const result = await next(canHint ? { ...e, prompt: e.prompt + TASK_HINT } : e)
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
      part,
      prompt: clip(e.prompt.replace(/\s+/g, ' ').trim(), 400),
      status: 'running',
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
      ...(e.tool === 'AskUserQuestion' ? { alert: 'Te pose une question', alertToolId: e.tool_use_id } : {}),
    }))
    const args = e as unknown as Record<string, unknown>
    await trackTasks($, id, e.tool, args)

    let isError = false
    try {
      const ran = await next(e)
      isError = !!(ran.deny || ran.isError)
      // TaskCreate : l'identifiant de la tâche n'existe qu'après l'appel
      if (e.tool === 'TaskCreate' && !isError) {
        const created = (ran.result as { task?: { id?: string; subject?: string } } | undefined)?.task
        const subject = typeof args.subject === 'string' ? args.subject : created?.subject ?? ''
        await setTasks($, id, list => [...list, { id: created?.id, content: clip(subject, 120), status: 'pending' }])
      }

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
          alert: row.alertToolId === e.tool_use_id ? undefined : row.alert,
          alertToolId: row.alertToolId === e.tool_use_id ? undefined : row.alertToolId,
        }
      })
    }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async () => ({ result: 'Progress recorded.' }))

  // La fenêtre d'autorisation est vraiment montrée : alerte pour l'utilisateur jusqu'à la fin de l'appel
  on('classic.PermissionRequest', async ($, e, next) => {
    await patch($, e.agent_id ?? MAIN, row => ({
      ...row,
      alert: `Attend ton autorisation : ${shortTool(e.tool_name)}`,
      alertToolId: row.currentToolId,
    }))

    return next(e)
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
      alert: undefined,
      alertToolId: undefined,
    }))
    const answer = e.answer.trim()
    if (answer) await addChat($, { id: e.turnId, agentId: e.agentId ?? MAIN, from: 'agent', text: clip(answer, 3000), at: now })
    if (!e.agentId) {
      const fin: FinalInfo = { state: state === 'done' ? 'ready' : state, text: clip(e.answer.replace(/\s+/g, ' ').trim(), 300), at: now }
      await update($, final, () => fin)
    }

    return next(e)
  })

  // Panneau du chat : un résumé simple ; la vue complète (organigramme, chat) est la page du hub
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const url = await read($, liveUrl)
    const urlError = await read($, liveError)
    const main = list.find(row => row.id === MAIN)
    const subs = list.filter(row => row.id !== MAIN)
    const steps = main?.tasks ?? []
    const stepsDone = steps.filter(t => t.status === 'completed').length
    const projectPct = steps.length ? Math.round((stepsDone / steps.length) * 100) : null
    const running = subs.filter(row => ['run', 'alert'].includes(shownOf(row))).length

    const line = (row: AgentRow, name: string) => {
      const sh = SHOWN[shownOf(row)]
      const p = pctOf(row)
      const now = row.alert ?? (shownOf(row) === 'run' ? row.currentTool : undefined)

      return (
        <Box key={`a-${row.id}`} flexDirection="column">
          <Text>
            <Text color={sh.color}>{sh.mark} </Text>
            <Text weight="semibold">{name}</Text>
            <Text dimColor> · {sh.label} · {p === null ? '—' : `${p} %`}</Text>
          </Text>
          {now && <Text color={row.alert ? SHOWN.alert.color : undefined} dimColor={!row.alert}>   → {clip(now, 80)}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {url ? (
          <Text>
            <Text color="success">● </Text>
            <Text dimColor>Vue complète (organigramme, chat) : </Text>
            <Text weight="semibold">{url}</Text>
          </Text>
        ) : (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text color={urlError ? 'error' : 'warning'}>●</Text>
            <Text dimColor>{urlError ? `Vue complète arrêtée : ${clip(urlError, 120)}` : 'Vue complète : démarrage…'}</Text>
            {urlError && <Button key="restart" label="Relancer" onPress={() => ensureHub($)} />}
          </Box>
        )}
        <Text>
          <Text dimColor>PROJET </Text>
          <Text color="success">{segBar(projectPct)}</Text>
          <Text> {projectPct === null ? '—' : `${projectPct} %`}</Text>
          <Text dimColor> · {running} agent{running > 1 ? 's' : ''} actif{running > 1 ? 's' : ''} · {subs.length} sous-agent{subs.length > 1 ? 's' : ''}</Text>
        </Text>
        <Box flexDirection="column">
          {main ? line(main, 'Agent principal') : <Text dimColor>Agent principal : pas encore de tour.</Text>}
          {subs.slice(-12).map(row => line(row, row.description))}
          {subs.length > 12 && <Text dimColor>… et {subs.length - 12} autres dans la vue complète.</Text>}
        </Box>
      </Box>
    )
  })
}
