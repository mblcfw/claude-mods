export type AgentState = 'running' | 'done' | 'failed' | 'stopped'

export type AgentRow = {
  /** 'main' pour l'agent principal, sinon l'id du sous-agent */
  id: string
  type: string
  description: string
  model?: string
  parentId?: string
  isBackground: boolean
  state: AgentState
  startedAt: number
  endedAt?: number
  toolCount: number
  /** Outil en cours, ex. "Bash · npm test" */
  currentTool?: string
  currentToolId?: string
  /** Nom brut de l'outil en cours (Bash, Read…), pour sa couleur */
  currentToolName?: string
  /** Derniers outils terminés, le plus récent en dernier */
  recentTools: string[]
}

/** Un appel d'outil fait par un agent : un nœud feuille du graphe */
export type ActionRow = {
  /** tool_use_id */
  id: string
  agentId: string
  /** Nom brut de l'outil (Bash, Read, mcp__x__y…) */
  tool: string
  /** Argument le plus parlant (commande, fichier, motif…) */
  detail: string
  startedAt: number
  endedAt?: number
  isError?: boolean
}

/** Une image figée du graphe, pour lire les bulles sans que tout bouge */
export type Snapshot = { agents: AgentRow[]; actions: ActionRow[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-viewer': {
      agents: AgentRow[]
      actions: ActionRow[]
      isHidingDone: boolean
      frozen: Snapshot | null
      /** Facteur de taille du graphe, réglé par les boutons − / + */
      zoom: number
      /** Adresse de la vue interactive (serveur local), ou null s'il ne tourne pas */
      liveUrl: string | null
      /** Pourquoi le serveur local n'a pas pu démarrer, le cas échéant */
      liveError: string | null
      /** Nom de la session dans la vue de toutes les sessions : son premier message */
      sessionTitle: string | null
    }
  }
}
