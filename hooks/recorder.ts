// The session's recorder: what the hooks saw, turned into rows and bars.
//
// register.tsx calls these methods from its hooks. Everything slow (reading
// the transcript, pricing, writing) runs on the logbook's queue after the
// hook has returned, so a turn's end is never held up and a failure here
// never reaches Claude Code.

import type { ModelUsage, SessionCompactInput, TurnStepInput, TurnStepResult } from 'claude-code'

import { readTitle, readTranscript, sizeOf, slashes } from './io'
import type { Host } from './io'
import { Logbook } from './logbook'
import type { Ports } from './ports'
import { buildCompactRow, buildContextRow, buildPromptRow, buildRequestRows, labelOf, preloadedOf } from './rows'
import type { Row } from './rows'
import { FIVE_MINUTES, MAX_ROWS, ONE_HOUR, initialCache } from './state'
import { contextOf, mergeTools, noTokens, priceStep, tokenParts, tokenTotal } from './steps'
import type { CharCounts, Step, ToolStat } from './steps'
import { Agents, priceAgents, summarise } from './subagents'
import { matchSteps } from './transcript'
import type { TranscriptEntry } from './transcript'
import type { CostRow } from '../types'

export type Config = {
  recordRequests: boolean
  includePromptText: boolean
  /** Empty: `<claudeDir>/token-usage-anatomy`. */
  logDir: string
}

type Turn = {
  turnId: string
  text: string
  startedAt: number
  /** The transcript's size when the turn began: its responses come after. */
  transcriptOffset?: number
  steps: Step[]
  tools: Record<string, ToolStat>
  idleBeforeMs?: number
}

type Context = { ports: Ports; host: Host; logbook: Logbook }

export type TurnEnd = {
  turnId: string
  reason: string
  durationMs: number
  usage?: ModelUsage & { model: string }
}

/** How often the transcript is read again while it catches up with the hooks. */
const TRANSCRIPT_ATTEMPTS = 5
const TRANSCRIPT_RETRY_MS = 250

const iso = (ms: number): string => new Date(ms).toISOString()

function tokensOf(usage: ModelUsage | null | undefined): Step['tokens'] {
  if (usage === null || usage === undefined) {
    return noTokens()
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        out[key] = item
      }
    }
  }

  return out
}

/** The log folder a configured `logDir` names, `~` expanded. */
export function logFolder(config: Config, host: Host): string {
  const configured = config.logDir.replace(/^~(?=$|[\\/])/, host.home)

  return configured === '' ? `${host.claudeDir}/token-usage-anatomy` : slashes(configured)
}

export class Recorder {
  private context: Context | undefined
  private turn: Turn | undefined
  private readonly agents = new Agents()
  private lastRequestEndAt: number | undefined
  private hasCompacted = false
  private pendingTranscript: string | undefined

  constructor(private readonly config: Config) {}

  /** The log folder, once the session has started. */
  get logDir(): string | undefined {
    return this.context?.logbook.dir
  }

  /**
   * Session start (and every hot reload): take the ports, install the log
   * folder's files, note the cost so far, snapshot the context.
   */
  async start(ports: Ports, host: Host, isInteractive: boolean): Promise<void> {
    const logbook = new Logbook(ports, host, logFolder(this.config, host))
    this.context = { ports, host, logbook }

    if (this.pendingTranscript !== undefined) {
      const path = this.pendingTranscript
      this.pendingTranscript = undefined
      await ports.state.transcriptPath.set(() => path)
    }

    logbook.setTitles(stringRecord(await ports.store.get('titles')))

    void logbook.enqueue('refresh the log folder', async () => {
      await logbook.refresh()
      await this.backfillTitles()
    })

    if ((await ports.state.sessionUsd.get()) === null) {
      const usage = await ports.session.usage()
      await ports.state.sessionUsd.set(() => usage.cost?.usd ?? 0)
    }

    if ((await ports.state.transcriptPath.get()) === null) {
      const found = await this.locateTranscript(await ports.session.id())

      if (found !== undefined) {
        await ports.state.transcriptPath.set(() => found)
      }
    }

    if (isInteractive && (await ports.state.promptNo.get()) === 0) {
      void logbook.enqueue('snapshot the context', () => this.snapshot(0))
    }
  }

  /** The transcript's path, from a settings-hook event; kept until start if it comes first. */
  async setTranscript(path: string | undefined): Promise<void> {
    if (path === undefined || path === '') {
      return
    }

    if (this.context === undefined) {
      this.pendingTranscript = slashes(path)

      return
    }

    await this.context.ports.state.transcriptPath.set(() => slashes(path))
  }

  setAgentTranscript(agentId: string, path: string | undefined): void {
    if (path !== undefined && path !== '') {
      this.agents.get(agentId).transcriptPath = slashes(path)
    }
  }

  async turnStart(turnId: string, text: string, agentId: string | undefined): Promise<void> {
    if (agentId !== undefined) {
      this.agents.get(agentId).isRunning = true

      return
    }

    if (this.context === undefined) {
      return
    }

    const { ports } = this.context
    const path = await ports.state.transcriptPath.get()
    this.turn = {
      turnId,
      text,
      startedAt: await ports.now(),
      transcriptOffset: path === null ? undefined : await sizeOf(ports, path),
      steps: [],
      tools: {},
    }
  }

  async step(e: TurnStepInput, result: TurnStepResult, chars: CharCounts, startedAt: number, endedAt: number) {
    const usage = result.usage
    const tokens = tokensOf(usage)
    const step: Step = {
      index: e.index,
      model: usage?.model ?? e.model,
      requestedModel: e.model,
      effort: e.effort,
      tokens,
      hasUsage: usage !== null,
      stopReason: result.stopReason,
      toolUses: result.toolUses.length + (result.serverToolUses?.length ?? 0),
      chars,
      startedAt,
      endedAt,
      isCold: usage !== null && tokens.cacheReadTokens === 0,
    }

    if (e.agentId !== undefined) {
      this.agents.get(e.agentId).steps.push(step)

      return
    }

    const turn = this.turn?.turnId === e.turnId ? this.turn : undefined

    if (turn === undefined) {
      return
    }

    if (turn.steps.length === 0 && this.lastRequestEndAt !== undefined) {
      turn.idleBeforeMs = Math.max(0, startedAt - this.lastRequestEndAt)
    }

    turn.steps.push(step)

    if (usage !== null) {
      this.lastRequestEndAt = endedAt

      // Any cache read or write keeps the entry alive for another lifetime.
      if (this.context !== undefined && (tokens.cacheReadTokens > 0 || tokens.cacheCreationTokens > 0)) {
        await this.context.ports.state.cache.set(cache => ({ ...cache, expiresAt: endedAt + cache.ttlMs, now: endedAt }))
      }
    }
  }

  tool(agentId: string | undefined, tool: string, resultChars: number, isError: boolean): void {
    const tools = agentId === undefined ? this.turn?.tools : this.agents.get(agentId).tools

    if (tools !== undefined) {
      mergeTools(tools, { [tool]: { calls: 1, resultChars, errors: isError ? 1 : 0 } })
    }
  }

  async compacted(
    e: SessionCompactInput,
    tokensBefore: number | undefined,
    tokensAfter: number | undefined,
    usage: ModelUsage | undefined,
  ): Promise<void> {
    if (e.agentId !== undefined || e.trigger === 'precompute' || this.context === undefined) {
      return
    }

    this.hasCompacted = true
    const { ports, logbook } = this.context
    const at = iso(await ports.now())
    const model = await ports.session.model()
    const sessionId = await ports.session.id()
    void logbook.enqueue('write the compaction', () =>
      logbook.append(sessionId, [
        buildCompactRow(at, e.trigger, tokensBefore, tokensAfter, usage === undefined ? undefined : { ...usage, model }),
      ]),
    )
  }

  agentEnded(agentId: string): void {
    const agent = this.agents.get(agentId)
    agent.runs += 1
    agent.isRunning = false
  }

  /**
   * A main-loop turn ended: give it a prompt number now, and queue the rest
   * (transcript, pricing, rows) to run after the hook has returned.
   */
  async turnComplete(e: TurnEnd): Promise<void> {
    const turn = this.turn?.turnId === e.turnId ? this.turn : undefined
    this.turn = undefined

    const steps = turn?.steps ?? []

    if (this.context === undefined || (!steps.some(step => step.hasUsage) && e.usage === undefined)) {
      return
    }

    const { ports, logbook } = this.context
    const rows = await ports.state.rows.get()
    const promptNo = Math.max(await ports.state.promptNo.get(), rows.at(-1)?.n ?? 0) + 1
    await ports.state.promptNo.set(() => promptNo)

    const done: Turn = turn ?? { turnId: e.turnId, text: '', startedAt: 0, steps: [], tools: {} }
    void logbook.enqueue(`write prompt ${promptNo}`, () => this.finish(done, e, promptNo))
  }

  private async readMainEntries(turn: Turn): Promise<TranscriptEntry[] | undefined> {
    if (this.context === undefined) {
      return undefined
    }

    const { ports, host } = this.context
    const path = await ports.state.transcriptPath.get()
    const wanted = turn.steps.filter(step => step.hasUsage)

    if (path === null || turn.transcriptOffset === undefined || wanted.length === 0) {
      return undefined
    }

    let entries: TranscriptEntry[] | undefined

    // The transcript may lag the hooks by a moment: read again until every
    // request is found, or give up and price what is missing from the hooks.
    for (let attempt = 1; attempt <= TRANSCRIPT_ATTEMPTS; attempt += 1) {
      const got = await readTranscript(ports, host, path, turn.transcriptOffset)

      if (got === undefined) {
        return entries
      }

      entries = got.entries.filter(entry => !entry.isSidechain)
      const found = matchSteps(wanted, entries).filter(match => match !== undefined).length

      if (found === wanted.length || attempt === TRANSCRIPT_ATTEMPTS) {
        return entries
      }

      await ports.sleep(TRANSCRIPT_RETRY_MS)
    }

    return entries
  }

  private async finish(turn: Turn, e: TurnEnd, promptNo: number): Promise<void> {
    if (this.context === undefined) {
      return
    }

    const { ports, host, logbook } = this.context
    const at = iso(await ports.now())
    const sessionId = await ports.session.id()

    // 1. Each request, enriched from the transcript and priced on its own.
    const entries = await this.readMainEntries(turn)
    const withUsage = turn.steps.filter(step => step.hasUsage)
    const matched = matchSteps(withUsage, entries ?? [])
    const matchOf = new Map(withUsage.map((step, i) => [step, matched[i]]))
    const priced = turn.steps.map(step => priceStep(step, matchOf.get(step)))

    // 2. Subagents, from their own transcripts.
    const pending = this.agents.pending()
    const transcript = await ports.state.transcriptPath.get()
    const pricedAgents = await priceAgents(ports, host, transcript ?? undefined, pending)
    const subagents = summarise(pricedAgents)

    // 3. The engine's own session cost, to show any gap honestly.
    const usage = await ports.session.usage()
    const engineUsd = usage.cost?.usd
    const previousUsd = await ports.state.sessionUsd.get()
    const deltaUsd = engineUsd === undefined ? undefined : Math.max(0, engineUsd - (previousUsd ?? 0))

    const built = buildPromptRow({
      at,
      promptNo,
      turnId: turn.turnId,
      reason: e.reason,
      durationMs: e.durationMs,
      ...(this.config.includePromptText ? { label: labelOf(turn.text), prompt: turn.text.slice(0, 2000) } : {}),
      steps: priced,
      fallbackUsage: e.usage,
      tools: turn.tools,
      idleBeforeMs: turn.idleBeforeMs,
      transcriptRequests: priced.filter(step => step.isInTranscript).length,
      subagents,
      engine: {
        sessionUsd: engineUsd,
        deltaUsd,
        contextTokens: usage.context.tokens,
        contextWindow: usage.context.window,
      },
    })

    // 4. The band's bar. The label stays in memory; the log gets it only
    // when the person turned on prompt text.
    const bar: CostRow = {
      n: promptNo,
      label: labelOf(turn.text),
      tokens: tokenParts(priced),
      subagentTokens: subagents === undefined ? 0 : tokenTotal(subagents.tokens),
      subagentCacheRead: subagents === undefined ? 0 : subagents.tokens.cacheRead,
      parts: built.parts,
      subagentUsd: built.subagentUsd,
      unattributedUsd: built.unattributedUsd,
      overUsd: built.overUsd,
      requests: priced.length,
    }
    // The status line's figure, else what the last request was sent.
    const lastStep = priced.at(-1)
    const contextTokens = usage.context.tokens ?? (lastStep === undefined ? undefined : contextOf(lastStep.tokens))

    if (contextTokens !== undefined && usage.context.window > 0) {
      bar.context = { tokens: contextTokens, window: usage.context.window }
    }

    await ports.state.rows.set(rows => [...rows, bar].slice(-MAX_ROWS))

    if (engineUsd !== undefined) {
      await ports.state.sessionUsd.set(() => engineUsd)
    }

    // 5. The log: request rows first (when asked for), then the prompt row.
    const rows: Row[] = []

    if (this.config.recordRequests) {
      rows.push(...buildRequestRows(at, promptNo, turn.turnId, priced))

      for (const item of pricedAgents) {
        rows.push(...buildRequestRows(at, promptNo, turn.turnId, item.steps, item.agent.id))
      }
    }

    rows.push(built.row)
    await logbook.append(sessionId, rows)
    this.agents.settle(pending)

    // 6. The cache's lifetime, as far as the transcript shows it. Until a
    // 1-hour write is seen it stays 5 minutes, so a cold cache never shows warm.
    const known = priced.filter(step => step.isInTranscript && step.tokens.cacheCreationTokens > 0)

    if (known.length > 0 && this.lastRequestEndAt !== undefined) {
      const ttlMs = known.some(step => step.cacheWrite1hTokens > 0) ? ONE_HOUR : FIVE_MINUTES
      const endedAt = this.lastRequestEndAt
      await ports.state.cache.set(cache => ({ ...cache, ttlMs, expiresAt: endedAt + ttlMs }))
    }

    // 7. A snapshot of the context window now and then.
    if (promptNo === 1 || promptNo % 10 === 0 || this.hasCompacted) {
      this.hasCompacted = false
      await this.snapshot(promptNo)
    }
  }

  private async snapshot(promptNo: number): Promise<void> {
    if (this.context === undefined) {
      return
    }

    const { ports, logbook } = this.context
    const usage = await ports.session.breakdown()
    const preloaded = preloadedOf(usage)

    if (preloaded !== null) {
      await ports.state.preloaded.set(() => preloaded)
    }

    const row = buildContextRow(iso(await ports.now()), promptNo, usage)

    if (row !== undefined) {
      await logbook.append(await ports.session.id(), [row])
    }
  }

  /** At each stop: note the session's title once it has one or changes it. */
  stopped(): void {
    if (this.context === undefined) {
      return
    }

    const { ports, host, logbook } = this.context
    void logbook.enqueue('note the title', async () => {
      const path = await ports.state.transcriptPath.get()

      if (path === null) {
        return
      }

      const title = await readTitle(ports, host, path)
      const sessionId = await ports.session.id()
      const titles = stringRecord(await ports.store.get('titles'))

      if (title === undefined || titles[sessionId] === title) {
        return
      }

      titles[sessionId] = title
      await ports.store.set('titles', titles)
      logbook.setTitles(titles)
      await logbook.append(sessionId, [{ kind: 'session', at: iso(await ports.now()), title }])
    })
  }

  /** /clear starts a new session: the band and the counters start over. */
  async cleared(): Promise<void> {
    this.turn = undefined
    this.agents.clear()
    this.lastRequestEndAt = undefined
    this.hasCompacted = false

    if (this.context === undefined) {
      return
    }

    const { ports } = this.context
    await ports.state.rows.set(() => [])
    await ports.state.sessionUsd.set(() => 0)
    await ports.state.promptNo.set(() => 0)
    await ports.state.cache.set(() => initialCache)
    await ports.state.preloaded.set(() => null)
  }

  /** Finds `<id>.jsonl` under `<claudeDir>/projects`, for a session the mod met mid-way. */
  private async locateTranscript(sessionId: string): Promise<string | undefined> {
    if (this.context === undefined) {
      return undefined
    }

    const { ports, host } = this.context
    const projects = `${host.claudeDir}/projects`

    try {
      for (const folder of await ports.fs.list(projects)) {
        const path = `${projects}/${folder.name}/${sessionId}.jsonl`

        if (folder.kind === 'dir' && (await ports.fs.exists(path))) {
          return path
        }
      }
    } catch (error) {
      ports.debug(`token-usage-anatomy: locate the transcript: ${String(error)}`)
    }

    return undefined
  }

  /** Titles for logged sessions that have none yet, read once from their transcripts. */
  private async backfillTitles(): Promise<void> {
    if (this.context === undefined) {
      return
    }

    const { ports, host, logbook } = this.context
    const titles = stringRecord(await ports.store.get('titles'))
    const noTranscript = stringRecord(await ports.store.get('noTranscript'))
    const missing = new Set(
      (await logbook.listSessions())
        .map(entry => entry.id)
        .filter(id => titles[id] === undefined && noTranscript[id] === undefined),
    )

    if (missing.size === 0) {
      return
    }

    const projects = `${host.claudeDir}/projects`
    const found = new Map<string, string>()

    try {
      for (const folder of await ports.fs.list(projects)) {
        if (folder.kind !== 'dir') {
          continue
        }

        for (const file of await ports.fs.list(`${projects}/${folder.name}`)) {
          const id = file.name.replace(/\.jsonl$/, '')

          if (file.kind === 'file' && missing.has(id) && !found.has(id)) {
            found.set(id, `${projects}/${folder.name}/${file.name}`)
          }
        }
      }
    } catch (error) {
      // The listing failed: remember no session as gone.
      ports.debug(`token-usage-anatomy: list the transcripts: ${String(error)}`)

      return
    }

    for (const id of missing) {
      const path = found.get(id)

      if (path === undefined) {
        noTranscript[id] = 'missing'
        continue
      }

      const title = await readTitle(ports, host, path)

      if (title !== undefined) {
        titles[id] = title
      }
    }

    await ports.store.set('titles', titles)
    await ports.store.set('noTranscript', noTranscript)
    logbook.setTitles(titles)
    await logbook.writeIndex()
  }
}
