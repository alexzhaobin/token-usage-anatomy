// The log folder: append-only JSONL rows, their copies the viewer can load
// from disk, the session index and the price table.
//
//   <logDir>/<id>.jsonl, <id>.2.jsonl, ...   rows, one JSON object per line
//   <logDir>/data/<id>.js, <id>.2.js, ...     the same rows for viewer.html
//   <logDir>/usage-index.js                  sessions, newest first
//   <logDir>/pricing.js                      the price table the rows used
//   <logDir>/viewer.html                     a copy of assets/viewer.html
//
// A session's rows roll over to a new segment before a file would pass
// 2 MiB, so every file stays readable whole by the module's own file API.
// A page opened from file:// cannot fetch a .jsonl, hence the data/*.js
// copies; their text is escaped so no prompt can end the script early.

import { appendText, slashes } from './io'
import type { Host } from './io'
import type { Ports } from './ports'
import { PRICES } from './prices'

/** Every row carries this. Additive changes keep it; a breaking one bumps it. */
export const SCHEMA = 'token-usage-anatomy/1'

/** No log segment grows past this many bytes. */
export const SEGMENT_LIMIT = 2 * 1024 * 1024

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/**
 * A JavaScript string literal that is safe inside an HTML page: JSON
 * quoting, with `<` (so no `</script>` or `<!--`) and the two line
 * separators JavaScript once treated as line ends written as escapes.
 */
export function scriptString(text: string): string {
  return JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** One batch of rows as a statement data/<id>.js can hold. */
export function dataStatement(sessionId: string, text: string): string {
  return `(window.TUA_DATA = window.TUA_DATA || []).push([${scriptString(sessionId)}, ${scriptString(text)}]);\n`
}

export function segmentName(sessionId: string, segment: number, extension: 'jsonl' | 'js'): string {
  return segment <= 1 ? `${sessionId}.${extension}` : `${sessionId}.${segment}.${extension}`
}

/** `abc.jsonl` is segment 1 of abc, `abc.3.jsonl` segment 3. */
export function parseSegmentName(name: string): { sessionId: string; segment: number } | undefined {
  const match = /^(.+?)(?:\.(\d+))?\.jsonl$/.exec(name)

  if (match === null || match[1] === undefined) {
    return undefined
  }

  return { sessionId: match[1], segment: match[2] === undefined ? 1 : Number(match[2]) }
}

export type IndexEntry = {
  id: string
  mtimeMs: number
  segments: number
  title?: string
}

/** The index the viewer reads, newest session first. */
export function indexScript(entries: readonly IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)

  return `window.TUA_INDEX = JSON.parse(${scriptString(JSON.stringify(sorted))});\n`
}

export function pricingScript(): string {
  return `window.TUA_PRICES = JSON.parse(${scriptString(JSON.stringify(PRICES))});\n`
}

export type Row = { kind: string; [field: string]: unknown }

type Segment = { segment: number; size: number }

/**
 * Writes rows in order, one at a time, after whatever was queued before:
 * the viewer install first, then each prompt's rows. A failure is logged
 * and the queue goes on; nothing here throws into a hook.
 */
export class Logbook {
  readonly dir: string
  private queue: Promise<void> = Promise.resolve()
  private readonly segments = new Map<string, Segment>()
  private titles: Record<string, string> = {}

  constructor(
    private readonly ports: Ports,
    private readonly host: Host,
    dir: string,
  ) {
    this.dir = slashes(dir)
  }

  /** Runs `job` after everything queued so far; never rejects. */
  enqueue(label: string, job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).catch((error: unknown) => {
      this.ports.debug(`token-usage-anatomy: ${label} failed: ${String(error)}`)
    })

    return this.queue
  }

  setTitles(titles: Record<string, string>): void {
    this.titles = titles
  }

  private async currentSegment(sessionId: string): Promise<Segment> {
    const known = this.segments.get(sessionId)

    if (known !== undefined) {
      return known
    }

    // After a reload: find the newest segment already on disk.
    let segment = 1
    let size = 0

    try {
      for (const entry of await this.ports.fs.list(this.dir)) {
        const parsed = parseSegmentName(entry.name)

        if (parsed?.sessionId === sessionId && parsed.segment >= segment) {
          segment = parsed.segment
          size = entry.size
        }
      }
    } catch {
      // No folder yet: segment 1, empty.
    }

    const found = { segment, size }
    this.segments.set(sessionId, found)

    return found
  }

  /** Appends rows to the session's log and its viewer copy. Call inside `enqueue`. */
  async append(sessionId: string, rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) {
      return
    }

    const text = rows.map(row => JSON.stringify({ schema: SCHEMA, ...row })).join('\n') + '\n'
    const bytes = byteLength(text)
    const current = await this.currentSegment(sessionId)

    if (current.size > 0 && current.size + bytes > SEGMENT_LIMIT) {
      current.segment += 1
      current.size = 0
    }

    await appendText(this.ports, this.host, `${this.dir}/${segmentName(sessionId, current.segment, 'jsonl')}`, text)
    await appendText(
      this.ports,
      this.host,
      `${this.dir}/data/${segmentName(sessionId, current.segment, 'js')}`,
      dataStatement(sessionId, text),
    )
    current.size += bytes
    await this.writeIndex()
  }

  /** The sessions in the folder, from its file listing. */
  async listSessions(): Promise<IndexEntry[]> {
    const sessions = new Map<string, IndexEntry>()

    for (const entry of await this.ports.fs.list(this.dir)) {
      const parsed = entry.kind === 'file' ? parseSegmentName(entry.name) : undefined

      if (parsed === undefined) {
        continue
      }

      const known = sessions.get(parsed.sessionId)
      const title = this.titles[parsed.sessionId]
      sessions.set(parsed.sessionId, {
        id: parsed.sessionId,
        mtimeMs: Math.max(known?.mtimeMs ?? 0, entry.mtimeMs),
        segments: Math.max(known?.segments ?? 0, parsed.segment),
        ...(title === undefined ? {} : { title }),
      })
    }

    return [...sessions.values()]
  }

  /** Rewrites usage-index.js from the folder's listing, so other sessions' writes are kept. */
  async writeIndex(): Promise<void> {
    await this.writeIfChanged(`${this.dir}/usage-index.js`, indexScript(await this.listSessions()))
  }

  /** Writes a whole file unless it already holds exactly that text. */
  async writeIfChanged(path: string, text: string): Promise<void> {
    try {
      if ((await this.ports.fs.read(path)) === text) {
        return
      }
    } catch {
      // Missing or unreadable: write it.
    }

    await this.ports.fs.write(path, text)
  }

  /** Copies the viewer page beside the logs, unless the copy there is the same. */
  async installViewer(): Promise<void> {
    try {
      const page = await this.ports.fs.read(`${this.host.pluginRoot}/assets/viewer.html`)
      await this.writeIfChanged(`${this.dir}/viewer.html`, page)
    } catch (error) {
      // The logs matter more than the page: log it and go on.
      this.ports.debug(`token-usage-anatomy: viewer.html not installed: ${String(error)}`)
    }
  }

  /**
   * Brings the folder up to date: the viewer page, the price table, a
   * viewer copy for every log segment missing one or older than its log,
   * and the index.
   */
  async refresh(): Promise<void> {
    await this.installViewer()
    await this.writeIfChanged(`${this.dir}/pricing.js`, pricingScript())

    const logs = await this.ports.fs.list(this.dir)
    const copies = new Map<string, number>()

    try {
      for (const entry of await this.ports.fs.list(`${this.dir}/data`)) {
        copies.set(entry.name, entry.mtimeMs)
      }
    } catch {
      // No data folder yet.
    }

    for (const entry of logs) {
      const parsed = entry.kind === 'file' ? parseSegmentName(entry.name) : undefined

      if (parsed === undefined) {
        continue
      }

      const copy = segmentName(parsed.sessionId, parsed.segment, 'js')
      const copiedAt = copies.get(copy)

      if (copiedAt !== undefined && copiedAt >= entry.mtimeMs) {
        continue
      }

      const text = await this.ports.fs.read(`${this.dir}/${entry.name}`)
      await this.ports.fs.write(`${this.dir}/data/${copy}`, dataStatement(parsed.sessionId, text))
    }

    await this.writeIndex()
  }
}
