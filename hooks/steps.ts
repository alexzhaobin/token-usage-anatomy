// What the mod keeps about each model request (a "step" of a turn), and how
// a step is priced once the transcript has filled in what the hooks lack.
// Pure: no `$`.

import { addParts, costParts, estimateSplit, total, zeroParts } from './pricing'
import type { CostParts, ReasoningMethod, Tokens } from './pricing'
import type { TranscriptEntry } from './transcript'
import type { TokenParts } from '../types'

export type CharCounts = {
  /** Thinking text streamed (empty when thinking is hidden or summarised). */
  thinking: number
  /** Visible answer text streamed. */
  text: number
  /** Tool-call arguments (JSON) streamed. */
  toolInput: number
}

export type Step = {
  /** The step's position in its turn, from 0. */
  index: number
  /** The model that answered (the requested one when no usage came back). */
  model: string
  /** The model the request named. */
  requestedModel: string
  effort?: string | number
  tokens: Tokens
  /** False when no usage came back (an interrupted or failed request). */
  hasUsage: boolean
  stopReason: string | null
  toolUses: number
  chars: CharCounts
  startedAt: number
  endedAt: number
  /** No cache was read: the cache was cold or the prefix changed. */
  isCold: boolean
}

export type ToolStat = { calls: number; resultChars: number; errors: number }

export type PricedStep = Step & {
  isInTranscript: boolean
  reasoningTokens: number
  reasoningMethod: ReasoningMethod
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  isFast: boolean
  isUsOnly: boolean
  parts: CostParts
}

export const noTokens = (): Tokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
})

/** All the input a request was answered over. */
export const contextOf = (tokens: Tokens): number =>
  tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens

/**
 * Prices one step: thinking tokens as the API reported them when the
 * transcript has them, else estimated from the streamed characters; the
 * cache write split from the transcript, else every write as 1-hour.
 */
export function priceStep(step: Step, entry: TranscriptEntry | undefined): PricedStep {
  const tokens = step.tokens
  const reported = entry?.thinkingTokens
  const estimate = estimateSplit(tokens.outputTokens, step.chars.thinking, step.chars.text, step.chars.toolInput)
  const reasoningTokens = Math.min(tokens.outputTokens, reported ?? estimate.reasoningTokens)
  const writes5m = Math.min(tokens.cacheCreationTokens, entry?.cacheWrite5mTokens ?? 0)
  const isFast = entry?.isFast ?? false
  const isUsOnly = entry?.isUsOnly ?? false

  return {
    ...step,
    isInTranscript: entry !== undefined,
    reasoningTokens,
    reasoningMethod: reported !== undefined ? 'reported' : estimate.method,
    cacheWrite5mTokens: writes5m,
    cacheWrite1hTokens: tokens.cacheCreationTokens - writes5m,
    isFast,
    isUsOnly,
    parts: costParts(
      { ...tokens, cacheWrite5mTokens: writes5m, reasoningTokens, isFast, isUsOnly },
      step.model,
    ),
  }
}

export function tokenParts(steps: readonly PricedStep[]): TokenParts {
  const sum: TokenParts = { input: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, answer: 0 }

  for (const step of steps) {
    sum.input += step.tokens.inputTokens
    sum.cacheRead += step.tokens.cacheReadTokens
    sum.cacheWrite += step.tokens.cacheCreationTokens
    sum.reasoning += step.reasoningTokens
    sum.answer += step.tokens.outputTokens - step.reasoningTokens
  }

  return sum
}

export const tokenTotal = (parts: TokenParts): number =>
  parts.input + parts.cacheRead + parts.cacheWrite + parts.reasoning + parts.answer

export function costOf(steps: readonly PricedStep[]): CostParts {
  return steps.reduce((sum, step) => addParts(sum, step.parts), zeroParts())
}

/** The method behind a set of steps' reasoning: one method, or `mixed`. */
export function methodOf(steps: readonly PricedStep[]): ReasoningMethod | 'mixed' | undefined {
  const methods = new Set(steps.filter(step => step.tokens.outputTokens > 0).map(step => step.reasoningMethod))

  if (methods.size === 0) {
    return undefined
  }

  return methods.size === 1 ? [...methods][0] : 'mixed'
}

export function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const item of items) {
    const key = keyOf(item)
    counts[key] = (counts[key] ?? 0) + 1
  }

  return counts
}

export function mergeTools(into: Record<string, ToolStat>, from: Record<string, ToolStat>): Record<string, ToolStat> {
  for (const [name, stat] of Object.entries(from)) {
    const known = into[name] ?? { calls: 0, resultChars: 0, errors: 0 }
    into[name] = {
      calls: known.calls + stat.calls,
      resultChars: known.resultChars + stat.resultChars,
      errors: known.errors + stat.errors,
    }
  }

  return into
}

/** Field order of `requestDetail` rows; written into each prompt row too. */
export const REQUEST_FIELDS = [
  'inputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
  'outputTokens',
  'reasoningTokens',
  'isReasoningReported',
  'cacheWrite5mTokens',
  'costUsd',
  'toolUses',
  'durationMs',
  'model',
  'isFast',
  'isUsOnly',
] as const

/** Compact per-request arrays: `model` is an index into the models list. */
export function requestDetail(steps: readonly PricedStep[]): { models: string[]; rows: number[][] } {
  const models: string[] = []

  const rows = steps.map(step => {
    let model = models.indexOf(step.model)

    if (model < 0) {
      models.push(step.model)
      model = models.length - 1
    }

    return [
      step.tokens.inputTokens,
      step.tokens.cacheCreationTokens,
      step.tokens.cacheReadTokens,
      step.tokens.outputTokens,
      step.reasoningTokens,
      step.reasoningMethod === 'reported' ? 1 : 0,
      step.cacheWrite5mTokens,
      round(total(step.parts)),
      step.toolUses,
      Math.max(0, step.endedAt - step.startedAt),
      model,
      step.isFast ? 1 : 0,
      step.isUsOnly ? 1 : 0,
    ]
  })

  return { models, rows }
}

/** Dollars to a millionth of a cent, so rows stay short. */
export const round = (usd: number): number => Math.round(usd * 1e8) / 1e8

export function roundParts(parts: CostParts): CostParts {
  return {
    input: round(parts.input),
    cacheRead: round(parts.cacheRead),
    cacheWrite: round(parts.cacheWrite),
    reasoning: round(parts.reasoning),
    answer: round(parts.answer),
  }
}
