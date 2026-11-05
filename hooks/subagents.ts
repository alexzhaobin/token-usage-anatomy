// Subagents: their requests are priced from their own transcripts and
// counted in the prompt row in which those requests ended. An agent still
// running at the end of a prompt carries on into the next prompt's row.

import { readTranscript, slashes } from './io'
import type { Host } from './io'
import type { Ports } from './ports'
import { total } from './pricing'
import type { CostParts } from './pricing'
import {
  costOf,
  countBy,
  mergeTools,
  methodOf,
  priceStep,
  roundParts,
  round,
  tokenParts,
  tokenTotal,
} from './steps'
import type { PricedStep, Step, ToolStat } from './steps'
import { matchSteps, usageKey } from './transcript'
import type { TokenParts } from '../types'

/** A prompt row lists at most this many agents. */
const MAX_AGENTS_LISTED = 50

export type AgentStats = {
  id: string
  steps: Step[]
  runs: number
  isRunning: boolean
  tools: Record<string, ToolStat>
  /** From the SubagentStop hook, when it has run. */
  transcriptPath?: string
  /** Where the next read of its transcript starts. */
  offset: number
  /** Responses already counted (id and usage), so none is counted twice. */
  seen: Set<string>
}

export type PricedAgent = {
  agent: AgentStats
  steps: PricedStep[]
  type?: string
  description?: string
}

export type SubagentSummary = {
  runs: number
  agentCount: number
  requests: number
  tokens: TokenParts
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  estCostParts: CostParts
  estCostUsd: number
  models: Record<string, number>
  tools: Record<string, ToolStat>
  agents: Array<Record<string, unknown>>
}

export class Agents {
  private readonly byId = new Map<string, AgentStats>()

  get(id: string): AgentStats {
    let agent = this.byId.get(id)

    if (agent === undefined) {
      agent = { id, steps: [], runs: 0, isRunning: false, tools: {}, offset: 0, seen: new Set() }
      this.byId.set(id, agent)
    }

    return agent
  }

  /** Agents with something to count. */
  pending(): AgentStats[] {
    return [...this.byId.values()].filter(
      agent => agent.steps.length > 0 || agent.runs > 0 || Object.keys(agent.tools).length > 0,
    )
  }

  /** After a prompt is written: ended agents are forgotten, running ones start over. */
  settle(agents: readonly AgentStats[]): void {
    for (const agent of agents) {
      if (agent.isRunning) {
        agent.steps = []
        agent.runs = 0
        agent.tools = {}
      } else {
        this.byId.delete(agent.id)
      }
    }
  }

  clear(): void {
    this.byId.clear()
  }
}

/** `<session>.jsonl` keeps its subagents in `<session>/subagents/agent-<id>.jsonl`. */
export function subagentPath(sessionTranscript: string, agentId: string): string {
  return `${slashes(sessionTranscript).replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`
}

async function describe(
  ports: Ports,
  agent: AgentStats,
  path: string,
  listed: ReadonlyMap<string, { type: string; description: string }>,
): Promise<{ type?: string; description?: string }> {
  const known = listed.get(agent.id)

  if (known !== undefined) {
    return known
  }

  try {
    const meta = JSON.parse(await ports.fs.read(path.replace(/\.jsonl$/, '.meta.json'))) as Record<string, unknown>

    return {
      type: typeof meta.agentType === 'string' ? meta.agentType : undefined,
      description: typeof meta.description === 'string' ? meta.description : undefined,
    }
  } catch {
    return {}
  }
}

/** Prices every pending agent from its own transcript. */
export async function priceAgents(
  ports: Ports,
  host: Host,
  sessionTranscript: string | undefined,
  agents: readonly AgentStats[],
): Promise<PricedAgent[]> {
  const listed = new Map<string, { type: string; description: string }>()

  try {
    for (const info of await ports.agents()) {
      listed.set(info.id, { type: info.type, description: info.description })
    }
  } catch {
    // Not listed: the meta files say what they can.
  }

  return Promise.all(
    agents.map(async agent => {
      const path =
        agent.transcriptPath ?? (sessionTranscript === undefined ? undefined : subagentPath(sessionTranscript, agent.id))
      const read = path === undefined ? undefined : await readTranscript(ports, host, path, agent.offset)
      const fresh = (read?.entries ?? []).filter(entry => !agent.seen.has(`${entry.id}|${usageKey(entry)}`))

      for (const entry of fresh) {
        agent.seen.add(`${entry.id}|${usageKey(entry)}`)
      }

      if (read !== undefined) {
        agent.offset = read.end
      }

      const matches = matchSteps(agent.steps, fresh)
      const steps = agent.steps.map((step, i) => priceStep(step, matches[i]))
      const about = path === undefined ? {} : await describe(ports, agent, path, listed)

      return { agent, steps, ...about }
    }),
  )
}

/** The `subagents` block of a prompt row; undefined when no agent did anything. */
export function summarise(priced: readonly PricedAgent[]): SubagentSummary | undefined {
  if (priced.length === 0) {
    return undefined
  }

  const steps = priced.flatMap(item => item.steps)
  const parts = costOf(steps)
  const tools: Record<string, ToolStat> = {}

  for (const item of priced) {
    mergeTools(tools, item.agent.tools)
  }

  return {
    runs: priced.reduce((sum, item) => sum + item.agent.runs, 0),
    agentCount: priced.length,
    requests: steps.length,
    tokens: tokenParts(steps),
    cacheWrite5mTokens: steps.reduce((sum, step) => sum + step.cacheWrite5mTokens, 0),
    cacheWrite1hTokens: steps.reduce((sum, step) => sum + step.cacheWrite1hTokens, 0),
    estCostParts: roundParts(parts),
    estCostUsd: round(total(parts)),
    models: countBy(steps, step => step.model),
    tools,
    agents: priced.slice(0, MAX_AGENTS_LISTED).map(item => {
      const agentParts = costOf(item.steps)
      const tokens = tokenParts(item.steps)

      return {
        id: item.agent.id,
        type: item.type,
        description: item.description,
        runs: item.agent.runs,
        isRunning: item.agent.isRunning,
        requests: item.steps.length,
        coldRequests: item.steps.filter(step => step.isCold).length,
        tokens,
        totalTokens: tokenTotal(tokens),
        reasoningMethod: methodOf(item.steps),
        models: countBy(item.steps, step => step.model),
        tools: item.agent.tools,
        estCostUsd: round(total(agentParts)),
      }
    }),
  }
}
