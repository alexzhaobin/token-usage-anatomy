// The price table. Data only: every number here is copied from Anthropic's
// public pricing page (sourceUrl) on the day in `asOf`. The band and the
// viewer show `asOf`, so readers know how fresh the dollar figures are.
//
// To update: open the pricing page, change the numbers and `asOf` together,
// run the tests, and note the change in CHANGELOG.md.
//
// All rates are US dollars per million tokens (MTok).

export type Rates = {
  /** Base input tokens (uncached). */
  input: number
  /** Output tokens (visible answer and thinking alike). */
  output: number
  /** Cache hits and refreshes. */
  cacheRead: number
  /** Writing a prefix to the 5-minute cache. */
  write5m: number
  /** Writing a prefix to the 1-hour cache. */
  write1h: number
}

export type PriceEntry = {
  /**
   * Model keys this entry prices, as `modelKey()` spells them
   * (`claude-opus-5-5` becomes `opus-5-5`).
   */
  keys: readonly string[]
  /** Display name, as the pricing page writes it. */
  name: string
  rates: Rates
  /**
   * Higher prices for a request whose prompt (uncached input, cache reads
   * and cache writes together) is over `overTokens`.
   */
  longPrompt?: { overTokens: number; rates: Rates }
  /**
   * Fast mode input and output prices. Cache multipliers apply on top of
   * them, as they do on the standard prices.
   */
  fast?: { input: number; output: number }
}

export type PriceTable = {
  /** The day the numbers were checked against `sourceUrl` (YYYY-MM-DD). */
  asOf: string
  sourceUrl: string
  /**
   * US-only inference (`inference_geo: "us"`) multiplies every category,
   * fast and long-prompt prices included.
   */
  usOnlyMultiplier: number
  /**
   * Model keys priced when a model is not in the table: the newest of its
   * family first, then the overall default.
   */
  families: readonly string[]
  defaultKey: string
  /** Most specific first: the first entry whose key matches wins. Never empty. */
  models: readonly [PriceEntry, ...PriceEntry[]]
}

// Standard cache writes are 1.25x (5 minutes) and 2x (1 hour) the input
// price on every model; only the cache read multiplier differs per model,
// so each row lists the page's five numbers in full.
const r = (input: number, write5m: number, write1h: number, cacheRead: number, output: number): Rates => ({
  input,
  write5m,
  write1h,
  cacheRead,
  output,
})

export const PRICES: PriceTable = {
  asOf: '2026-11-05',
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  usOnlyMultiplier: 1.1,
  families: ['fable', 'mythos', 'opus', 'sonnet', 'haiku'],
  defaultKey: 'sonnet-5-5',
  models: [
    //                                        input  5m write 1h write  read   output
    { keys: ['fable-5-1'], name: 'Claude Fable 5.1', rates: r(10, 12.5, 20, 0.25, 50) },
    { keys: ['mythos-5-1'], name: 'Claude Mythos 5.1', rates: r(10, 12.5, 20, 0.25, 50) },
    { keys: ['fable-5'], name: 'Claude Fable 5', rates: r(10, 12.5, 20, 1, 50) },
    { keys: ['mythos-5'], name: 'Claude Mythos 5', rates: r(10, 12.5, 20, 1, 50) },
    {
      keys: ['opus-5-5'],
      name: 'Claude Opus 5.5',
      rates: r(4, 5, 8, 0.2, 20),
      fast: { input: 8, output: 40 },
    },
    {
      keys: ['opus-5'],
      name: 'Claude Opus 5',
      rates: r(5, 6.25, 10, 0.5, 25),
      fast: { input: 10, output: 50 },
    },
    {
      keys: ['opus-4-8'],
      name: 'Claude Opus 4.8',
      rates: r(5, 6.25, 10, 0.5, 25),
      fast: { input: 10, output: 50 },
    },
    { keys: ['opus-4-7'], name: 'Claude Opus 4.7', rates: r(5, 6.25, 10, 0.5, 25) },
    { keys: ['opus-4-6'], name: 'Claude Opus 4.6', rates: r(5, 6.25, 10, 0.5, 25) },
    { keys: ['opus-4-5'], name: 'Claude Opus 4.5', rates: r(5, 6.25, 10, 0.5, 25) },
    { keys: ['opus-4-1'], name: 'Claude Opus 4.1', rates: r(15, 18.75, 30, 1.5, 75) },
    { keys: ['opus-4'], name: 'Claude Opus 4', rates: r(15, 18.75, 30, 1.5, 75) },
    { keys: ['sonnet-5-5'], name: 'Claude Sonnet 5.5', rates: r(2, 2.5, 4, 0.1, 10) },
    { keys: ['sonnet-5'], name: 'Claude Sonnet 5', rates: r(2, 2.5, 4, 0.2, 10) },
    { keys: ['sonnet-4-6'], name: 'Claude Sonnet 4.6', rates: r(3, 3.75, 6, 0.3, 15) },
    { keys: ['sonnet-4-5'], name: 'Claude Sonnet 4.5', rates: r(3, 3.75, 6, 0.3, 15) },
    { keys: ['sonnet-4'], name: 'Claude Sonnet 4', rates: r(3, 3.75, 6, 0.3, 15) },
    {
      keys: ['haiku-5-5'],
      name: 'Claude Haiku 5.5',
      rates: r(0.1, 0.125, 0.2, 0.01, 0.5),
      longPrompt: { overTokens: 100_000, rates: r(0.5, 0.625, 1, 0.05, 2.5) },
    },
    { keys: ['haiku-4-5'], name: 'Claude Haiku 4.5', rates: r(1, 1.25, 2, 0.1, 5) },
    { keys: ['haiku-3-5', '3-5-haiku'], name: 'Claude Haiku 3.5', rates: r(0.8, 1, 1.6, 0.08, 4) },
  ],
}
