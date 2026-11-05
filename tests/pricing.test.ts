import { describe, expect, test } from 'claude-code/testing'

import { PRICES } from '../hooks/prices'
import {
  addParts,
  costParts,
  estimateSplit,
  modelKey,
  priceFor,
  ratesFor,
  total,
  zeroParts,
} from '../hooks/pricing'
import type { CostParts, RequestTokens } from '../hooks/pricing'

// Dollar figures are compared at a billionth of a dollar, so floating point
// noise never fails a test.
const usd = (value: number): number => Math.round(value * 1e9) / 1e9
const rounded = (parts: CostParts): CostParts => ({
  input: usd(parts.input),
  cacheRead: usd(parts.cacheRead),
  cacheWrite: usd(parts.cacheWrite),
  reasoning: usd(parts.reasoning),
  answer: usd(parts.answer),
})

// One typical agentic request: a long cached prefix, a fresh cache write
// split between 5-minute and 1-hour entries, and some thinking.
const REQUEST: RequestTokens = {
  inputTokens: 1_000,
  cacheReadTokens: 100_000,
  cacheCreationTokens: 5_000,
  cacheWrite5mTokens: 2_000,
  outputTokens: 3_000,
  reasoningTokens: 1_200,
}

describe('modelKey', () => {
  test('strips provider prefixes, suffixes, versions and dates', () => {
    expect(modelKey('claude-opus-5-5')).toBe('opus-5-5')
    expect(modelKey('global.anthropic.claude-sonnet-5-5')).toBe('sonnet-5-5')
    expect(modelKey('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('haiku-4-5')
    expect(modelKey('claude-opus-5-5[1m]')).toBe('opus-5-5')
    expect(modelKey('claude-opus-4-5@20251101')).toBe('opus-4-5')
    expect(modelKey('claude-3-5-haiku-20241022')).toBe('3-5-haiku')
    expect(modelKey('anthropic/claude-sonnet-4-6')).toBe('sonnet-4-6')
    expect(modelKey('  Claude-Opus-5  ')).toBe('opus-5')
  })
})

describe('priceFor', () => {
  test('matches the most specific entry', () => {
    expect(priceFor('claude-opus-4-5').entry.name).toBe('Claude Opus 4.5')
    expect(priceFor('claude-opus-4-1-20250805').entry.name).toBe('Claude Opus 4.1')
    expect(priceFor('claude-opus-4-20250514').entry.name).toBe('Claude Opus 4')
    expect(priceFor('claude-opus-5').entry.name).toBe('Claude Opus 5')
    expect(priceFor('claude-fable-5-1').entry.name).toBe('Claude Fable 5.1')
    expect(priceFor('claude-3-5-haiku-20241022').entry.name).toBe('Claude Haiku 3.5')
    expect(priceFor('claude-sonnet-5-5').isKnown).toBe(true)
  })

  test('a key never matches a longer version number', () => {
    // opus-4-5 must not price opus-4-51, and opus-4 must not price a
    // future opus-4-9: both fall back to the newest Opus.
    const future = priceFor('claude-opus-4-9')
    expect(future.isKnown).toBe(false)
    expect(future.entry.name).toBe('Claude Opus 5.5')
    expect(priceFor('claude-opus-4-51').isKnown).toBe(false)
  })

  test('an unknown model falls back to its family, then to the default', () => {
    expect(priceFor('claude-haiku-9').entry.name).toBe('Claude Haiku 5.5')
    expect(priceFor('claude-mythos-preview').entry.name).toBe('Claude Mythos 5.1')

    const unknown = priceFor('some-other-model')
    expect(unknown.isKnown).toBe(false)
    expect(unknown.entry.name).toBe('Claude Sonnet 5.5')
  })
})

describe('the price table', () => {
  test('is dated and sourced', () => {
    expect(PRICES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(PRICES.sourceUrl).toMatch(/^https:\/\//)
  })

  test('every row keeps the standard cache write multipliers', () => {
    for (const entry of PRICES.models) {
      const tiers = [entry.rates, ...(entry.longPrompt ? [entry.longPrompt.rates] : [])]

      for (const rates of tiers) {
        expect([entry.name, usd(rates.write5m)]).toEqual([entry.name, usd(rates.input * 1.25)])
        expect([entry.name, usd(rates.write1h)]).toEqual([entry.name, usd(rates.input * 2)])
        expect([0.1, 0.05, 0.025]).toContain(usd(rates.cacheRead / rates.input))
      }
    }
  })

  test('no key appears twice', () => {
    const keys = PRICES.models.flatMap(entry => entry.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('costParts', () => {
  test('prices a request by part (worked example)', () => {
    // Claude Opus 5.5 at $4 input, $0.20 cache read, $5 / $8 cache writes
    // (5 minutes / 1 hour), $20 output, per million tokens:
    //   input       1,000 x $4    = $0.004
    //   cache read  100,000 x $0.20 = $0.020
    //   cache write 2,000 x $5 + 3,000 x $8 = $0.034
    //   reasoning   1,200 x $20   = $0.024
    //   answer      1,800 x $20   = $0.036
    //   total                       $0.118
    const parts = costParts(REQUEST, 'claude-opus-5-5')

    expect(rounded(parts)).toEqual({
      input: 0.004,
      cacheRead: 0.02,
      cacheWrite: 0.034,
      reasoning: 0.024,
      answer: 0.036,
    })
    expect(usd(total(parts))).toBe(0.118)
  })

  test('fast mode uses the fast rates with cache multipliers on top', () => {
    // $8 input, $40 output; cache read 0.05x = $0.40, writes $10 / $16.
    const parts = costParts({ ...REQUEST, isFast: true }, 'claude-opus-5-5')

    expect(rounded(parts)).toEqual({
      input: 0.008,
      cacheRead: 0.04,
      cacheWrite: 0.068,
      reasoning: 0.048,
      answer: 0.072,
    })
    expect(usd(total(parts))).toBe(0.236)
  })

  test('fast mode on Opus 5 reads the cache at 0.1x the fast input', () => {
    const rates = ratesFor(priceFor('claude-opus-5').entry, { ...REQUEST, isFast: true })
    expect(usd(rates.cacheRead)).toBe(1)
  })

  test('a fast flag on a model with no fast rates keeps the standard rates', () => {
    const plain = costParts(REQUEST, 'claude-sonnet-5-5')
    const flagged = costParts({ ...REQUEST, isFast: true }, 'claude-sonnet-5-5')
    expect(rounded(flagged)).toEqual(rounded(plain))
  })

  test('US-only inference multiplies every part by 1.1, fast included', () => {
    expect(usd(total(costParts({ ...REQUEST, isUsOnly: true }, 'claude-opus-5-5')))).toBe(0.1298)
    expect(usd(total(costParts({ ...REQUEST, isUsOnly: true, isFast: true }, 'claude-opus-5-5')))).toBe(
      0.2596,
    )
  })

  test('Haiku 5.5 prompts over 100,000 tokens pay the long-prompt rates', () => {
    const at = { inputTokens: 1_000, cacheReadTokens: 99_000, cacheCreationTokens: 0, outputTokens: 0 }
    expect(rounded(costParts(at, 'claude-haiku-5-5'))).toEqual({
      input: 0.0001,
      cacheRead: 0.00099,
      cacheWrite: 0,
      reasoning: 0,
      answer: 0,
    })

    // One cache-write token takes the prompt over the threshold: the whole
    // request, cache reads included, is priced at the higher rates.
    const over = { ...at, cacheCreationTokens: 1 }
    expect(rounded(costParts(over, 'claude-haiku-5-5'))).toEqual({
      input: 0.0005,
      cacheRead: 0.00495,
      cacheWrite: 0.000001,
      reasoning: 0,
      answer: 0,
    })

    // US-only applies to the long-prompt rates too.
    const usOver = costParts({ ...over, isUsOnly: true }, 'claude-haiku-5-5')
    expect(usd(usOver.cacheRead)).toBe(0.005445)
  })

  test('cache writes of unknown length are priced as 1-hour', () => {
    const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, outputTokens: 0 }
    expect(usd(costParts(tokens, 'claude-sonnet-5-5').cacheWrite)).toBe(4)
    expect(usd(costParts({ ...tokens, cacheWrite5mTokens: 1_000_000 }, 'claude-sonnet-5-5').cacheWrite)).toBe(
      2.5,
    )
    // A 5-minute count above the writes is capped at the writes.
    expect(usd(costParts({ ...tokens, cacheWrite5mTokens: 9_000_000 }, 'claude-sonnet-5-5').cacheWrite)).toBe(
      2.5,
    )
  })

  test('reasoning is capped at the output tokens', () => {
    const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 100, reasoningTokens: 500 }
    const parts = costParts(tokens, 'claude-sonnet-5-5')
    expect(usd(parts.reasoning)).toBe(0.001)
    expect(parts.answer).toBe(0)
  })

  test('negative or missing counts cost nothing', () => {
    const tokens = { inputTokens: -5, cacheReadTokens: Number.NaN, cacheCreationTokens: 0, outputTokens: 0 }
    expect(total(costParts(tokens, 'claude-sonnet-5-5'))).toBe(0)
  })
})

describe('estimateSplit', () => {
  test('splits by streamed characters when thinking text streamed', () => {
    expect(estimateSplit(1_000, 300, 600, 100)).toEqual({ reasoningTokens: 300, method: 'proportional' })
  })

  test('takes thinking as the residual when none streamed', () => {
    // 800 text chars / 4 + 320 tool chars / 3.2 = 300 visible tokens.
    expect(estimateSplit(1_000, 0, 800, 320)).toEqual({ reasoningTokens: 700, method: 'residual' })
  })

  test('never estimates more visible tokens than the output', () => {
    expect(estimateSplit(100, 0, 4_000, 0)).toEqual({ reasoningTokens: 0, method: 'residual' })
    expect(estimateSplit(0, 0, 0, 0)).toEqual({ reasoningTokens: 0, method: 'residual' })
  })
})

describe('part helpers', () => {
  test('add and total', () => {
    const one = { input: 1, cacheRead: 2, cacheWrite: 3, reasoning: 4, answer: 5 }
    expect(addParts(zeroParts(), one)).toEqual(one)
    expect(total(addParts(one, one))).toBe(30)
  })
})
