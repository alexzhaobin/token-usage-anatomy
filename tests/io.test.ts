import { describe, expect, test } from 'claude-code/testing'

import { FS_READ_LIMIT, helperArgv, hostFrom, readTitle, readTranscript, slashes } from '../hooks/io'
import { HOST, fakeWorld } from './fakes'
import { REDUCED, TRANSCRIPT, TRANSCRIPT_LINES } from './fixtures/transcript'

const PATH = '/home/me/.claude/projects/p/s1.jsonl'

describe('hostFrom', () => {
  test('macOS and Linux', () => {
    expect(hostFrom({ home: '/Users/me', pluginRoot: '/plugins/tua/' })).toEqual({
      isWindows: false,
      home: '/Users/me',
      claudeDir: '/Users/me/.claude',
      pluginRoot: '/plugins/tua',
    })
  })

  test('Windows: the profile folder, forward slashes', () => {
    const host = hostFrom({ os: 'Windows_NT', userProfile: 'C:\\Users\\Me', pluginRoot: 'C:\\plugins\\tua' })
    expect(host).toMatchObject({ isWindows: true, home: 'C:/Users/Me', claudeDir: 'C:/Users/Me/.claude' })
    expect(helperArgv(host, ['append', 'C:/x.jsonl'])).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:/plugins/tua/scripts/io.ps1',
      'append',
      'C:/x.jsonl',
    ])
  })

  test('CLAUDE_CONFIG_DIR wins', () => {
    expect(hostFrom({ home: '/h', configDir: '/etc/claude\\', pluginRoot: '/p' }).claudeDir).toBe('/etc/claude')
    expect(slashes('/')).toBe('/')
  })
})

describe('readTranscript', () => {
  test('a small transcript is read with the file API, from the offset on', async () => {
    const world = fakeWorld()
    world.files.set(PATH, { text: TRANSCRIPT, mtimeMs: 1 })
    // Start after the first response's first line: its repeat line is still read.
    const offset = new TextEncoder().encode(TRANSCRIPT_LINES.slice(0, 3).join('\n') + '\n').length

    const read = await readTranscript(world.ports, HOST, PATH, offset)

    expect(read?.via).toBe('fs')
    expect(read?.entries.map(entry => entry.id)).toEqual(['req_A', 'req_B', 'req_C', 'req_D'])
    expect(read?.end).toBe(new TextEncoder().encode(TRANSCRIPT).length)
    expect(world.runs).toHaveLength(0)
  })

  test('nothing new past the end', async () => {
    const world = fakeWorld()
    world.files.set(PATH, { text: TRANSCRIPT, mtimeMs: 1 })
    const size = new TextEncoder().encode(TRANSCRIPT).length

    expect((await readTranscript(world.ports, HOST, PATH, size))?.entries).toEqual([])
  })

  test('a large transcript is read by the helper script, path and offset as arguments', async () => {
    const world = fakeWorld()
    world.files.set(PATH, { text: 'x'.repeat(FS_READ_LIMIT + 1), mtimeMs: 1 })
    world.assistantOutput = REDUCED

    const read = await readTranscript(world.ports, HOST, PATH, 1234)

    expect(read?.via).toBe('process')
    expect(read?.entries).toHaveLength(4)
    expect(world.runs[0]?.argv).toEqual(['sh', '/plugin/scripts/io.sh', 'assistant', PATH, '1234'])
  })

  test('a missing transcript reads as undefined', async () => {
    expect(await readTranscript(fakeWorld().ports, HOST, PATH, 0)).toBeUndefined()
  })

  test('the title', async () => {
    const world = fakeWorld()
    world.files.set(PATH, { text: TRANSCRIPT, mtimeMs: 1 })
    expect(await readTitle(world.ports, HOST, PATH)).toBe('Log field explainer')
  })
})
