export type AgentState = 'running' | 'done' | 'failed' | 'stopped'

/** Statut d'une tâche tel que l'agent le tient dans sa liste (jamais de % inventé) */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type TaskItem = { id?: string; content: string; status: TaskStatus }

/** Où en est la boucle de l'agent, d'après Claude Code ($.agent.list) */
export type EngineStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** La dernière demande de l'utilisateur et l'état de la réponse finale de l'agent principal */
export type RequestInfo = { text: string; at: number }
export type FinalInfo = { state: 'waiting' | 'ready' | 'failed' | 'stopped'; text?: string; at: number }

/** Un message du chat avec un agent : écrit par l'utilisateur dans la page, ou réponse de l'agent */
export type ChatMessage = {
  id: string
  agentId: string
  from: 'user' | 'agent'
  text: string
  at: number
  /** Pour un message de l'utilisateur : livré, en file (agent principal occupé) ou refusé */
  status?: 'sent' | 'queued' | 'failed'
  reason?: string
}

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
  /** Sa liste de tâches (TodoWrite, TaskCreate/TaskUpdate, ou le plan de l'agent principal) */
  tasks?: TaskItem[]
  /** Nombre de fois où la liste a été envoyée (1 = jamais mise à jour après le plan de départ) */
  taskUpdates?: number
  /** Étape du plan de l'agent principal en cours quand ce sous-agent a été lancé */
  part?: string
  /** Début de la consigne donnée au sous-agent (ce qu'il doit faire) */
  prompt?: string
  /** Statut de sa boucle selon Claude Code */
  status?: EngineStatus
  /** Raison d'une alerte pour l'utilisateur (question posée, autorisation demandée) ; absente sinon */
  alert?: string
  alertToolId?: string
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

declare module 'claude-code' {
  interface PluginState {
    'agent-viewer': {
      agents: AgentRow[]
      actions: ActionRow[]
      /** Adresse de la vue interactive (serveur local), ou null s'il ne tourne pas */
      liveUrl: string | null
      /** Pourquoi le serveur local n'a pas pu démarrer, le cas échéant */
      liveError: string | null
      /** Nom de la session dans la vue de toutes les sessions : son premier message */
      sessionTitle: string | null
      /** Dernière demande de l'utilisateur (case « Demande ») */
      request: RequestInfo | null
      /** Réponse finale de l'agent principal (case « Réponse finale ») */
      final: FinalInfo | null
      /** Le chat avec les agents de cette session (les 200 derniers messages) */
      chat: ChatMessage[]
    }
  }
}
