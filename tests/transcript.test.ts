import { describe, expect, test } from 'claude-code/testing'

import { dedupe, matchSteps, parseReducedLines, parseTitle, parseTranscriptLines, usageKey } from '../hooks/transcript'
import { REDUCED, TRANSCRIPT } from './fixtures/transcript'

describe('parseTranscriptLines', () => {
  const entries = dedupe(parseTranscriptLines(TRANSCRIPT))

  test('finds each response once, skipping prompts, attachments and repeats', () => {
    expect(entries.map(entry => entry.id)).toEqual(['req_A', 'req_B', 'req_C', 'req_D'])
  })

  test('reads what the hooks leave out', () => {
    expect(entries[0]).toMatchObject({
      inputTokens: 10,
      cacheCreationTokens: 2_000,
      cacheReadTokens: 5_000,
      outputTokens: 300,
      thinkingTokens: 120,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 2_000,
      isFast: false,
      isUsOnly: false,
      isSidechain: false,
    })
    expect(entries[1]).toMatchObject({ isFast: true, isUsOnly: true, cacheWrite5mTokens: 300 })
    expect(entries[1]?.thinkingTokens).toBeUndefined()
    expect(entries[2]?.isSidechain).toBe(true)
  })

  test('reads the response usage, not a decoy inside a tool input', () => {
    expect(entries[3]).toMatchObject({ inputTokens: 3, outputTokens: 40, cacheReadTokens: 8_000 })
  })

  test('skips a line cut short', () => {
    const cut = TRANSCRIPT.slice(TRANSCRIPT.indexOf('{"parentUuid":"p"') + 5)
    expect(dedupe(parseTranscriptLines(cut)).map(entry => entry.id)).toEqual(['req_A', 'req_B', 'req_C', 'req_D'])
    const halfLine = TRANSCRIPT.slice(0, TRANSCRIPT.indexOf('"requestId":"req_A"'))
    expect(parseTranscriptLines(halfLine)).toEqual([])
  })
})

describe('parseReducedLines', () => {
  test('reads the helper scripts output the same as the JSON lines', () => {
    expect(dedupe(parseReducedLines(REDUCED))).toEqual(dedupe(parseTranscriptLines(TRANSCRIPT)))
  })

  test('accepts Windows line ends and skips short lines', () => {
    const windows = REDUCED.replace(/\n/g, '\r\n') + '\r\nnot\ta\tline\r\n'
    expect(dedupe(parseReducedLines(windows))).toHaveLength(4)
  })
})

describe('matchSteps', () => {
  const tokens = (inputTokens: number) => ({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 })
  const entry = (id: string, inputTokens: number) => ({
    ...tokens(inputTokens),
    id,
    isSidechain: false,
    isFast: false,
    isUsOnly: false,
  })

  test('pairs requests by their four counts, first come first served', () => {
    const entries = [entry('x', 5), entry('y', 7), entry('z', 5)]
    const matched = matchSteps([{ tokens: tokens(5) }, { tokens: tokens(5) }, { tokens: tokens(9) }], entries)
    expect(matched.map(m => m?.id)).toEqual(['x', 'z', undefined])
  })

  test('usage keys name all four counts', () => {
    expect(usageKey({ inputTokens: 1, cacheCreationTokens: 2, cacheReadTokens: 3, outputTokens: 4 })).toBe('1/2/3/4')
  })
})

describe('parseTitle', () => {
  test('a /rename title beats a generated one, even a later one', () => {
    expect(parseTitle(TRANSCRIPT)).toBe('Log field explainer')
  })

  test('the last generated title when there is no /rename', () => {
    const lines = TRANSCRIPT.split('\n').filter(line => !line.includes('custom-title'))
    expect(parseTitle(lines.join('\n'))).toBe('A later generated title')
    expect(parseTitle('')).toBeUndefined()
  })
})
