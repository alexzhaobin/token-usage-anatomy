// End to end through Claude Code's own hook chain: the engine raises the
// events, the mod's hooks run, and the hooks registered here stand in for
// everything beneath (files, processes, the session).

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SCHEMA } from '../hooks/logbook'
import { base64Of } from './fakes'
import { TRANSCRIPT_LINES } from './fixtures/transcript'

const TRANSCRIPT = '/home/me/.claude/projects/p/session-1.jsonl'
const DIR = '/home/me/.claude/token-usage-anatomy'
const LOG = `${DIR}/session-1.jsonl`

/** The usage of the fixture's first response (req_A). */
const USAGE_A = {
  input_tokens: 10,
  cache_creation_input_tokens: 2_000,
  cache_read_input_tokens: 5_000,
  output_tokens: 300,
  model: 'claude-opus-5-5',
}

const lines = (from: number, to: number): string => TRANSCRIPT_LINES.slice(from, to).join('\n') + '\n'
const bytes = (text: string): number => new TextEncoder().encode(text).length

type World = {
  files: Map<string, string>
  engineUsd: number
  /** Makes every file and process call fail. */
  isBroken: boolean
  /** What the mod wrote to the debug log. */
  logs: string[]
}

function standIn(on: On): World {
  const world: World = { files: new Map(), engineUsd: 0, isBroken: false, logs: [] }
  const fail = (path: string) => {
    throw new Error(`ENOENT: ${path}`)
  }

  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: 'a.txt b.txt' }, text: 'a.txt b.txt' }))
  on('ui.log', (_, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 7_310, window: 1_000_000 }, rateLimits: [], cost: { usd: world.engineUsd } },
  }))
  on('agent.list', () => ({ value: [] }))

  on('fs.stat', (_, e) => {
    const text = world.isBroken ? undefined : world.files.get(e.path)

    return text === undefined ? fail(e.path) : { value: { kind: 'file', size: bytes(text), mtimeMs: 1, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = world.isBroken ? undefined : world.files.get(e.path)

    return text === undefined ? fail(e.path) : { value: e.as === 'bytes' ? { base64: base64Of(text) } : text }
  })
  on('fs.write', (_, e) => {
    if (world.isBroken) {
      fail(e.path)
    }

    world.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: world.files.has(e.path) }))
  on('fs.list', (_, e) => {
    const names = [...world.files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => path.slice(e.path.length + 1))

    return names.length === 0
      ? fail(e.path)
      : {
          value: names.map(name => ({
            name,
            kind: 'file',
            size: bytes(world.files.get(`${e.path}/${name}`) ?? ''),
            mtimeMs: 1,
            isLink: false,
          })),
        }
  })
  on('process.run', (_, e) => {
    const [, , command, path = ''] = e.argv

    if (world.isBroken || command !== 'append') {
      throw new Error('cannot run')
    }

    world.files.set(path, (world.files.get(path) ?? '') + (e.init?.stdin ?? ''))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // One model request: some thinking, an answer, then its usage.
  on('turn.step', async function* (_, e) {
    yield { kind: 'thinking', index: 0, text: 'Let me look.', ref: 1 }
    yield { kind: 'text', index: 1, text: 'Here is why.', ref: 2 }

    return { turnId: e.turnId, index: e.index, answer: 'Here is why.', toolUses: [], stopReason: 'end_turn', usage: USAGE_A }
  })

  return world
}

// The test runner has timers; the hooks environment's types do not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown

/** Lets the work the mod queued after a hook returned run, up to `ms` (about two seconds). */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  for (let i = 0; i < ms / 10 && !done(); i += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Reads a stream to its end and answers its return value: the response. */
async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<R> {
  let item = await stream.next()

  while (item.done !== true) {
    item = await stream.next()
  }

  return item.value
}

const rowsOf = (world: World, path = LOG): Array<Record<string, unknown>> =>
  (world.files.get(path) ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)

const promptRows = (world: World) => rowsOf(world).filter(row => row.kind === 'prompt')

describe('a prompt, end to end', () => {
  test('becomes one priced row, enriched from the transcript', async ($, on) => {
    const world = standIn(on)
    world.files.set(TRANSCRIPT, lines(0, 2))
    // The band's bars, as the mod writes them.
    const bars: unknown[] = []
    on('state.set', ($, e, next) => {
      if (e.plugin === 'token-usage-anatomy' && e.key === 'rows') {
        bars.push(e.value)
      }

      return next(e)
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT })
    await $.turn.start({ turnId: 't1', text: 'Explain the log fields' })

    // The request runs, and Claude Code writes its response to the transcript.
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
    world.files.set(TRANSCRIPT, lines(0, 4))
    await $.tool.call({ tool: 'Bash', command: 'ls' })

    world.engineUsd = 0.03
    await $.turn.complete({
      turnId: 't1',
      reason: 'answer',
      answer: 'Here is why.',
      durationMs: 1_200,
      isAborted: false,
      usage: USAGE_A,
    })
    await until(() => promptRows(world).length > 0)

    const [row] = promptRows(world)
    expect(row).toMatchObject({
      schema: SCHEMA,
      kind: 'prompt',
      promptNo: 1,
      requests: 1,
      inputTokens: 10,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 2_000,
      cacheWrite1hTokens: 2_000,
      cacheWrite5mTokens: 0,
      outputTokens: 300,
      // Reported by the API in the transcript, not estimated.
      reasoningTokens: 120,
      reasoningMethod: 'reported',
      transcriptRequests: 1,
      tools: { Bash: { calls: 1, resultChars: 11, errors: 0 } },
      // $4 x 10 + $0.20 x 5,000 + $8 x 2,000 + $20 x 300 per million tokens.
      estCostUsd: 0.02304,
      // The engine counted $0.03: the gap is shown, not hidden.
      unattributedUsd: 0.00696,
      overUsd: 0,
      contextAfterTokens: 7_310,
    })
    // The bar knows how many requests made it and the context they left.
    expect(JSON.stringify(bars.at(-1))).toContain('"requests":1,"context":{"tokens":7310,"window":1000000}')

    // Prompt text is off by default: neither the label nor the text is logged.
    expect(row?.label).toBeUndefined()
    expect(row?.prompt).toBeUndefined()

    // The viewer copy and the index are written beside the log.
    expect(world.files.get(`${DIR}/data/session-1.js`)?.startsWith('(window.TUA_DATA')).toBe(true)
    expect(world.files.has(`${DIR}/usage-index.js`)).toBe(true)
  })

  test('a turn with no usage gets no row and no number', async ($, on) => {
    const world = standIn(on)
    world.files.set(TRANSCRIPT, lines(0, 2))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
    await $.turn.start({ turnId: 't1', text: '/help' })
    await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 5, isAborted: true })
    // Nothing should happen: give anything queued a moment, well inside the test's time limit.
    await until(() => false, 500)

    expect(promptRows(world)).toEqual([])
  })
})

describe('options', () => {
  test(
    'prompt text and request rows when turned on, escaped in the viewer copy',
    { options: { includePromptText: true, recordRequests: true } },
    async ($, on) => {
      const world = standIn(on)
      world.files.set(TRANSCRIPT, lines(0, 2))
      const hostile = 'Why does </script><!-- break\u2028pages?'

      await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
      await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT })
      await $.turn.start({ turnId: 't1', text: hostile })
      await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
      world.files.set(TRANSCRIPT, lines(0, 4))
      await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 9, isAborted: false, usage: USAGE_A })
      await until(() => promptRows(world).length > 0)

      const rows = rowsOf(world)
      expect(rows.map(row => row.kind)).toEqual(['request', 'prompt'])
      expect(rows[1]).toMatchObject({ prompt: hostile, label: 'Why does </script><!-- break pages?' })

      const copy = world.files.get(`${DIR}/data/session-1.js`) ?? ''
      expect(copy.includes('</script>')).toBe(false)
      expect(copy.includes('\u2028')).toBe(false)
    },
  )
})

describe('robustness', () => {
  test('when every file and process call fails, turns still complete', async ($, on) => {
    const world = standIn(on)
    world.isBroken = true

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT })
    await $.turn.start({ turnId: 't1', text: 'hello' })
    const response = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
    expect(response.usage).toEqual(USAGE_A)

    const result = await $.turn.complete({
      turnId: 't1',
      reason: 'answer',
      answer: 'hi',
      durationMs: 3,
      isAborted: false,
      usage: USAGE_A,
    })
    // The prompt's job fails, is logged, and nothing reaches the session.
    await until(() => world.logs.some(line => line.includes('write prompt 1 failed')))

    expect(result.text).toBe('')
    expect(promptRows(world)).toEqual([])
    expect(world.logs.some(line => line.includes('write prompt 1 failed'))).toBe(true)
  })
})
