// Cost maths. Pure functions over the price table in prices.ts.
//
// Pricing is per request, never per prompt: a request's rates depend on
// its own prompt length (long-prompt tiers), its speed and where it ran.

import { PRICES } from './prices'
import type { PriceEntry, PriceTable, Rates } from './prices'

/** The four token counts every usage report carries. */
export type Tokens = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** One request's tokens plus what the transcript adds to them. */
export type RequestTokens = Tokens & {
  /** Cache writes known to be 5-minute entries; the rest are 1-hour. */
  cacheWrite5mTokens?: number
  /** Output tokens spent thinking (reported or estimated). */
  reasoningTokens?: number
  /** The request ran in fast mode (`speed: "fast"`). */
  isFast?: boolean
  /** The request ran with US-only inference (`inference_geo: "us"`). */
  isUsOnly?: boolean
}

/** What a request cost, by part, in US dollars. */
export type CostParts = {
  input: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  answer: number
}

/** How a request's thinking tokens were obtained. */
export type ReasoningMethod = 'reported' | 'proportional' | 'residual'

export type PriceMatch = {
  entry: PriceEntry
  /** The key the model was reduced to. */
  key: string
  /** False when the model is not in the table and was priced by family or default. */
  isKnown: boolean
}

const PER_TOKEN = 1 / 1_000_000

/**
 * Reduces a model id to the table's key: lowercase, provider prefixes,
 * `claude-`, a `[1m]`-style suffix, a Vertex `@version`, a Bedrock
 * `-v1:0` and a `-YYYYMMDD` date removed.
 *
 * @example modelKey('global.anthropic.claude-sonnet-5-5') // 'sonnet-5-5'
 * @example modelKey('claude-opus-5-5[1m]') // 'opus-5-5'
 */
export function modelKey(model: string): string {
  let key = model.trim().toLowerCase()
  key = key.replace(/\[[^\]]*\]$/, '')
  key = key.replace(/@.*$/, '')
  key = key.replace(/^.*anthropic\./, '')
  key = key.replace(/^.*\//, '')
  key = key.replace(/^claude-/, '')
  key = key.replace(/-v\d+(:\d+)?$/, '')
  key = key.replace(/-\d{8}$/, '')

  return key
}

function isKeyMatch(key: string, name: string): boolean {
  if (key === name) {
    return true
  }

  if (!key.startsWith(name)) {
    return false
  }

  // What follows the name must not continue its version number: `opus-4`
  // prices `opus-4-thinking` but neither `opus-45` nor a future `opus-4-9`.
  const rest = key.slice(name.length)

  return !/^-?\d/.test(rest)
}

/**
 * Finds the price entry for a model: an exact or prefix match on a key
 * (`opus-4` does not match `opus-4-9`), else the newest model of the
 * family named in the key, else the table's default.
 */
export function priceFor(model: string, table: PriceTable = PRICES): PriceMatch {
  const key = modelKey(model)
  const exact = table.models.find(entry => entry.keys.some(name => isKeyMatch(key, name)))

  if (exact !== undefined) {
    return { entry: exact, key, isKnown: true }
  }

  const family = table.families.find(name => key.includes(name))
  const newest =
    family === undefined
      ? undefined
      : table.models.find(entry => entry.keys.some(name => name.startsWith(family)))
  const fallback =
    newest ??
    table.models.find(entry => entry.keys.includes(table.defaultKey)) ??
    table.models[0]

  return { entry: fallback, key, isKnown: false }
}

function scale(rates: Rates, factor: number): Rates {
  return {
    input: rates.input * factor,
    output: rates.output * factor,
    cacheRead: rates.cacheRead * factor,
    write5m: rates.write5m * factor,
    write1h: rates.write1h * factor,
  }
}

/** All the input a request's prompt holds: uncached, cache reads and cache writes. */
export function promptTokens(tokens: Tokens): number {
  return tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens
}

/**
 * The rates one request pays: fast mode if it ran fast (cache multipliers
 * on top), else the long-prompt tier if its prompt is over the threshold,
 * else the standard rates; then the US-only multiplier if it applies.
 */
export function ratesFor(entry: PriceEntry, tokens: RequestTokens, table: PriceTable = PRICES): Rates {
  let rates = entry.rates

  if (tokens.isFast === true && entry.fast !== undefined) {
    const readMultiplier = entry.rates.cacheRead / entry.rates.input
    rates = {
      input: entry.fast.input,
      output: entry.fast.output,
      cacheRead: entry.fast.input * readMultiplier,
      write5m: entry.fast.input * 1.25,
      write1h: entry.fast.input * 2,
    }
  } else if (entry.longPrompt !== undefined && promptTokens(tokens) > entry.longPrompt.overTokens) {
    rates = entry.longPrompt.rates
  }

  return tokens.isUsOnly === true ? scale(rates, table.usOnlyMultiplier) : rates
}

const nonNegative = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) || value < 0 ? 0 : value

/**
 * What one request cost, by part. Cache writes not known to be 5-minute
 * are priced as 1-hour, since Claude Code writes 1-hour entries; reasoning
 * is capped at the output tokens, and answer is the rest of the output.
 */
export function costParts(tokens: RequestTokens, model: string, table: PriceTable = PRICES): CostParts {
  const rates = ratesFor(priceFor(model, table).entry, tokens, table)
  const output = nonNegative(tokens.outputTokens)
  const writes = nonNegative(tokens.cacheCreationTokens)
  const writes5m = Math.min(writes, nonNegative(tokens.cacheWrite5mTokens))
  const reasoning = Math.min(output, nonNegative(tokens.reasoningTokens))

  return {
    input: nonNegative(tokens.inputTokens) * rates.input * PER_TOKEN,
    cacheRead: nonNegative(tokens.cacheReadTokens) * rates.cacheRead * PER_TOKEN,
    cacheWrite: (writes5m * rates.write5m + (writes - writes5m) * rates.write1h) * PER_TOKEN,
    reasoning: reasoning * rates.output * PER_TOKEN,
    answer: (output - reasoning) * rates.output * PER_TOKEN,
  }
}

/**
 * Splits output tokens into thinking and answer when the API reported no
 * thinking count, from the characters each part streamed.
 *
 * Thinking text streamed: thinking's share of all streamed characters
 * (`proportional`). None streamed (summarised or hidden thinking): the
 * visible text and tool input are counted at about 4 and 3.2 characters a
 * token, and thinking is what is left (`residual`).
 */
export function estimateSplit(
  outputTokens: number,
  thinkingChars: number,
  textChars: number,
  toolChars: number,
): { reasoningTokens: number; method: Exclude<ReasoningMethod, 'reported'> } {
  const output = nonNegative(outputTokens)
  const thinking = nonNegative(thinkingChars)
  const text = nonNegative(textChars)
  const tool = nonNegative(toolChars)

  if (thinking > 0) {
    const share = thinking / (thinking + text + tool)

    return { reasoningTokens: Math.round(output * share), method: 'proportional' }
  }

  const visible = Math.min(output, Math.round(text / 4 + tool / 3.2))

  return { reasoningTokens: output - visible, method: 'residual' }
}

export function zeroParts(): CostParts {
  return { input: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, answer: 0 }
}

export function addParts(a: CostParts, b: CostParts): CostParts {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    answer: a.answer + b.answer,
  }
}

export function total(parts: CostParts): number {
  return parts.input + parts.cacheRead + parts.cacheWrite + parts.reasoning + parts.answer
}
