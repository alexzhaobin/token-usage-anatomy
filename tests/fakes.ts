// In-memory stand-ins for the ports (see hooks/ports.ts), so the log folder,
// the transcript reader and the recorder can be tested without Claude Code.

import type { FsEntry, FsStat, ProcessRunInit, ProcessRunResult, SessionUsage } from 'claude-code'

import type { Host } from '../hooks/io'
import type { Cell, Ports } from '../hooks/ports'
import { initialCache } from '../hooks/state'
import type { CostRow, Preloaded } from '../types'

export const HOST: Host = {
  isWindows: false,
  home: '/home/me',
  claudeDir: '/home/me/.claude',
  pluginRoot: '/plugin',
}

/** UTF-8 text as base64, as the file API's bytes read returns it. */
export function base64Of(text: string): string {
  let binary = ''

  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

const cell = <T,>(initial: T): Cell<T> & { value: T } => {
  const box = {
    value: initial,
    get: async () => box.value,
    set: async (change: (value: T) => T) => {
      box.value = change(box.value)
    },
  }

  return box
}

export type FakeWorld = {
  ports: Ports
  files: Map<string, { text: string; mtimeMs: number }>
  runs: Array<{ argv: readonly string[]; init?: ProcessRunInit }>
  store: Map<string, unknown>
  logs: string[]
  /** Makes `$.process.run` fail, as where no process can be run. */
  noProcess: boolean
  /** Answers the helper's `assistant` command. */
  assistantOutput: string
  usage: SessionUsage
  state: ReturnType<typeof cells>
}

const cells = () => ({
  rows: cell<CostRow[]>([]),
  sessionUsd: cell<number | null>(null),
  promptNo: cell(0),
  transcriptPath: cell<string | null>(null),
  cache: cell(initialCache),
  preloaded: cell<Preloaded | null>(null),
})

export function fakeWorld(): FakeWorld {
  let clock = 1_000

  const world: FakeWorld = {
    files: new Map(),
    runs: [],
    store: new Map(),
    logs: [],
    noProcess: false,
    assistantOutput: '',
    usage: { startedAt: 0, context: { tokens: 0, window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } },
    state: cells(),
    ports: undefined as unknown as Ports,
  }

  const list = async (dir: string): Promise<FsEntry[]> => {
    const entries = new Map<string, FsEntry>()

    for (const [path, file] of world.files) {
      if (!path.startsWith(`${dir}/`)) {
        continue
      }

      const rest = path.slice(dir.length + 1)
      const name = rest.split('/')[0] ?? rest
      const isDir = rest.includes('/')
      entries.set(name, {
        name,
        kind: isDir ? 'dir' : 'file',
        size: isDir ? 0 : new TextEncoder().encode(file.text).length,
        mtimeMs: isDir ? 0 : file.mtimeMs,
        isLink: false,
      } as FsEntry)
    }

    if (entries.size === 0) {
      throw new Error(`ENOENT: ${dir}`)
    }

    return [...entries.values()]
  }

  const write = (path: string, text: string): void => {
    clock += 1
    world.files.set(path, { text, mtimeMs: clock })
  }

  world.ports = {
    now: async () => (clock += 1),
    sleep: async () => {},
    debug: text => void world.logs.push(text),
    fs: {
      read: async path => {
        const file = world.files.get(path)

        if (file === undefined) {
          throw new Error(`ENOENT: ${path}`)
        }

        return file.text
      },
      readBase64: async path => base64Of(await world.ports.fs.read(path)),
      write: async (path, text) => write(path, text),
      list,
      exists: async path => world.files.has(path) || [...world.files.keys()].some(p => p.startsWith(`${path}/`)),
      stat: async path => {
        const file = world.files.get(path)

        if (file === undefined) {
          throw new Error(`ENOENT: ${path}`)
        }

        return { kind: 'file', size: new TextEncoder().encode(file.text).length, mtimeMs: file.mtimeMs, isLink: false } as FsStat
      },
    },
    run: async (argv, init): Promise<ProcessRunResult> => {
      world.runs.push({ argv, init })

      if (world.noProcess) {
        throw new Error('no process')
      }

      const [command, path] = [argv[2], argv[3] ?? '']

      if (command === 'append') {
        const before = world.files.get(path)?.text ?? ''
        write(path, before + (init?.stdin ?? ''))

        return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      }

      if (command === 'assistant') {
        return { exitCode: 0, stdout: world.assistantOutput, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      }

      return { exitCode: 2, stdout: '', stderr: 'unknown command', isStdoutTruncated: false, isStderrTruncated: false }
    },
    store: {
      get: async key => world.store.get(key),
      set: async (key, value) => void world.store.set(key, value),
    },
    session: {
      id: async () => 'session-1',
      model: async () => 'claude-opus-5-5',
      usage: async () => world.usage,
      breakdown: async () => world.usage,
    },
    agents: async () => [],
    state: world.state,
  }

  return world
}

/** The rows written to a log file, parsed. */
export function rowsIn(world: FakeWorld, path: string): Array<Record<string, unknown>> {
  const text = world.files.get(path)?.text ?? ''

  return text
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}
