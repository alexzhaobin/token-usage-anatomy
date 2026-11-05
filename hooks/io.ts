// File access for the mod: where things are, reading part of a transcript,
// and appending to a log file.
//
// The module's own file API reads and writes whole files of up to 4 MiB and
// cannot append. Transcripts outgrow that, and logs must be appended to, so
// for those two jobs this runs scripts/io.sh (macOS, Linux) or
// scripts/io.ps1 (Windows), each path and number passed as its own
// argument. Where no process can be run it falls back to the file API.

import type { Ports } from './ports'
import { dedupe, parseReducedLines, parseTitle, parseTranscriptLines } from './transcript'
import type { TranscriptEntry } from './transcript'

/** Files at or under this size are read whole with the file API. */
export const FS_READ_LIMIT = 4_000_000

export type Host = {
  isWindows: boolean
  /** The user's home folder, with forward slashes. */
  home: string
  /** Claude Code's configuration folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeDir: string
  /** This plugin's folder, with forward slashes. */
  pluginRoot: string
}

/** Forward slashes, no trailing slash: `C:\Users\me\` becomes `C:/Users/me`. */
export function slashes(path: string): string {
  const forward = path.replace(/\\/g, '/')

  return forward.length > 1 ? forward.replace(/\/+$/, '') : forward
}

/** Where things are, from the environment variables register.tsx reads. */
export function hostFrom(env: {
  os?: string
  userProfile?: string
  home?: string
  configDir?: string
  pluginRoot: string
}): Host {
  const isWindows = env.os === 'Windows_NT'
  const home = slashes((isWindows ? env.userProfile : undefined) ?? env.home ?? env.userProfile ?? '')
  const configDir = env.configDir?.trim()

  return {
    isWindows,
    home,
    claudeDir: configDir !== undefined && configDir !== '' ? slashes(configDir) : `${home}/.claude`,
    pluginRoot: slashes(env.pluginRoot),
  }
}

/** The argument vector that runs one of the helper script's commands. */
export function helperArgv(host: Host, args: readonly string[]): string[] {
  if (host.isWindows) {
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      `${host.pluginRoot}/scripts/io.ps1`,
      ...args,
    ]
  }

  return ['sh', `${host.pluginRoot}/scripts/io.sh`, ...args]
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

export type TranscriptRead = {
  entries: TranscriptEntry[]
  /** The byte offset the next read of this file starts from. */
  end: number
  via: 'fs' | 'process'
}

/** The size of a file, or undefined when it is not there. */
export async function sizeOf(ports: Ports, path: string): Promise<number | undefined> {
  try {
    return (await ports.fs.stat(path)).size
  } catch {
    return undefined
  }
}

/**
 * The assistant responses a transcript holds from `offset` on, one per
 * request. Undefined when the file cannot be read at all.
 */
export async function readTranscript(
  ports: Ports,
  host: Host,
  path: string,
  offset: number,
): Promise<TranscriptRead | undefined> {
  const size = await sizeOf(ports, path)

  if (size === undefined) {
    return undefined
  }

  if (size <= offset) {
    return { entries: [], end: size, via: 'fs' }
  }

  if (size <= FS_READ_LIMIT) {
    try {
      const bytes = bytesOf(await ports.fs.readBase64(path))
      const text = new TextDecoder().decode(bytes.subarray(Math.min(offset, bytes.length)))

      return { entries: dedupe(parseTranscriptLines(text)), end: bytes.length, via: 'fs' }
    } catch {
      // Grew past the limit between stat and read: use the helper.
    }
  }

  try {
    const run = await ports.run(helperArgv(host, ['assistant', path, String(offset)]), { timeoutMs: 20_000 })

    if (run.exitCode !== 0) {
      return undefined
    }

    // The helper read to the end of the file as it was then; the size taken
    // before it ran is a safe start for next time (a response read twice is
    // dropped by the callers' own de-duplication).
    return { entries: dedupe(parseReducedLines(run.stdout)), end: size, via: 'process' }
  } catch {
    return undefined
  }
}

/** The session's title from its transcript, if it has one. */
export async function readTitle(ports: Ports, host: Host, path: string): Promise<string | undefined> {
  const size = await sizeOf(ports, path)

  if (size === undefined) {
    return undefined
  }

  if (size <= FS_READ_LIMIT) {
    try {
      return parseTitle(await ports.fs.read(path))
    } catch {
      // Grew past the limit: use the helper.
    }
  }

  try {
    const run = await ports.run(helperArgv(host, ['titles', path]), { timeoutMs: 20_000 })

    return run.exitCode === 0 ? parseTitle(run.stdout) : undefined
  } catch {
    return undefined
  }
}

/**
 * Appends text to a file, creating it and its folder. Falls back to
 * rewriting the whole file with the file API where no process can be run,
 * which is safe because log files are kept under 2 MiB.
 */
export async function appendText(ports: Ports, host: Host, path: string, text: string): Promise<void> {
  try {
    const run = await ports.run(helperArgv(host, ['append', path]), { stdin: text, timeoutMs: 20_000 })

    if (run.exitCode === 0) {
      return
    }
  } catch {
    // No process: rewrite with the file API below.
  }

  const before = (await ports.fs.exists(path)) ? await ports.fs.read(path) : ''
  await ports.fs.write(path, before + text)
}
