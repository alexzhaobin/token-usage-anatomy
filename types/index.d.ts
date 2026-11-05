// The type contract of token-usage-anatomy: the session values it keeps in
// `$.state`, under the plugin's own name. Self-contained (no imports), so
// `claude plugin validate` can hold the module's `$.state` keys to it.

/** What a prompt cost, by part, in US dollars (API list-price equivalent). */
export type CostParts = {
  input: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  answer: number
}

/** The same parts counted in tokens. */
export type TokenParts = {
  /** Uncached input. */
  input: number
  cacheRead: number
  cacheWrite: number
  /** Output spent thinking (reported by the API, or estimated). */
  reasoning: number
  /** The rest of the output: visible text and tool calls. */
  answer: number
}

/** One prompt's bar in the band. */
export type CostRow = {
  /** The prompt's number in the session, from 1. */
  n: number
  /** A short label: the prompt's first words, kept in memory only. */
  label: string
  tokens: TokenParts
  /** Every token the prompt's subagents used, all parts together. */
  subagentTokens: number
  parts: CostParts
  subagentUsd: number
  /** What the engine's session cost grew by beyond the mod's own pricing. */
  unattributedUsd: number
  /** What the mod priced above the engine's session cost. */
  overUsd: number
}

/** When the prompt cache goes cold, for the countdown. */
export type CacheClock = {
  /** Milliseconds since the epoch; null before the first request. */
  expiresAt: number | null
  /** The cache entry's lifetime as last inferred: 5 minutes or 1 hour. */
  ttlMs: number
  /** The last second the countdown was redrawn at. */
  now: number
}

/** One category of the context window filled before the first prompt. */
export type PreloadedPart = {
  name: string
  tokens: number
}

/** What the context window holds before anything is typed. */
export type Preloaded = {
  tokens: number
  /** The model's context window, in tokens. */
  window: number
  /** Largest first. */
  parts: PreloadedPart[]
}

declare module 'claude-code' {
  interface PluginState {
    'token-usage-anatomy': {
      /** The last 60 prompts' bars. */
      rows: Shaped<CostRow[]>
      /** The engine's own session cost at the last prompt, in US dollars. */
      sessionUsd: number | null
      /** The last prompt number used; prompts with no usage get none. */
      promptNo: number
      /** The session's transcript file, as Claude Code named it; kept across hot reloads. */
      transcriptPath: string | null
      cache: Shaped<CacheClock>
      preloaded: Shaped<Preloaded | null>
      /** The band is hidden (/token-anatomy hide). */
      isHidden: boolean
      /** The terminal's theme is light. */
      isLight: boolean
      /** What the band's bars measure. */
      unit: 'tokens' | 'usd'
    }
  }
}
