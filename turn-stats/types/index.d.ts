/** Ce qui s'accumule pendant un tour de l'agent principal */
export type LiveTurn = {
  turnId: string
  tools: number
  subagents: number
  subTools: number
  subTokens: number
}

/** Le bilan d'un tour terminé */
export type TurnStats = {
  seconds: number
  tools: number
  /** Tokens d'entrée : non mis en cache + lus du cache + écrits dans le cache */
  input: number
  cacheRead: number
  output: number
  model?: string
  subagents: number
  subTools: number
  subTokens: number
  isAborted: boolean
  isFailed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'turn-stats': { live: LiveTurn | null; last: TurnStats | null; isHidden: boolean }
  }
}
