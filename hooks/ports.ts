// What the mod's own code may ask of Claude Code.
//
// A hooks module never hands the engine interface (`$`) to a function: every
// call is spelled `$.noun.method(...)` where it is made, so Claude Code can
// read off the source exactly what the mod does. register.tsx therefore
// builds these closures once, each spelling out its call, and the rest of
// the mod works through them. `claude plugin validate` lists every call.

import type { AgentInfo, FsEntry, FsStat, ProcessRunInit, ProcessRunResult, SessionUsage } from 'claude-code'

import type { CacheClock, CostRow, Preloaded } from '../types'

/** One session value: read it, or change it from what it is now. */
export type Cell<T> = {
  get: () => Promise<T>
  set: (change: (value: T) => T) => Promise<void>
}

/** The session values the recorder keeps (see ../types/index.d.ts). */
export type StateCells = {
  rows: Cell<CostRow[]>
  sessionUsd: Cell<number | null>
  promptNo: Cell<number>
  transcriptPath: Cell<string | null>
  cache: Cell<CacheClock>
  preloaded: Cell<Preloaded | null>
}

export type Ports = {
  /** Milliseconds since the epoch. */
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** A line in Claude Code's debug log. */
  debug: (text: string) => void
  fs: {
    read: (path: string) => Promise<string>
    /** A file's bytes, base64-encoded. */
    readBase64: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    list: (path: string) => Promise<readonly FsEntry[]>
    exists: (path: string) => Promise<boolean>
    stat: (path: string) => Promise<FsStat>
  }
  /** Runs a command by its argument vector: no shell. */
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** This plugin's own store, kept between sessions. */
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  session: {
    id: () => Promise<string>
    model: () => Promise<string>
    /** The status line's figures: cost, context window. */
    usage: () => Promise<SessionUsage>
    /** The same with the context window broken down as /context does. */
    breakdown: () => Promise<SessionUsage>
  }
  agents: () => Promise<readonly AgentInfo[]>
  /** Session values, kept across hot reloads. */
  state: StateCells
}
