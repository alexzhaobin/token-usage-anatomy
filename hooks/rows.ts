// The rows written to the log, built from what the hooks and the transcript
// recorded. Pure: the caller adds nothing but writes them. Every row also
// gets `schema` from the logbook.

import type { ModelUsage, SessionUsage } from 'claude-code'

import { PRICES } from './prices'
import { costParts, total } from './pricing'
import type { CostParts } from './pricing'
import {
  REQUEST_FIELDS,
  contextOf,
  costOf,
  countBy,
  methodOf,
  requestDetail,
  round,
  roundParts,
  tokenParts,
} from './steps'
import type { PricedStep, ToolStat } from './steps'
import type { SubagentSummary } from './subagents'
import type { Preloaded } from '../types'


/** A list in a row keeps at most this many entries. */
const MAX_LIST = 300

export type Row = { kind: string; at: string; [field: string]: unknown }

/** The prompt's first words, whitespace collapsed: the band's label. */
export function labelOf(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim()

  if (words === '') {
    return '(continued)'
  }

  return words.length > 40 ? `${words.slice(0, 39)}…` : words
}

export type PromptInput = {
  at: string
  promptNo: number
  turnId: string
  reason: string
  durationMs: number
  /** Stored only when the person turned on prompt text. */
  label?: string
  prompt?: string
  steps: readonly PricedStep[]
  /** The turn's usage from the hooks, when no step reported any. */
  fallbackUsage?: ModelUsage & { model: string }
  tools: Record<string, ToolStat>
  idleBeforeMs?: number
  transcriptRequests: number
  subagents?: SubagentSummary
  engine: {
    sessionUsd?: number
    deltaUsd?: number
    contextTokens?: number
    contextWindow?: number
  }
}

export type PromptResult = {
  row: Row
  /** What the prompt's own requests cost, by part. */
  parts: CostParts
  subagentUsd: number
  /** Engine cost growth the mod did not price; zero when it priced more. */
  unattributedUsd: number
  /** What the mod priced above the engine; zero when it priced less. */
  overUsd: number
}

/** Below half a tenth of a cent a difference is noise. */
const NOISE_USD = 0.0005

export function buildPromptRow(input: PromptInput): PromptResult {
  const steps = input.steps
  let parts = costOf(steps)

  if (steps.length === 0 && input.fallbackUsage !== undefined) {
    const usage = input.fallbackUsage
    parts = costParts(
      {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      },
      usage.model,
    )
  }

  const tokens = tokenParts(steps)
  const subagentUsd = input.subagents?.estCostUsd ?? 0
  const estUsd = total(parts)
  const diff = input.engine.deltaUsd === undefined ? 0 : input.engine.deltaUsd - estUsd - subagentUsd
  const unattributedUsd = diff >= NOISE_USD ? diff : 0
  const overUsd = diff <= -NOISE_USD ? -diff : 0
  const contexts = steps.map(step => contextOf(step.tokens))
  const inputAll = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const detail = requestDetail(steps.slice(-MAX_LIST))
  const toolResultChars = Object.values(input.tools).reduce((sum, stat) => sum + stat.resultChars, 0)
  const sum = (pick: (step: PricedStep) => number): number => steps.reduce((acc, step) => acc + pick(step), 0)
  const lastModel = steps.at(-1)?.model ?? input.fallbackUsage?.model
  const window = input.engine.contextWindow

  const row: Row = {
    kind: 'prompt',
    at: input.at,
    promptNo: input.promptNo,
    turnId: input.turnId,
    reason: input.reason,
    durationMs: input.durationMs,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    model: lastModel,
    models: countBy(steps, step => step.model),
    requestedModel: steps.at(-1)?.requestedModel,
    effort: steps.at(-1)?.effort,
    requests: steps.length,
    // Token counts by type: the anatomy of the prompt.
    inputTokens: tokens.input,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheWrite,
    cacheWrite5mTokens: sum(step => step.cacheWrite5mTokens),
    cacheWrite1hTokens: sum(step => step.cacheWrite1hTokens),
    outputTokens: tokens.reasoning + tokens.answer,
    reasoningTokens: tokens.reasoning,
    answerTokens: tokens.answer,
    reasoningMethod: methodOf(steps),
    thinkingTokens: sum(step => (step.reasoningMethod === 'reported' ? step.reasoningTokens : 0)),
    totalInputTokens: inputAll,
    cacheMissTokens: tokens.input + tokens.cacheWrite,
    cacheHitPct: inputAll === 0 ? null : Math.round((tokens.cacheRead / inputAll) * 1000) / 10,
    // The cache: requests that read none of it, and what they wrote again.
    cacheMissRequests: steps.filter(step => step.isCold).length,
    recachedTokens: sum(step => (step.isCold ? step.tokens.cacheCreationTokens : 0)),
    idleBeforeMs: input.idleBeforeMs,
    // The context window, request by request.
    contextTokens: contexts.at(-1) ?? 0,
    peakContextTokens: contexts.length === 0 ? 0 : Math.max(...contexts.slice(-MAX_LIST)),
    contextByStep: contexts.slice(-MAX_LIST),
    contextWindow: window,
    contextPct: window && contexts.length > 0 ? round(((contexts.at(-1) ?? 0) / window) * 100) : undefined,
    contextAfterTokens: input.engine.contextTokens,
    contextAfterPct:
      window && input.engine.contextTokens !== undefined
        ? round((input.engine.contextTokens / window) * 100)
        : undefined,
    // Tools: sizes only, never contents.
    tools: input.tools,
    toolResultTokensEst: Math.round(toolResultChars / 4),
    thinkingChars: sum(step => step.chars.thinking),
    answerChars: sum(step => step.chars.text),
    toolInputChars: sum(step => step.chars.toolInput),
    transcriptRequests: input.transcriptRequests,
    fastRequests: steps.filter(step => step.isFast).length,
    usOnlyRequests: steps.filter(step => step.isUsOnly).length,
    requestFields: REQUEST_FIELDS,
    requestModels: detail.models,
    requestDetail: detail.rows,
    ...(input.subagents === undefined ? {} : { subagents: input.subagents }),
    // Dollars: API list-price equivalent.
    pricesAsOf: PRICES.asOf,
    estCostUsd: round(total(parts)),
    estCostParts: roundParts(parts),
    estSubagentUsd: round(subagentUsd),
    sessionCostUsd: input.engine.sessionUsd,
    sessionCostDeltaUsd: input.engine.deltaUsd === undefined ? undefined : round(input.engine.deltaUsd),
    engineDiffUsd: input.engine.deltaUsd === undefined ? undefined : round(diff),
    unattributedUsd: round(unattributedUsd),
    overUsd: round(overUsd),
  }

  return { row, parts, subagentUsd, unattributedUsd, overUsd }
}

/** One row per model request, written only when recordRequests is on. */
export function buildRequestRows(
  at: string,
  promptNo: number,
  turnId: string,
  steps: readonly PricedStep[],
  agentId?: string,
): Row[] {
  return steps.map(step => ({
    kind: 'request',
    at,
    promptNo,
    turnId,
    ...(agentId === undefined ? {} : { agentId }),
    step: step.index,
    stopReason: step.stopReason,
    toolUses: step.toolUses,
    durationMs: Math.max(0, step.endedAt - step.startedAt),
    model: step.model,
    requestedModel: step.requestedModel,
    effort: step.effort,
    inputTokens: step.tokens.inputTokens,
    cacheReadTokens: step.tokens.cacheReadTokens,
    cacheCreationTokens: step.tokens.cacheCreationTokens,
    cacheWrite5mTokens: step.cacheWrite5mTokens,
    cacheWrite1hTokens: step.cacheWrite1hTokens,
    outputTokens: step.tokens.outputTokens,
    reasoningTokens: step.reasoningTokens,
    answerTokens: step.tokens.outputTokens - step.reasoningTokens,
    reasoningMethod: step.reasoningMethod,
    contextTokens: contextOf(step.tokens),
    isCacheMiss: step.isCold,
    thinkingChars: step.chars.thinking,
    answerChars: step.chars.text,
    toolInputChars: step.chars.toolInput,
    isInTranscript: step.isInTranscript,
    isFast: step.isFast,
    isUsOnly: step.isUsOnly,
    pricesAsOf: PRICES.asOf,
    estCostUsd: round(total(step.parts)),
    estCostParts: roundParts(step.parts),
  }))
}

/** A snapshot of the context window by category, from /context's breakdown. */
export function buildContextRow(at: string, promptNo: number, usage: SessionUsage): Row | undefined {
  const breakdown = usage.context.breakdown

  if (breakdown === undefined) {
    return undefined
  }

  const categories = breakdown.categories
    .filter(category => category.tokens > 0 && !category.isDeferred)
    .map(category => ({ name: category.name, tokens: category.tokens, kind: category.kind }))

  return {
    kind: 'context',
    at,
    promptNo,
    model: breakdown.model,
    window: usage.context.window,
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.maxTokens,
    autoCompactThreshold: breakdown.autoCompactThreshold,
    preloadedTokens: preloadedOf(usage)?.tokens ?? 0,
    categories,
  }
}

/** What fills the window before anything is typed: every used category but the messages. */
export function preloadedOf(usage: SessionUsage): Preloaded | null {
  const breakdown = usage.context.breakdown

  if (breakdown === undefined) {
    return null
  }

  const parts = breakdown.categories
    .filter(category => category.kind === 'used' && category.tokens > 0 && category.name !== 'Messages')
    .map(category => ({ name: category.name, tokens: category.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
  const tokens = parts.reduce((sum, part) => sum + part.tokens, 0)

  return tokens === 0 ? null : { tokens, window: usage.context.window, parts }
}

export function buildCompactRow(
  at: string,
  trigger: string,
  tokensBefore: number | undefined,
  tokensAfter: number | undefined,
  usage: (ModelUsage & { model: string }) | undefined,
): Row {
  const parts =
    usage === undefined
      ? undefined
      : costParts(
          {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreationTokens: usage.cache_creation_input_tokens,
          },
          usage.model,
        )

  return {
    kind: 'compact',
    at,
    trigger,
    tokensBefore,
    tokensAfter,
    ...(usage === undefined || parts === undefined
      ? {}
      : {
          summarizer: {
            model: usage.model,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreationTokens: usage.cache_creation_input_tokens,
            estCostUsd: round(total(parts)),
          },
        }),
  }
}
