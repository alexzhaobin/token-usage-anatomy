import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barCells, barCount, cacheText, preloadedLine, viewerHref } from '../hooks/band'
import { countdown, money, percent, tokensShort } from '../hooks/format'
import {
  customSlug,
  isCustomLight,
  lightFromColorFgBg,
  lightFromGnome,
  lightFromMacStyle,
  lightFromWindows,
} from '../hooks/theme'
import type { CostRow } from '../types'

const row = (n: number, label: string, scale = 1): CostRow => ({
  n,
  label,
  // 7,310 tokens at scale 1: mostly cache reads, as in real sessions.
  tokens: { input: 10 * scale, cacheRead: 5_000 * scale, cacheWrite: 2_000 * scale, reasoning: 120 * scale, answer: 180 * scale },
  subagentTokens: 0,
  parts: { input: 0.00004, cacheRead: 0.001, cacheWrite: 0.016, reasoning: 0.0024, answer: 0.0036 },
  subagentUsd: 0,
  unattributedUsd: 0,
  overUsd: 0,
})

const ROWS = [row(1, 'Explain the log fields'), row(2, 'Fix the parser', 3), row(3, 'Add tests', 2)]

describe('format', () => {
  test('money', () => {
    expect([123.4, 12.34, 0.1234, 0.01234, 0.0004, 0].map(money)).toEqual([
      '$123',
      '$12.3',
      '$0.12',
      '$0.012',
      '<$0.001',
      '$0',
    ])
  })

  test('tokens', () => {
    expect([999, 8_200, 150_000, 999_960, 1_000_000, 1_250_000].map(tokensShort)).toEqual([
      '999',
      '8.2k',
      '150k',
      '1M',
      '1M',
      '1.3M',
    ])
  })

  test('countdown and percent', () => {
    expect(countdown(299_001)).toBe('5:00')
    expect(countdown(59_000)).toBe('0:59')
    expect(countdown(3_600_000)).toBe('1:00:00')
    expect(percent(19_700, 1_000_000)).toBe('2.0%')
  })
})

describe('bars', () => {
  test('one bar per nine columns after the axis', () => {
    expect([80, 17, 10].map(barCount)).toEqual([8, 1, 1])
  })

  test('parts fill from the bottom on rounded running totals', () => {
    const values = { cacheRead: 50, cacheWrite: 25, input: 0, reasoning: 0, answer: 25, subagents: 0, unattributed: 0 }

    expect(barCells(values, 100, 8, 100)).toEqual([
      'cacheRead',
      'cacheRead',
      'cacheRead',
      'cacheRead',
      'cacheWrite',
      'cacheWrite',
      'answer',
      'answer',
    ])
    // A small bar still shows: at least one row, never more than its height.
    const small = { ...values, cacheRead: 1, cacheWrite: 0, answer: 0 }
    expect(barCells(small, 1, 8, 100).filter(Boolean)).toHaveLength(1)
    expect(barCells(values, 1, 8, 100)).toHaveLength(8)
    expect(barCells(values, 0, 3, 100)).toEqual([undefined, undefined, undefined])
  })

  test('the cache countdown changes colour as it runs out', () => {
    expect(cacheText({ remainingMs: 200_000, ttlMs: 300_000 })).toEqual({ text: 'cache warm 3:20', color: '#1baf7a' })
    expect(cacheText({ remainingMs: 100_000, ttlMs: 300_000 }).color).toBe('#eda100')
    expect(cacheText({ remainingMs: 40_000, ttlMs: 300_000 }).color).toBe('#eb6834')
    expect(cacheText({ remainingMs: 10_000, ttlMs: 300_000 }).color).toBe('#d63c3c')
    expect(cacheText({ remainingMs: 0, ttlMs: 300_000 })).toEqual({ text: 'cache cold' })
  })

  test('the preloaded line counts what does not fit instead of cutting it', () => {
    const preloaded = {
      tokens: 19_700,
      window: 1_000_000,
      parts: [
        { name: 'System tools', tokens: 12_500 },
        { name: 'System prompt', tokens: 6_000 },
        { name: 'Memory files', tokens: 1_200 },
      ],
    }

    expect(preloadedLine(preloaded, 200)).toBe(
      'Preloaded context 19.7k (2.0% of 1M) used before you type: System tools 12.5k · System prompt 6k · Memory files 1.2k',
    )
    expect(preloadedLine(preloaded, 90)).toBe(
      'Preloaded context 19.7k (2.0% of 1M) used before you type: System tools 12.5k · +2 more',
    )
  })

  test('the viewer link is a file URL, escaped', () => {
    expect(viewerHref('/Users/me/.claude/token-usage-anatomy', 'abc')).toBe(
      'file:///Users/me/.claude/token-usage-anatomy/viewer.html#abc',
    )
    expect(viewerHref('C:/Users/Me Two/logs #1', 'a b')).toBe('file:///C:/Users/Me%20Two/logs%20%231/viewer.html#a%20b')
  })
})

describe('theme', () => {
  test('auto: terminal, macOS, GNOME and Windows answers', () => {
    expect(lightFromColorFgBg('0;15')).toBe(true)
    expect(lightFromColorFgBg('15;0')).toBe(false)
    expect(lightFromColorFgBg(undefined)).toBeUndefined()
    expect(lightFromMacStyle({ exitCode: 0, stdout: 'Dark\n', stderr: '' })).toBe(false)
    expect(
      lightFromMacStyle({ exitCode: 1, stdout: '', stderr: 'The domain/default pair of (x, AppleInterfaceStyle) does not exist' }),
    ).toBe(true)
    expect(lightFromGnome("'prefer-dark'\n")).toBe(false)
    expect(lightFromGnome("'default'\n")).toBe(true)
    expect(lightFromWindows('    AppsUseLightTheme    REG_DWORD    0x1\r\n')).toBe(true)
    expect(lightFromWindows('    AppsUseLightTheme    REG_DWORD    0x0\r\n')).toBe(false)
  })

  test('custom themes, and slugs that cannot leave the themes folder', () => {
    expect(customSlug('custom:solar-light')).toBe('solar-light')
    expect(customSlug('custom:../../etc/passwd')).toBeUndefined()
    expect(customSlug('dark')).toBeUndefined()
    expect(isCustomLight('{"base":"light-daltonized"}')).toBe(true)
    expect(isCustomLight('not json')).toBe(false)
  })
})

// The band through Claude Code's own drawing. Session values are seeded
// beneath the plugin; the first write to a key hands it to the kit's own
// store, which redraws the band as the engine would.
function seed(on: On, values: Record<string, unknown>): void {
  const plugin = 'token-usage-anatomy'
  const seeded = new Map(Object.entries(values))
  mock.clock(on, { now: 1_000_000 })

  // The read goes through to the kit first, so the band is subscribed to it.
  on('state.get', async ($, e, next) => {
    const read = await next(e)

    return e.plugin === plugin && seeded.has(e.key) ? { value: { value: seeded.get(e.key), version: 1 } } : read
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === plugin) {
      seeded.delete(e.key)
    }

    return next(e)
  })
}

const BAND = (maxRows = 24) =>
  ({
    plugin: 'token-usage-anatomy',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: maxRows },
      view: {},
    },
  }) as const

const BASE = {
  rows: { shape: 'rows-1', value: ROWS },
  promptNo: 3,
  cache: { shape: 'cache-1', value: { expiresAt: 1_240_000, ttlMs: 300_000, now: 1_000_000 } },
}

describe('the band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`tokens first, a button for dollars (${surface})`, async ($, on) => {
      seed(on, BASE)
      const ui = await $.ui.mount({ ...BAND(), surface })

      expect((await ui.find({ type: 'Text', text: /Tokens per prompt/ }))?.text).toBe('Tokens per prompt ')
      expect(await ui.find({ type: 'Text', text: /last 3 of 3: 43.9k tokens/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cache warm 4:00/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Explai… +Fix th… +Add te…/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: / cache read / })).toBeDefined()

      await ui.press({ key: 'unit' })
      expect(await ui.find({ type: 'Text', text: /API list-price equivalent per prompt/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('hidden, it is one line with a Show button', async ($, on) => {
    seed(on, { ...BASE, isHidden: true })
    const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /Token chart hidden/ })).toBeDefined()
    await ui.press({ key: 'show' })
    expect(await ui.find({ type: 'Text', text: /Tokens per prompt/ })).toBeDefined()
    await ui.unmount()
  })

  test('short on rows, it is one line', async ($, on) => {
    seed(on, BASE)
    const ui = await $.ui.mount({ ...BAND(5), surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /last prompt 14.6k · 3 prompts 43.9k/ })).toBeDefined()
    await ui.unmount()
  })

  test('in VS Code the same chart is drawn in a pane', async ($, on) => {
    seed(on, BASE)
    const ui = await $.ui.mount({
      plugin: 'token-usage-anatomy',
      surface: 'vscode',
      component: 'Pane',
      requestId: 'token-anatomy',
      props: {
        title: 'Token anatomy',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })

    expect(await ui.find({ type: 'Text', text: /Tokens per prompt/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('/token-anatomy', () => {
  const run = (args: string) => ({
    command: 'token-anatomy',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as const

  test('hide, show, and a usage line for anything else', async ($, on) => {
    seed(on, {})
    on('session.surfaces', () => ({ value: ['terminal'] }))

    expect((await $.command.run(run('hide'))).text).toBe('Token chart hidden. /token-anatomy show brings it back.')
    expect((await $.command.run(run('show'))).text).toBe(
      'Token chart on: it appears above the prompt after your first prompt.',
    )
    expect((await $.command.run(run('sideways'))).text).toBe('Usage: /token-anatomy [show|hide|open]')
  })

  test('where no surface draws the band, show opens a pane', async ($, on) => {
    seed(on, {})
    on('session.surfaces', () => ({ value: ['vscode'] }))
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    expect((await $.command.run(run('show'))).text).toBe('Token chart opened in a pane.')
  })
})


