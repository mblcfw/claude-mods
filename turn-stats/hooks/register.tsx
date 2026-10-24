import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LiveTurn, TurnStats } from '../types'

const live = atom({ plugin: 'turn-stats', key: 'live' } as const, null)
const last = atom({ plugin: 'turn-stats', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'turn-stats', key: 'isHidden' } as const, false)

const formatTokens = (n: number) => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

const formatDuration = (s: number) => {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)

  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

// Ajoute un changement au tour en cours, s'il y en a un
const bump = (fn: (turn: LiveTurn) => LiveTurn) => (turn: LiveTurn | null) => (turn ? fn(turn) : turn)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stats-tour',
      description: 'Affiche ou masque le bandeau des stats du dernier tour',
    })

    return next(e)
  })

  on('command.run', { command: 'stats-tour' }, async $ => {
    const wasHidden = await read($, isHidden)
    await update($, isHidden, () => !wasHidden)

    return { text: wasHidden ? 'Bandeau des stats affiché.' : 'Bandeau des stats masqué.' }
  })

  // Un tour de l'agent principal commence : on remet les compteurs à zéro
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const turn: LiveTurn = { turnId: e.turnId, tools: 0, subagents: 0, subTools: 0, subTokens: 0 }
      await update($, live, () => turn)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update(
      $,
      live,
      bump(turn => (e.agentId ? { ...turn, subTools: turn.subTools + 1 } : { ...turn, tools: turn.tools + 1 })),
    )

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId && !e.resume) {
      await update($, live, bump(turn => ({ ...turn, subagents: turn.subagents + 1 })))
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const tokens = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens : 0

    // Fin du tour d'un sous-agent : ses tokens comptent pour le tour principal en cours
    if (e.agentId) {
      await update($, live, bump(turn => ({ ...turn, subTokens: turn.subTokens + tokens })))

      return next(e)
    }

    // Fin du tour principal : on fige le bilan
    const turn = await read($, live)
    const stats: TurnStats = {
      seconds: Math.round(e.durationMs / 1000),
      tools: turn?.tools ?? 0,
      input: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      model: u?.model.replace(/^claude-/, ''),
      subagents: turn?.subagents ?? 0,
      subTools: turn?.subTools ?? 0,
      subTokens: turn?.subTokens ?? 0,
      isAborted: e.isAborted,
      isFailed: e.reason === 'error' || e.reason === 'refusal',
    }
    await update($, last, () => stats)
    await update($, live, () => null)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const now = await read($, live)
    const done = await read($, last)
    const { Box, Button, Text } = $.ui.resolve(e)

    // Pendant le tour : compteurs en direct
    if (e.props.isWorking && now) {
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color="warning">● Tour en cours</Text>
          <Text dimColor>· {plural(now.tools, 'outil')}</Text>
          {now.subagents > 0 && (
            <Text dimColor>
              · {plural(now.subagents, 'sous-agent')} ({plural(now.subTools, 'outil')})
            </Text>
          )}
        </Box>
      )
    }

    if (!done) {
      return next(e)
    }

    const cachePct = done.input > 0 ? Math.round((done.cacheRead / done.input) * 100) : 0
    const status = done.isAborted ? 'interrompu' : done.isFailed ? 'erreur' : null

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text dimColor>Dernier tour</Text>
        {status && <Text color="error">({status})</Text>}
        <Text>
          · <Text weight="semibold">{formatDuration(done.seconds)}</Text>
        </Text>
        <Text>· {plural(done.tools, 'outil')}</Text>
        <Text>
          · <Text color="claude">{formatTokens(done.input)}</Text>
          <Text dimColor> entrée</Text> / <Text color="claude">{formatTokens(done.output)}</Text>
          <Text dimColor> sortie</Text>
        </Text>
        {done.input > 0 && <Text dimColor>(cache {cachePct} %)</Text>}
        {done.subagents > 0 && (
          <Text dimColor>
            · {plural(done.subagents, 'sous-agent')} : {plural(done.subTools, 'outil')}, {formatTokens(done.subTokens)}{' '}
            tokens
          </Text>
        )}
        {done.model && <Text dimColor>· {done.model}</Text>}
        <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
