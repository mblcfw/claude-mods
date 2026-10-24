// Dessine le graphe des agents en SVG : agents = gros nœuds, actions = petits nœuds autour.
// Pas de script possible dans le panneau : le survol passe par :hover, la bulle par :focus.

import type { ActionRow, AgentRow } from '../types'

export type Category = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'agent' | 'mcp' | 'other'

export const CATEGORIES: Record<Category, { label: string; color: string }> = {
  read: { label: 'Lecture', color: '#4FA3FF' },
  search: { label: 'Recherche', color: '#A970FF' },
  edit: { label: 'Écriture', color: '#FF9F43' },
  shell: { label: 'Commande', color: '#3DDC84' },
  web: { label: 'Web', color: '#22D3EE' },
  agent: { label: 'Agents', color: '#FF5FA2' },
  mcp: { label: 'Outil MCP', color: '#F7D046' },
  other: { label: 'Autre', color: '#9AA4B2' },
}

const THINKING = '#C8B6FF'
const IDLE = '#5B6475'
const FAILED = '#FF4D4F'
const MAIN = 'main'
const MAX_SVG = 125_000

export function categorize(tool: string): Category {
  if (/^(Read|NotebookRead)$/.test(tool)) return 'read'
  if (/^(Grep|Glob|ToolSearch|LS)$/.test(tool)) return 'search'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'edit'
  if (/^(Bash|PowerShell|Monitor|BashOutput|KillShell|TaskStop)$/.test(tool)) return 'shell'
  if (/^(WebFetch|WebSearch)$/.test(tool) || /browser|chrome/i.test(tool)) return 'web'
  if (/^(Agent|Task|SendMessage|ListAgents)$/.test(tool)) return 'agent'
  if (tool.startsWith('mcp__')) return 'mcp'

  return 'other'
}

export function shortTool(tool: string) {
  return tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)

  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Coupe un texte en lignes d'au plus `width` caractères */
function wrap(text: string, width: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const piece = word.length > width ? clip(word, width) : word
    if (!line) line = piece
    else if (line.length + 1 + piece.length <= width) line += ` ${piece}`
    else {
      lines.push(line)
      line = piece
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = clip(`${kept[maxLines - 1]} …`, width)

    return kept
  }

  return lines
}

type GNode = {
  key: string
  idx: number
  kind: 'agent' | 'action'
  x: number
  y: number
  r: number
  /** Distance voulue à son agent (feuilles) */
  rest: number
  color: string
  label: string
  parentIdx?: number
  isRunning: boolean
  isError: boolean
  title: string
  bubble: { heading: string; lines: string[] }
}

export type GraphInput = {
  agents: AgentRow[]
  actions: ActionRow[]
  now: number
  /** Taille logique du dessin (viewBox) */
  width: number
  height: number
  /** Taille affichée, en pixels CSS */
  pixelWidth: number
  pixelHeight: number
  hideDone: boolean
}

const agentColor = (row: AgentRow) => {
  if (row.state === 'failed') return FAILED
  if (row.state !== 'running') return IDLE
  if (row.currentToolName) return CATEGORIES[categorize(row.currentToolName)].color

  return THINKING
}

const STATE_LABEL: Record<AgentRow['state'], string> = {
  running: 'en cours',
  done: 'terminé',
  failed: 'échec',
  stopped: 'arrêté',
}

function build(input: GraphInput, leavesPerAgent: number) {
  const { now, width: W, height: H } = input
  const agents = input.agents.filter(row => !input.hideDone || row.state === 'running' || row.id === MAIN)
  const known = new Set(agents.map(row => row.id))
  if (!known.has(MAIN)) {
    agents.unshift({
      id: MAIN,
      type: 'principal',
      description: 'Agent principal',
      isBackground: false,
      state: 'done',
      startedAt: now,
      toolCount: 0,
      recentTools: [],
    })
    known.add(MAIN)
  }
  const parentOf = (row: AgentRow) => (row.id === MAIN ? undefined : row.parentId && known.has(row.parentId) ? row.parentId : MAIN)
  const actionsOf = new Map<string, ActionRow[]>()
  for (const action of input.actions) {
    if (!known.has(action.agentId)) continue
    const list = actionsOf.get(action.agentId) ?? []
    list.push(action)
    actionsOf.set(action.agentId, list)
  }

  const nodes: GNode[] = []
  const byKey = new Map<string, GNode>()
  const angleOf = new Map<string, number>()
  const cx = W / 2
  const cy = H / 2
  const rx = W * 0.3
  const ry = H * 0.3

  // 1. Les agents : principal au centre, sous-agents en anneau, petits-enfants plus loin
  const place = (row: AgentRow, x: number, y: number, angle: number, depth: number) => {
    const actions = actionsOf.get(row.id) ?? []
    const current = row.state === 'running' ? (row.currentTool ?? 'réflexion…') : '—'
    const last = actions
      .filter(a => a.endedAt !== undefined)
      .slice(-3)
      .reverse()
      .map(a => `• ${clip(`${shortTool(a.tool)} · ${a.detail || '—'}`, 40)} (${formatDuration((a.endedAt ?? now) - a.startedAt)})`)
    const node: GNode = {
      key: row.id,
      idx: nodes.length,
      kind: 'agent',
      x,
      y,
      r: row.id === MAIN ? 20 : depth === 1 ? 15 : 12,
      rest: 0,
      color: agentColor(row),
      label: clip(row.description, 26),
      parentIdx: undefined,
      isRunning: row.state === 'running',
      isError: row.state === 'failed',
      title: `${row.description} — ${STATE_LABEL[row.state]}`,
      bubble: {
        heading: row.description,
        lines: [
          `${row.type}${row.model ? ` · ${row.model}` : ''}${row.isBackground ? ' · arrière-plan' : ''}`,
          `État : ${STATE_LABEL[row.state]} · ${formatDuration((row.endedAt ?? now) - row.startedAt)} · ${row.toolCount} outil${row.toolCount > 1 ? 's' : ''}`,
          ...wrap(`Action : ${current}`, 46, 2),
          ...(last.length ? ['Dernières actions :', ...last] : []),
        ],
      },
    }
    const parent = parentOf(row)
    if (parent) node.parentIdx = byKey.get(parent)?.idx
    nodes.push(node)
    byKey.set(row.id, node)
    angleOf.set(row.id, angle)

    const children = agents.filter(child => parentOf(child) === row.id)
    children.forEach((child, i) => {
      if (row.id === MAIN) {
        const a = children.length === 1 ? 0 : -Math.PI / 2 + (2 * Math.PI * i) / children.length
        place(child, cx + rx * Math.cos(a), cy + ry * Math.sin(a), a, depth + 1)
      } else {
        const spread = Math.min(1.2, 0.5 * (children.length - 1))
        const a = angle + (children.length === 1 ? 0 : -spread / 2 + (spread * i) / (children.length - 1))
        place(child, x + 170 * Math.cos(a), y + 170 * Math.sin(a), a, depth + 1)
      }
    })
  }
  const main = agents.find(row => row.id === MAIN)
  if (main) place(main, cx, cy, -Math.PI / 2, 0)

  // 2. Les actions : en spirale autour de leur agent, les plus récentes à l'extérieur
  for (const agentNode of nodes.filter(n => n.kind === 'agent')) {
    const actions = (actionsOf.get(agentNode.key) ?? []).slice(-leavesPerAgent)
    const base = angleOf.get(agentNode.key) ?? 0
    const owner = agents.find(row => row.id === agentNode.key)
    actions.forEach((action, k) => {
      const cat = categorize(action.tool)
      const color = action.isError ? FAILED : CATEGORIES[cat].color
      const isRunning = action.endedAt === undefined
      const dist = agentNode.r + 30 + 13 * Math.sqrt(k)
      const a = base + k * 2.39996
      const tool = shortTool(action.tool)
      const status = isRunning
        ? `en cours depuis ${formatDuration(now - action.startedAt)}`
        : action.isError
          ? `échec après ${formatDuration((action.endedAt ?? now) - action.startedAt)}`
          : `terminé en ${formatDuration((action.endedAt ?? now) - action.startedAt)}`
      const node: GNode = {
        key: action.id,
        idx: nodes.length,
        kind: 'action',
        x: agentNode.x + dist * Math.cos(a),
        y: agentNode.y + dist * Math.sin(a),
        r: 5,
        rest: dist,
        color,
        label: clip(action.detail ? `${tool} ${action.detail.split(/[\\/]/).pop() ?? ''}` : tool, 20),
        parentIdx: agentNode.idx,
        isRunning,
        isError: !!action.isError,
        title: `${tool} · ${action.detail}`,
        bubble: {
          heading: `${CATEGORIES[cat].label} — ${tool}`,
          lines: [
            ...(action.detail ? wrap(action.detail, 46, 4) : ['(sans argument)']),
            `Agent : ${clip(owner?.description ?? agentNode.key, 38)}`,
            status.charAt(0).toUpperCase() + status.slice(1),
          ],
        },
      }
      nodes.push(node)
    })
  }

  // 3. Un peu de relaxation pour écarter les nœuds qui se chevauchent
  const weight = (n: GNode) => (n.key === MAIN ? 0 : n.kind === 'agent' ? 0.25 : 1)
  for (let it = 0; it < 70; it++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!
        const min = a.r + b.r + (a.kind === 'agent' && b.kind === 'agent' ? 110 : a.kind === 'agent' || b.kind === 'agent' ? 18 : 12)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        if (d >= min) continue
        if (d < 0.01) {
          dx = Math.cos(i + j)
          dy = Math.sin(i + j)
          d = 1
        }
        const push = (min - d) / 2
        const wa = weight(a)
        const wb = weight(b)
        const total = wa + wb || 1
        a.x -= (dx / d) * push * (2 * wa) / total
        a.y -= (dy / d) * push * (2 * wa) / total
        b.x += (dx / d) * push * (2 * wb) / total
        b.y += (dy / d) * push * (2 * wb) / total
      }
    }
    // Les feuilles restent près de leur agent
    for (const n of nodes) {
      if (n.kind !== 'action' || n.parentIdx === undefined) continue
      const p = nodes[n.parentIdx]!
      const dx = n.x - p.x
      const dy = n.y - p.y
      const d = Math.hypot(dx, dy) || 1
      const k = ((d - n.rest) / d) * 0.15
      n.x -= dx * k
      n.y -= dy * k
    }
    for (const n of nodes) {
      n.x = Math.min(W - 40, Math.max(40, n.x))
      n.y = Math.min(H - 70, Math.max(60, n.y))
    }
  }

  return { nodes, agents }
}

export function renderGraph(input: GraphInput): string {
  let leaves = 16
  let svg = ''
  do {
    svg = draw(input, leaves)
    leaves = Math.floor(leaves * 0.7)
  } while (svg.length > MAX_SVG && leaves > 1)

  return svg
}

function draw(input: GraphInput, leavesPerAgent: number): string {
  const { width: W, height: H } = input
  const { nodes, agents } = build(input, leavesPerAgent)
  const id = (n: GNode) => `n${n.idx}`
  const f = (v: number) => v.toFixed(1)

  // Arêtes (sous les nœuds)
  const edges = nodes
    .filter(n => n.parentIdx !== undefined)
    .map(n => {
      const p = nodes[n.parentIdx!]!
      const isAgentEdge = n.kind === 'agent'

      return `<line class="ed ${isAgentEdge ? 'ea' : 'el'} f${p.idx} t${n.idx}" style="--c:${n.color}" x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(n.x)}" y2="${f(n.y)}"/>`
    })
    .join('')

  // Nœuds : les feuilles d'abord, les agents par-dessus
  const ordered = [...nodes.filter(n => n.kind === 'action'), ...nodes.filter(n => n.kind === 'agent')]
  const nodeSvg = ordered
    .map(n => {
      const cls = ['n', n.kind === 'agent' ? 'a' : 'l', n.isRunning ? 'run' : '', n.isError ? 'err' : '', n.parentIdx !== undefined ? `o${n.parentIdx}` : '']
        .filter(Boolean)
        .join(' ')
      const labelY = n.y + n.r + (n.kind === 'agent' ? 15 : 10)

      return (
        `<g id="${id(n)}" class="${cls}" tabindex="0" style="--c:${n.color}">` +
        `<title>${esc(n.title)}</title>` +
        (n.isRunning ? `<circle class="pulse" cx="${f(n.x)}" cy="${f(n.y)}" r="${n.r}"/>` : '') +
        `<circle class="halo" cx="${f(n.x)}" cy="${f(n.y)}" r="${n.r + 6}"/>` +
        `<circle class="core" cx="${f(n.x)}" cy="${f(n.y)}" r="${n.r}"/>` +
        `<text x="${f(n.x)}" y="${f(labelY)}">${esc(n.label)}</text>` +
        `</g>`
      )
    })
    .join('')

  // Bulles : un calque au-dessus de tout, chacune visible quand son nœud a le focus (clic)
  const BW = 320
  const bubbles = nodes
    .map(n => {
      const lines = n.bubble.lines
      const bh = 38 + lines.length * 17
      let bx = n.x + n.r + 14
      if (bx + BW > W - 8) bx = n.x - n.r - 14 - BW
      bx = Math.max(8, bx)
      const by = Math.min(H - bh - 8, Math.max(8, n.y - bh / 2))
      const body = lines
        .map((line, i) => `<text class="${/^Dernières|^Agent :/.test(line) ? 'bs' : 'bl'}" x="14" y="${48 + i * 17}">${esc(line)}</text>`)
        .join('')

      return (
        `<g id="b${n.idx}" class="bub" transform="translate(${f(bx)},${f(by)})" style="--c:${n.color}">` +
        `<rect width="${BW}" height="${bh}" rx="10"/>` +
        `<circle cx="18" cy="21" r="5" fill="${n.color}"/>` +
        `<text class="bt" x="30" y="25">${esc(clip(n.bubble.heading, 38))}</text>` +
        body +
        `</g>`
      )
    })
    .join('')

  // Règles par nœud : bulle au focus, surbrillance de ses liens et de ses actions au survol
  const rules = nodes
    .map(
      n =>
        `#${id(n)}:focus~#bubs #b${n.idx}{display:inline}` +
        `svg:has(#${id(n)}:hover) :is(.f${n.idx},.t${n.idx}){stroke:var(--c);stroke-opacity:.95;stroke-width:2}` +
        (n.kind === 'agent' ? `svg:has(#${id(n)}:hover) .o${n.idx}{opacity:1}` : ''),
    )
    .join('')

  // Légende : catégories présentes + états des agents
  const counts = new Map<Category, number>()
  for (const n of nodes) {
    if (n.kind !== 'action') continue
    const cat = (Object.keys(CATEGORIES) as Category[]).find(c => CATEGORIES[c].color === n.color)
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  const legendItems = [
    ...[...counts.entries()].map(([cat, count]) => ({ color: CATEGORIES[cat].color, text: `${CATEGORIES[cat].label} (${count})` })),
    { color: THINKING, text: 'Réflexion' },
    { color: IDLE, text: 'Terminé' },
    { color: FAILED, text: 'Échec' },
  ]
  const perRow = Math.max(2, Math.floor((W - 40) / 150))
  const legendRows = Math.ceil(legendItems.length / perRow)
  const legendY = H - 14 - (legendRows - 1) * 18
  const legend = legendItems
    .map((item, i) => {
      const x = 24 + (i % perRow) * 150
      const y = legendY + Math.floor(i / perRow) * 18

      return `<circle cx="${x}" cy="${y - 4}" r="4.5" fill="${item.color}"/><text class="lg" x="${x + 10}" y="${y}">${esc(item.text)}</text>`
    })
    .join('')

  const subs = agents.filter(row => row.id !== MAIN)
  const running = subs.filter(row => row.state === 'running').length
  const actionCount = nodes.filter(n => n.kind === 'action').length
  const header =
    `<text class="hd" x="20" y="30">Agents</text>` +
    `<text class="hs" x="20" y="48">${running} actif${running > 1 ? 's' : ''} · ${subs.length} sous-agent${subs.length > 1 ? 's' : ''} · ${actionCount} action${actionCount > 1 ? 's' : ''}</text>` +
    `<text class="hint" x="${W - 20}" y="30" text-anchor="end">Survole : surligne · Clique : détail</text>`
  const empty =
    subs.length === 0 && actionCount === 0
      ? `<text class="hint" x="${W / 2}" y="${H / 2 + 52}" text-anchor="middle">En attente d'activité…</text>`
      : ''

  const css =
    `svg{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `.bg{fill:#0B0D12}` +
    `.ed{stroke:#2A2F3A;stroke-width:1;transition:stroke .15s}` +
    `.ea{stroke:#3A4150;stroke-width:1.6}` +
    `.n{cursor:pointer;outline:none;transition:opacity .15s}` +
    `.core{fill:var(--c);transition:filter .15s}` +
    `.halo{fill:none;stroke:var(--c);stroke-width:2;opacity:0;transition:opacity .15s}` +
    `.n:hover .halo,.n:focus .halo{opacity:.95}` +
    `.n:hover .core,.n:focus .core{filter:drop-shadow(0 0 7px var(--c)) brightness(1.2)}` +
    `.n text{fill:#8B93A3;font-size:9px;text-anchor:middle;pointer-events:none;opacity:.8}` +
    `.a text{fill:#E6E8EE;font-size:12px;font-weight:600;opacity:1}` +
    `.n:hover text,.n:focus text{fill:#fff;opacity:1}` +
    `.err .core{stroke:${FAILED};stroke-width:2}` +
    `.pulse{fill:none;stroke:var(--c);stroke-width:2;transform-box:fill-box;transform-origin:center;animation:p 1.6s ease-out infinite;pointer-events:none}` +
    `@keyframes p{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.3);opacity:0}}` +
    `svg:has(.n:hover) .n:not(:hover){opacity:.35}` +
    `.bub{display:none;pointer-events:none}` +
    `.bub rect{fill:#151923;stroke:var(--c);stroke-width:1.5;filter:drop-shadow(0 6px 18px rgba(0,0,0,.6))}` +
    `.bt{fill:#fff;font-size:13px;font-weight:600}` +
    `.bl{fill:#C9CED8;font-size:11.5px}` +
    `.bs{fill:#8B93A3;font-size:11px}` +
    `.hd{fill:#fff;font-size:16px;font-weight:700}` +
    `.hs{fill:#8B93A3;font-size:11.5px}` +
    `.hint{fill:#5B6475;font-size:11px}` +
    `.lg{fill:#AEB4C0;font-size:10.5px}` +
    rules

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${Math.round(input.pixelWidth)}" height="${Math.round(input.pixelHeight)}" preserveAspectRatio="xMidYMid meet" style="display:block">` +
    `<style>${css}</style>` +
    `<rect class="bg" width="${W}" height="${H}" rx="12"/>` +
    header +
    `<g id="edges">${edges}</g>` +
    nodeSvg +
    `<g id="bubs">${bubbles}</g>` +
    legend +
    empty +
    `</svg>`
  )
}
