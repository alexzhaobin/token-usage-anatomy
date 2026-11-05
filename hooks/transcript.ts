// Reading what the hooks' usage leaves out, from Claude Code's transcript.
// Pure functions: the file access is in io.ts.
//
// Every model response is written to the transcript as one line per content
// block, each line repeating the response's usage. The usage there carries
// what the hooks do not: thinking tokens, the 5-minute / 1-hour cache write
// split, fast mode and US-only inference.

import type { Tokens } from './pricing'

/** One model response as the transcript records it. */
export type TranscriptEntry = Tokens & {
  /** True in a subagent's transcript. */
  isSidechain: boolean
  /** The request id (or the message id when there is none). */
  id: string
  /** Output tokens spent thinking, when the API reported them. */
  thinkingTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  isFast: boolean
  isUsOnly: boolean
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** The key requests are matched on: their four token counts. */
export function usageKey(tokens: Tokens): string {
  return `${tokens.inputTokens}/${tokens.cacheCreationTokens}/${tokens.cacheReadTokens}/${tokens.outputTokens}`
}

function entryFromUsage(
  usage: Record<string, unknown>,
  id: string,
  isSidechain: boolean,
): TranscriptEntry | undefined {
  const inputTokens = count(usage.input_tokens)
  const outputTokens = count(usage.output_tokens)

  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined
  }

  const creation = record(usage.cache_creation)
  const details = record(usage.output_tokens_details)

  return {
    isSidechain,
    id,
    inputTokens,
    outputTokens,
    cacheReadTokens: count(usage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: count(usage.cache_creation_input_tokens) ?? 0,
    thinkingTokens: count(details?.thinking_tokens),
    cacheWrite5mTokens: count(creation?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: count(creation?.ephemeral_1h_input_tokens),
    isFast: usage.speed === 'fast',
    isUsOnly: usage.inference_geo === 'us',
  }
}

/**
 * Reads the assistant entries of transcript text (whole JSON lines). Lines
 * that are not assistant responses, or do not parse (a line cut by the
 * offset, a line still being written), are skipped.
 */
export function parseTranscriptLines(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []

  for (const line of text.split('\n')) {
    if (!line.includes('"type":"assistant"')) {
      continue
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const row = record(parsed)
    const message = record(row?.message)
    const usage = record(message?.usage)

    if (row?.type !== 'assistant' || usage === undefined) {
      continue
    }

    const id =
      typeof row.requestId === 'string' ? row.requestId : typeof message?.id === 'string' ? message.id : ''
    const entry = entryFromUsage(usage, id, row.isSidechain === true)

    if (entry !== undefined) {
      entries.push(entry)
    }
  }

  return entries
}

const reducedNumber = (field: string | undefined): number | undefined =>
  field === undefined || !/^\d+$/.test(field) ? undefined : Number(field)

/**
 * Reads the tab-separated lines scripts/io.sh and scripts/io.ps1 print for
 * a transcript too large to read whole: sidechain (1/0), id, input, cache
 * creation, cache read, output, thinking, 5m writes, 1h writes, speed, geo;
 * "-" for a field the entry lacked.
 */
export function parseReducedLines(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []

  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t')

    if (fields.length < 11) {
      continue
    }

    const [side, id, input, creation, read, output, thinking, w5m, w1h, speed, geo] = fields
    const inputTokens = reducedNumber(input)
    const outputTokens = reducedNumber(output)

    if (inputTokens === undefined || outputTokens === undefined) {
      continue
    }

    entries.push({
      isSidechain: side === '1',
      id: id ?? '',
      inputTokens,
      outputTokens,
      cacheCreationTokens: reducedNumber(creation) ?? 0,
      cacheReadTokens: reducedNumber(read) ?? 0,
      thinkingTokens: reducedNumber(thinking),
      cacheWrite5mTokens: reducedNumber(w5m),
      cacheWrite1hTokens: reducedNumber(w1h),
      isFast: speed === 'fast',
      isUsOnly: geo === 'us',
    })
  }

  return entries
}

/** One response per id and usage: the content-block lines repeat it. */
export function dedupe(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const seen = new Set<string>()

  return entries.filter(entry => {
    const key = `${entry.id}|${usageKey(entry)}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

/**
 * Pairs each step with a transcript entry of the same four token counts,
 * in order: arrival order is never trusted, and two requests with the same
 * counts take their entries first come, first served.
 */
export function matchSteps<S extends { tokens: Tokens }>(
  steps: readonly S[],
  entries: readonly TranscriptEntry[],
): Array<TranscriptEntry | undefined> {
  const used = new Set<number>()

  return steps.map(step => {
    const key = usageKey(step.tokens)
    const index = entries.findIndex((entry, i) => !used.has(i) && usageKey(entry) === key)

    if (index < 0) {
      return undefined
    }

    used.add(index)

    return entries[index]
  })
}

/**
 * The session's title from its title lines: the last title set with
 * /rename beats the last one Claude Code generated.
 */
export function parseTitle(text: string): string | undefined {
  let generated: string | undefined
  let custom: string | undefined

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{"type":"ai-title"') && !line.startsWith('{"type":"custom-title"')) {
      continue
    }

    try {
      const row = record(JSON.parse(line))

      if (typeof row?.customTitle === 'string' && row.customTitle.trim() !== '') {
        custom = row.customTitle.trim()
      } else if (typeof row?.aiTitle === 'string' && row.aiTitle.trim() !== '') {
        generated = row.aiTitle.trim()
      }
    } catch {
      continue
    }
  }

  return custom ?? generated
}
