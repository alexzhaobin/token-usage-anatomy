import { describe, expect, test } from 'claude-code/testing'

import {
  Logbook,
  SCHEMA,
  SEGMENT_LIMIT,
  dataStatement,
  indexScript,
  parseSegmentName,
  scriptString,
  segmentName,
} from '../hooks/logbook'
import { HOST, fakeWorld, rowsIn } from './fakes'

const DIR = '/home/me/.claude/token-usage-anatomy'

// Prompts that try to break out of the viewer's <script> data files.
const HOSTILE = [
  '</script><script>alert(1)</script>',
  '<!-- <script> -->',
  'line\u2028separator\u2029paragraph',
  'quote " backslash \\ and \\u2028 written out',
  '`${template}` and \'single\'',
  'emoji 🧪 and \u0000 nul',
]

describe('scriptString', () => {
  test('hostile prompts cannot end the script, and read back exactly', () => {
    for (const text of HOSTILE) {
      const literal = scriptString(text)

      expect(literal.includes('<')).toBe(false)
      expect(literal.includes('\u2028')).toBe(false)
      expect(literal.includes('\u2029')).toBe(false)
      expect(JSON.parse(literal)).toBe(text)
    }
  })

  test('a data statement escapes both the session id and the rows', () => {
    const statement = dataStatement('id</script>', `{"prompt":${JSON.stringify(HOSTILE.join(' '))}}\n`)

    expect(statement.includes('</script>')).toBe(false)
    expect(statement.includes('<')).toBe(false)
    expect(statement.startsWith('(window.TUA_DATA = window.TUA_DATA || []).push([')).toBe(true)
  })
})

describe('segment names', () => {
  test('round trip', () => {
    expect(segmentName('abc', 1, 'jsonl')).toBe('abc.jsonl')
    expect(segmentName('abc', 3, 'js')).toBe('abc.3.js')
    expect(parseSegmentName('abc.jsonl')).toEqual({ sessionId: 'abc', segment: 1 })
    expect(parseSegmentName('abc.12.jsonl')).toEqual({ sessionId: 'abc', segment: 12 })
    expect(parseSegmentName('abc.js')).toBeUndefined()
    expect(parseSegmentName('usage-index.js')).toBeUndefined()
  })
})

describe('Logbook', () => {
  test('appends rows with the schema to the log and its viewer copy', async () => {
    const world = fakeWorld()
    const book = new Logbook(world.ports, HOST, DIR)

    await book.append('s1', [{ kind: 'prompt', at: 'now', promptNo: 1 }])
    await book.append('s1', [{ kind: 'prompt', at: 'later', promptNo: 2 }])

    expect(rowsIn(world, `${DIR}/s1.jsonl`)).toEqual([
      { schema: SCHEMA, kind: 'prompt', at: 'now', promptNo: 1 },
      { schema: SCHEMA, kind: 'prompt', at: 'later', promptNo: 2 },
    ])
    expect(world.files.get(`${DIR}/data/s1.js`)?.text.split('\n').filter(Boolean)).toHaveLength(2)
    // Appends go through the helper script, with the path as an argument.
    expect(world.runs[0]?.argv).toEqual(['sh', '/plugin/scripts/io.sh', 'append', `${DIR}/s1.jsonl`])
  })

  test('rolls over to a new segment before a file would pass 2 MiB', async () => {
    const world = fakeWorld()
    const book = new Logbook(world.ports, HOST, DIR)
    const big = 'x'.repeat(Math.floor(SEGMENT_LIMIT * 0.45))

    for (let n = 1; n <= 5; n += 1) {
      await book.append('s1', [{ kind: 'prompt', at: 'now', promptNo: n, pad: big }])
    }

    const sizes = ['s1.jsonl', 's1.2.jsonl', 's1.3.jsonl'].map(name => world.files.get(`${DIR}/${name}`)?.text.length ?? 0)
    expect(sizes.every(size => size > 0 && size <= SEGMENT_LIMIT)).toBe(true)
    expect(rowsIn(world, `${DIR}/s1.3.jsonl`).map(row => row.promptNo)).toEqual([5])
    expect(world.files.has(`${DIR}/data/s1.3.js`)).toBe(true)

    // After a reload a new logbook finds segment 3 and keeps filling it.
    const reloaded = new Logbook(world.ports, HOST, DIR)
    await reloaded.append('s1', [{ kind: 'prompt', at: 'now', promptNo: 6 }])
    expect(rowsIn(world, `${DIR}/s1.3.jsonl`).map(row => row.promptNo)).toEqual([5, 6])
  })

  test('falls back to the file API where no process can run', async () => {
    const world = fakeWorld()
    world.noProcess = true
    const book = new Logbook(world.ports, HOST, DIR)

    await book.append('s1', [{ kind: 'session', at: 'now', title: 'one' }])
    await book.append('s1', [{ kind: 'session', at: 'now', title: 'two' }])

    expect(rowsIn(world, `${DIR}/s1.jsonl`).map(row => row.title)).toEqual(['one', 'two'])
  })

  test('the index lists sessions newest first, with titles', async () => {
    const world = fakeWorld()
    const book = new Logbook(world.ports, HOST, DIR)
    book.setTitles({ old: 'An older session' })

    await book.append('old', [{ kind: 'prompt', at: 'a' }])
    await book.append('new', [{ kind: 'prompt', at: 'b' }])

    const script = world.files.get(`${DIR}/usage-index.js`)?.text ?? ''
    const json = JSON.parse(JSON.parse(script.slice(script.indexOf('JSON.parse(') + 11, script.lastIndexOf(')'))))
    expect(json.map((entry: { id: string }) => entry.id)).toEqual(['new', 'old'])
    expect(json[1]).toMatchObject({ id: 'old', title: 'An older session', segments: 1 })
  })

  test('the index escapes a hostile title', () => {
    const script = indexScript([{ id: 's', mtimeMs: 1, segments: 1, title: HOSTILE[0] }])
    expect(script.includes('</script>')).toBe(false)
  })

  test('refresh writes the price table and rebuilds missing or stale viewer copies', async () => {
    const world = fakeWorld()
    world.files.set(`${DIR}/s1.jsonl`, { text: '{"kind":"prompt"}\n', mtimeMs: 50 })
    world.files.set(`${DIR}/s2.jsonl`, { text: '{"kind":"prompt","n":2}\n', mtimeMs: 50 })
    world.files.set(`${DIR}/data/s2.js`, { text: 'old copy', mtimeMs: 10 })
    const book = new Logbook(world.ports, HOST, DIR)

    await book.refresh()

    expect(world.files.get(`${DIR}/pricing.js`)?.text.startsWith('window.TUA_PRICES = JSON.parse(')).toBe(true)
    expect(world.files.get(`${DIR}/data/s1.js`)?.text).toBe(dataStatement('s1', '{"kind":"prompt"}\n'))
    expect(world.files.get(`${DIR}/data/s2.js`)?.text).toBe(dataStatement('s2', '{"kind":"prompt","n":2}\n'))

    // A second refresh leaves unchanged files alone.
    const before = world.files.get(`${DIR}/pricing.js`)?.mtimeMs
    await book.refresh()
    expect(world.files.get(`${DIR}/pricing.js`)?.mtimeMs).toBe(before)
  })

  test('refresh installs the viewer page, and only rewrites it when it changed', async () => {
    const world = fakeWorld()
    world.files.set('/plugin/assets/viewer.html', { text: '<!doctype html><title>v1</title>', mtimeMs: 1 })
    const book = new Logbook(world.ports, HOST, DIR)

    await book.refresh()
    expect(world.files.get(`${DIR}/viewer.html`)?.text).toBe('<!doctype html><title>v1</title>')
    const installedAt = world.files.get(`${DIR}/viewer.html`)?.mtimeMs

    await book.refresh()
    expect(world.files.get(`${DIR}/viewer.html`)?.mtimeMs).toBe(installedAt)

    world.files.set('/plugin/assets/viewer.html', { text: '<!doctype html><title>v2</title>', mtimeMs: 2 })
    await book.refresh()
    expect(world.files.get(`${DIR}/viewer.html`)?.text).toBe('<!doctype html><title>v2</title>')
  })

  test('without its viewer page the folder is still refreshed', async () => {
    const world = fakeWorld()
    world.files.set(`${DIR}/s1.jsonl`, { text: '{"kind":"prompt"}\n', mtimeMs: 50 })
    const book = new Logbook(world.ports, HOST, DIR)

    await book.refresh()

    expect(world.logs.some(line => line.includes('viewer.html not installed'))).toBe(true)
    expect(world.files.has(`${DIR}/viewer.html`)).toBe(false)
    expect(world.files.has(`${DIR}/data/s1.js`)).toBe(true)
  })

  test('a failing job is logged and the queue goes on', async () => {
    const world = fakeWorld()
    const book = new Logbook(world.ports, HOST, DIR)

    await book.enqueue('break', async () => {
      throw new Error('boom')
    })
    await book.enqueue('write', () => book.append('s1', [{ kind: 'prompt', at: 'x' }]))

    expect(world.logs.some(line => line.includes('break failed: Error: boom'))).toBe(true)
    expect(rowsIn(world, `${DIR}/s1.jsonl`)).toHaveLength(1)
  })
})
