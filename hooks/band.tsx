// The chart above the prompt (and in a pane where a surface has no band):
// one stacked bar per prompt, tokens by type by default, or their API
// list-price equivalent in dollars. Pure drawing over the session's values:
// register.tsx reads the values and hands over the surface's elements.

import type { BoxProps, ButtonProps, ElementConstructor, LinkProps, RenderElement, TextProps } from 'claude-code'

import { countdown, money, percent, tokensShort } from './format'
import type { CostRow, Preloaded } from '../types'

export type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Link: ElementConstructor<LinkProps>
}

export type Unit = 'tokens' | 'usd'

/** The left axis, each bar's column and the bar itself, in cells. */
export const AXIS = 8
export const COLUMN = 9
const BAR = 6
const MAX_BAR_ROWS = 8
const MIN_BAR_ROWS = 3

/** Below half a tenth of a cent a dollar difference is noise. */
const NOISE_USD = 0.0005

export type SegmentKey = 'cacheRead' | 'cacheWrite' | 'input' | 'reasoning' | 'answer' | 'subagents' | 'unattributed'

type Segment = { key: SegmentKey; label: string; light: string; dark: string }

/**
 * Bottom to top. Each part keeps its colour wherever it appears (band and
 * viewer alike), whatever its rank.
 */
export const SEGMENTS: readonly Segment[] = [
  { key: 'cacheRead', label: 'cache read', light: '#2a78d6', dark: '#3987e5' },
  { key: 'cacheWrite', label: 'cache write', light: '#eb6834', dark: '#d95926' },
  { key: 'input', label: 'input', light: '#1baf7a', dark: '#199e70' },
  { key: 'reasoning', label: 'thinking', light: '#eda100', dark: '#c98500' },
  { key: 'answer', label: 'answer', light: '#e87ba4', dark: '#d55181' },
  { key: 'subagents', label: 'subagents', light: '#008300', dark: '#008300' },
  { key: 'unattributed', label: 'unattributed', light: '#8a8984', dark: '#6b6a64' },
]

const colorOf = (key: SegmentKey, isLight: boolean): string => {
  const segment = SEGMENTS.find(item => item.key === key)

  return segment === undefined ? '' : isLight ? segment.light : segment.dark
}

export function segmentValues(row: CostRow, unit: Unit): Record<SegmentKey, number> {
  if (unit === 'tokens') {
    return { ...row.tokens, subagents: row.subagentTokens, unattributed: 0 }
  }

  return { ...row.parts, subagents: row.subagentUsd, unattributed: row.unattributedUsd }
}

export function barTotal(row: CostRow, unit: Unit): number {
  return Object.values(segmentValues(row, unit)).reduce((sum, value) => sum + value, 0)
}

export const amount = (value: number, unit: Unit): string => (unit === 'tokens' ? tokensShort(value) : money(value))

/** How many prompts' bars fit across. */
export function barCount(columns: number): number {
  return Math.max(1, Math.floor((columns - AXIS) / COLUMN))
}

/**
 * Which part fills each row of a bar, bottom first: the bar's height is its
 * share of the tallest, at least one row if it is anything at all, and the
 * parts' edges fall on rounded running totals.
 */
export function barCells(
  values: Record<SegmentKey, number>,
  total: number,
  height: number,
  tallest: number,
): Array<SegmentKey | undefined> {
  const cells: Array<SegmentKey | undefined> = new Array<SegmentKey | undefined>(height).fill(undefined)

  if (total <= 0 || tallest <= 0) {
    return cells
  }

  const filled = Math.min(height, Math.max(1, Math.round((total / tallest) * height)))
  let running = 0
  let edge = 0

  for (const segment of SEGMENTS) {
    running += values[segment.key]
    const next = Math.min(filled, Math.round((running / total) * filled))

    for (let row = edge; row < next; row += 1) {
      cells[row] = segment.key
    }

    edge = Math.max(edge, next)
  }

  return cells
}

export type CacheLeft = { remainingMs: number; ttlMs: number }

/** The cache countdown: green, yellow, orange, red as its lifetime runs out. */
export function cacheText(cache: CacheLeft): { text: string; color?: string } {
  if (cache.remainingMs <= 0) {
    return { text: 'cache cold' }
  }

  const share = cache.ttlMs > 0 ? cache.remainingMs / cache.ttlMs : 0
  const color = share > 0.5 ? '#1baf7a' : share > 0.25 ? '#eda100' : share > 0.1 ? '#eb6834' : '#d63c3c'

  return { text: `cache warm ${countdown(cache.remainingMs)}`, color }
}

/**
 * `Preloaded context 19.7k (2.0% of 1M) used before you type: System tools
 * 12.5k · System prompt 6k · +2 more`: largest parts first, as many as fit,
 * the rest counted rather than cut.
 */
export function preloadedLine(preloaded: Preloaded, columns: number): string {
  const head =
    `Preloaded context ${tokensShort(preloaded.tokens)} ` +
    `(${percent(preloaded.tokens, preloaded.window)} of ${tokensShort(preloaded.window)}) used before you type`
  const parts = preloaded.parts.map(part => `${part.name} ${tokensShort(part.tokens)}`)
  let shown = 0

  for (let count = parts.length; count >= 0; count -= 1) {
    const rest = parts.length - count
    const line = head + (count > 0 ? `: ${parts.slice(0, count).join(' · ')}` : '') + (rest > 0 ? ` · +${rest} more` : '')

    if (line.length <= columns || count === 0) {
      shown = count
      break
    }
  }

  const rest = parts.length - shown

  return head + (shown > 0 ? `: ${parts.slice(0, shown).join(' · ')}` : '') + (rest > 0 ? ` · +${rest} more` : '')
}

/** The context window after the latest prompt that knows it. */
function latestContext(rows: readonly CostRow[]): CostRow['context'] {
  return [...rows].reverse().find(row => row.context !== undefined)?.context
}

/**
 * `Context now 88k (8.8% of 1M) · re-sent with every request, so bars add up`,
 * the reason shortened, then dropped, where it does not fit. It sits under
 * the bars so the two numbers are never read as one.
 */
export function contextLine(context: NonNullable<CostRow['context']>, columns: number): string {
  const head = `Context now ${tokensShort(context.tokens)} (${percent(context.tokens, context.window)} of ${tokensShort(context.window)})`
  const reason = [' · re-sent with every request, so bars add up', ' · re-sent with every request', '']

  return head + (reason.find(text => head.length + text.length <= columns) ?? '')
}

/** Under each bar: how many model requests made it. */
export const requestLabel = (requests: number | undefined): string =>
  requests === undefined ? '' : `${requests} req`

const rowsFor = (length: number, columns: number): number => Math.max(1, Math.ceil(length / Math.max(1, columns)))

const cut = (label: string, width: number): string =>
  label.length > width ? `${label.slice(0, width - 1)}…` : label

export type BandView = {
  rows: readonly CostRow[]
  /** The prompts so far (bars kept: the last 60). */
  promptCount: number
  unit: Unit
  isLight: boolean
  cache?: CacheLeft
  preloaded: Preloaded | null
  /** Claude Code's own count of the session's cost. */
  sessionUsd: number | null
  /** The cells the tree is laid out in. */
  columns: number
  /** The rows it may take before it scrolls. */
  maxRows: number
  pricesAsOf: string
  /** The viewer page: a link on surfaces that draw links, else its path. */
  viewer?: { href: string; path: string }
}

export type BandActions = {
  hide: () => void
  show: () => void
  toggleUnit: () => void
}

type Span = { text: string; bold?: boolean; dim?: boolean; color?: string }

function titleSpans(view: BandView, shown: readonly CostRow[]): Span[] {
  const sum = (pick: (row: CostRow) => number): number => shown.reduce((total, row) => total + pick(row), 0)
  const of = `last ${shown.length} of ${Math.max(view.promptCount, shown.at(-1)?.n ?? 0)}`

  if (view.unit === 'tokens') {
    const usd = sum(row => barTotal(row, 'usd'))

    return [
      { text: 'Tokens per prompt ', bold: true },
      { text: `${of}: ${tokensShort(sum(row => barTotal(row, 'tokens')))} tokens (≈${money(usd)} at API list prices)`, dim: true },
    ]
  }

  const unattributed = sum(row => row.unattributedUsd)
  const over = sum(row => row.overUsd)
  const priced = sum(row => barTotal(row, 'usd')) - unattributed

  return [
    { text: 'API list-price equivalent per prompt ', bold: true },
    {
      text:
        `${of}: est. ${money(priced)}` +
        (unattributed >= NOISE_USD ? ` + unattributed ${money(unattributed)}` : '') +
        (view.sessionUsd === null ? '' : ` · Claude Code counts ${money(view.sessionUsd)} this session`) +
        (over >= NOISE_USD ? ` · priced ${money(over)} above Claude Code's count` : ''),
      dim: true,
    },
  ]
}

/** The band's tree, or undefined when there is nothing to show yet. */
export function drawBand(
  els: Elements,
  view: BandView,
  actions: BandActions,
  isHidden: boolean,
): RenderElement | undefined {
  const { Box, Text, Button, Link } = els

  if (isHidden) {
    return (
      <Box flexDirection="row">
        <Text dimColor>Token chart hidden (/token-anatomy) </Text>
        <Button key="show" label="Show" onPress={actions.show} />
      </Box>
    )
  }

  if (view.rows.length === 0) {
    if (view.preloaded === null) {
      return undefined
    }

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>{preloadedLine(view.preloaded, view.columns - 10)} </Text>
        <Button key="hide" label="Hide" onPress={actions.hide} />
      </Box>
    )
  }

  const unit = view.unit
  const shown = view.rows.slice(-barCount(view.columns))
  const cache = view.cache === undefined ? undefined : cacheText(view.cache)
  const unitLabel = unit === 'tokens' ? '$' : 'tokens'
  const buttonsWidth = unitLabel.length + 4 + 'Hide'.length + 4
  const cacheSpan: Span[] = cache === undefined ? [] : [{ text: `  ${cache.text} `, color: cache.color, dim: cache.color === undefined }]
  const spans = [...titleSpans(view, shown), ...cacheSpan]
  const title = (
    <Box flexDirection="row" flexWrap="wrap">
      {spans.map(span => (
        <Text bold={span.bold} dimColor={span.dim} color={span.color}>
          {span.text}
        </Text>
      ))}
      <Text> </Text>
      <Button key="unit" label={unitLabel} onPress={actions.toggleUnit} />
      <Text> </Text>
      <Button key="hide" label="Hide" onPress={actions.hide} />
    </Box>
  )
  const titleRows = rowsFor(spans.reduce((width, span) => width + span.text.length, 0) + buttonsWidth, view.columns)

  // Everything but the bars, to see how many rows the bars may take.
  const preloaded = view.preloaded === null ? undefined : preloadedLine(view.preloaded, view.columns)
  const hasOver = unit === 'usd' && shown.some(row => row.overUsd >= NOISE_USD)
  const legend = SEGMENTS.filter(segment => {
    if (segment.key === 'subagents') {
      return shown.some(row => segmentValues(row, unit).subagents > 0)
    }

    if (segment.key === 'unattributed') {
      return unit === 'usd' && shown.some(row => row.unattributedUsd >= NOISE_USD)
    }

    return true
  })
  const context = latestContext(view.rows)
  const contextText = context === undefined ? undefined : contextLine(context, view.columns)
  const hasRequests = shown.some(row => row.requests !== undefined)
  const legendText = legend.map(segment => `■ ${segment.label}  `).join('') + `list prices of ${view.pricesAsOf}`
  const linkIntro = view.columns >= 70 ? 'Every prompt, request, context and tool in detail: ' : 'Details: '
  const rowsBeside =
    titleRows +
    (preloaded === undefined ? 0 : rowsFor(preloaded.length, view.columns)) +
    2 +
    (hasRequests ? 1 : 0) +
    (hasOver ? 1 : 0) +
    (contextText === undefined ? 0 : rowsFor(contextText.length, view.columns)) +
    rowsFor(legendText.length, view.columns) +
    (view.viewer === undefined ? 0 : 1)
  const height = Math.min(MAX_BAR_ROWS, view.maxRows - rowsBeside)

  if (height < MIN_BAR_ROWS) {
    const last = shown.at(-1)

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text bold>{unit === 'tokens' ? 'Tokens ' : 'API list-price equivalent '}</Text>
        <Text dimColor>
          last prompt {last === undefined ? '' : amount(barTotal(last, unit), unit)} · {shown.length} prompts{' '}
          {amount(
            shown.reduce((sum, row) => sum + barTotal(row, unit), 0),
            unit,
          )}
          {context === undefined
            ? ''
            : ` · context ${tokensShort(context.tokens)} (${percent(context.tokens, context.window)})`}
        </Text>
        {cache === undefined ? null : (
          <Text dimColor={cache.color === undefined} color={cache.color}>
            {'  '}
            {cache.text}
          </Text>
        )}
        <Text> </Text>
        <Button key="unit" label={unitLabel} onPress={actions.toggleUnit} />
        <Text> </Text>
        <Button key="hide" label="Hide" onPress={actions.hide} />
      </Box>
    )
  }

  const totals = shown.map(row => barTotal(row, unit))
  const tallest = totals.reduce((max, value) => Math.max(max, value), 0)
  const cells = shown.map((row, i) => barCells(segmentValues(row, unit), totals[i] ?? 0, height, tallest))
  const middle = Math.floor(height / 2)
  const axisLabel = (row: number): string => {
    const label = row === height - 1 ? amount(tallest, unit) : row === middle ? amount(tallest / 2, unit) : ''

    return `${label.padStart(AXIS - 2)} ┤`
  }
  const barRows = Array.from({ length: height }, (_, i) => height - 1 - i)
  const padded = (text: string): string => cut(text, COLUMN - 2).padEnd(COLUMN)

  return (
    <Box flexDirection="column">
      {title}
      {preloaded === undefined ? null : <Text dimColor>{preloaded}</Text>}
      {barRows.map(row => (
        <Box flexDirection="row">
          <Text dimColor mono>
            {axisLabel(row)}
          </Text>
          {cells.map(bar => {
            const key = bar[row]

            return key === undefined ? (
              <Text mono>{' '.repeat(COLUMN)}</Text>
            ) : (
              <Text mono color={colorOf(key, view.isLight)}>
                {'█'.repeat(BAR) + ' '.repeat(COLUMN - BAR)}
              </Text>
            )
          })}
        </Box>
      ))}
      <Text dimColor mono wrap="truncate">
        {' '.repeat(AXIS) + shown.map(row => padded(row.label)).join('')}
      </Text>
      <Text mono wrap="truncate">
        {' '.repeat(AXIS) + totals.map(total => padded(amount(total, unit))).join('')}
      </Text>
      {hasRequests ? (
        <Text dimColor mono wrap="truncate">
          {' '.repeat(AXIS) + shown.map(row => padded(requestLabel(row.requests))).join('')}
        </Text>
      ) : null}
      {hasOver ? (
        <Text dimColor mono wrap="truncate">
          {' '.repeat(AXIS) +
            shown.map(row => padded(row.overUsd >= NOISE_USD ? `−${money(row.overUsd)}` : '')).join('')}
        </Text>
      ) : null}
      {contextText === undefined ? null : <Text dimColor>{contextText}</Text>}
      <Box flexDirection="row" flexWrap="wrap">
        {legend.flatMap(segment => [
          <Text color={colorOf(segment.key, view.isLight)}>■</Text>,
          <Text>{` ${segment.label}  `}</Text>,
        ])}
        <Text dimColor>list prices of {view.pricesAsOf}</Text>
      </Box>
      {view.viewer === undefined ? null : (
        <Box flexDirection="row">
          <Text dimColor>{linkIntro}</Text>
          <Link href={view.viewer.href} label="viewer.html" />
        </Box>
      )}
    </Box>
  )
}

/** `file:///…/viewer.html#<session>` for a folder on this machine. */
export function viewerHref(logDir: string, sessionId: string): string {
  const path = `${logDir}/viewer.html`
  const prefix = path.startsWith('/') ? 'file://' : 'file:///'

  return `${prefix}${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}#${encodeURIComponent(sessionId)}`
}
