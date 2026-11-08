import { describe, expect, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { buildPromptRow, labelOf, preloadedOf } from '../hooks/rows'
import { priceStep } from '../hooks/steps'
import type { Step } from '../hooks/steps'
import { Agents, subagentPath, summarise } from '../hooks/subagents'

const step = (overrides: Partial<Step> = {}): Step => ({
  index: 0,
  model: 'claude-sonnet-5-5',
  requestedModel: 'claude-sonnet-5-5',
  tokens: { inputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1_000 },
  hasUsage: true,
  stopReason: 'end_turn',
  toolUses: 0,
  chars: { thinking: 0, text: 4_000, toolInput: 0 },
  startedAt: 0,
  endedAt: 500,
  isCold: true,
  ...overrides,
})

/** Dollars in millionths, so float noise never fails a test. */
const micro = (usd: number): number => Math.round(usd * 1e6)

// $2 input + $10 output per million: 1,000 + 1,000 tokens cost $0.012.
const base = {
  at: '2026-11-05T00:00:00.000Z',
  promptNo: 3,
  turnId: 't',
  reason: 'answer',
  durationMs: 10,
  tools: {},
  transcriptRequests: 0,
}

describe('buildPromptRow', () => {
  test('engine growth beyond the priced requests is unattributed', () => {
    const built = buildPromptRow({ ...base, steps: [priceStep(step(), undefined)], engine: { deltaUsd: 0.02 } })

    expect(micro(built.unattributedUsd)).toBe(8_000)
    expect(built.overUsd).toBe(0)
    expect(built.row).toMatchObject({ estCostUsd: 0.012, cacheHitPct: 0, cacheMissRequests: 1, requests: 1 })
  })

  test('pricing above the engine is "over", never hidden', () => {
    const built = buildPromptRow({ ...base, steps: [priceStep(step(), undefined)], engine: { deltaUsd: 0.002 } })

    expect(built.unattributedUsd).toBe(0)
    expect(micro(built.overUsd)).toBe(10_000)
  })

  test('a difference under half a tenth of a cent is noise', () => {
    const built = buildPromptRow({ ...base, steps: [priceStep(step(), undefined)], engine: { deltaUsd: 0.0122 } })

    expect([built.unattributedUsd, built.overUsd]).toEqual([0, 0])
  })

  test('with no steps, the turn usage is priced as one request', () => {
    const built = buildPromptRow({
      ...base,
      steps: [],
      fallbackUsage: {
        input_tokens: 1_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: 'claude-sonnet-5-5',
      },
      engine: {},
    })

    expect(built.row.estCostUsd).toBe(0.012)
  })

  test('no prompt text unless given', () => {
    const built = buildPromptRow({ ...base, steps: [], engine: {} })

    expect('label' in built.row).toBe(false)
    expect('prompt' in built.row).toBe(false)
  })
})

describe('labelOf', () => {
  test('first words, whitespace collapsed, cut at 40', () => {
    expect(labelOf('  fix\n\n the   parser ')).toBe('fix the parser')
    expect(labelOf('')).toBe('(continued)')
    expect(labelOf('a'.repeat(60))).toHaveLength(40)
  })
})

describe('preloadedOf', () => {
  test('every used category but the messages, largest first', () => {
    const usage = {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 1_000_000,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 6_000, kind: 'used', isDeferred: false, color: '' },
            { name: 'Messages', tokens: 50_000, kind: 'used', isDeferred: false, color: '' },
            { name: 'System tools', tokens: 12_500, kind: 'used', isDeferred: false, color: '' },
            { name: 'Free space', tokens: 900_000, kind: 'free', isDeferred: false, color: '' },
          ],
        },
      },
    } as unknown as SessionUsage

    expect(preloadedOf(usage)).toEqual({
      tokens: 18_500,
      window: 1_000_000,
      parts: [
        { name: 'System tools', tokens: 12_500 },
        { name: 'System prompt', tokens: 6_000 },
      ],
    })
  })
})

describe('subagents', () => {
  test('their transcripts sit beside the session transcript', () => {
    expect(subagentPath('/p/abc.jsonl', 'a1')).toBe('/p/abc/subagents/agent-a1.jsonl')
  })

  test('a run that outlasts its prompt: started in one row, finished in the next', () => {
    const agents = new Agents()

    // Prompt 1: the agent starts and is still running when the prompt ends.
    agents.started('a1')
    agents.started('a1') // a second turn of the same run is not a second start
    const first = agents.pending()
    expect(first.map(agent => ({ starts: agent.starts, runs: agent.runs, isRunning: agent.isRunning }))).toEqual([
      { starts: 1, runs: 0, isRunning: true },
    ])
    agents.settle(first)

    // Prompt 2: it finishes, having started earlier.
    agents.ended('a1')
    const second = agents.pending()
    expect(second.map(agent => ({ starts: agent.starts, runs: agent.runs, isRunning: agent.isRunning }))).toEqual([
      { starts: 0, runs: 1, isRunning: false },
    ])
    agents.settle(second)

    // Finished agents are forgotten; a new run counts afresh.
    expect(agents.pending()).toEqual([])
    agents.started('a1')
    expect(agents.pending()[0]?.starts).toBe(1)
  })

  test('summed per prompt, with each agent listed', () => {
    const agent = { id: 'a1', steps: [], starts: 1, runs: 1, isRunning: false, tools: { Read: { calls: 2, resultChars: 80, errors: 0 } }, offset: 0, seen: new Set<string>() }
    const summary = summarise([{ agent, steps: [priceStep(step(), undefined)], type: 'Explore', description: 'Find the parser' }])

    expect(summary).toMatchObject({ starts: 1, runs: 1, agentCount: 1, requests: 1, estCostUsd: 0.012 })
    expect(summary?.agents[0]).toMatchObject({ id: 'a1', type: 'Explore', starts: 1, runs: 1, requests: 1, tools: { Read: { calls: 2 } } })
    expect(summarise([])).toBeUndefined()
  })
})
