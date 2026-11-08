// token-usage-anatomy: the hooks module.
//
// Each hook passes its event on unchanged (`next(e)`) and only watches.
// Every hook catches its own errors: whatever goes wrong in the mod, Claude
// Code carries on as if the mod were not there. The work itself is in
// recorder.ts; this file only connects events to it, and spells out every
// call the mod makes on Claude Code (the ports below), so `claude plugin
// validate` can list them.

import { atom, read, update } from 'claude-code'
import type { PluginOptions, Register } from 'claude-code'

import { drawBand, viewerHref } from './band'
import type { BandActions, BandView } from './band'
import { hostFrom } from './io'
import type { Ports } from './ports'
import { PRICES } from './prices'
import { Recorder } from './recorder'
import type { Config } from './recorder'
import { initialCache } from './state'
import type { CharCounts } from './steps'
import {
  customSlug,
  isBuiltInLight,
  isCustomLight,
  lightFromColorFgBg,
  lightFromGnome,
  lightFromMacStyle,
  lightFromWindows,
} from './theme'

// The session values (types in ../types/index.d.ts). They live in this file
// because Claude Code reads each atom off the file that reads or writes it.
const rowsAtom = atom({ plugin: 'token-usage-anatomy', key: 'rows' } as const, [], { shape: 'rows-1' })
const sessionUsdAtom = atom({ plugin: 'token-usage-anatomy', key: 'sessionUsd' } as const, null)
const promptNoAtom = atom({ plugin: 'token-usage-anatomy', key: 'promptNo' } as const, 0)
const transcriptAtom = atom({ plugin: 'token-usage-anatomy', key: 'transcriptPath' } as const, null)
const cacheAtom = atom({ plugin: 'token-usage-anatomy', key: 'cache' } as const, initialCache, { shape: 'cache-1' })
const preloadedAtom = atom({ plugin: 'token-usage-anatomy', key: 'preloaded' } as const, null, {
  shape: 'preloaded-1',
})
const isHiddenAtom = atom({ plugin: 'token-usage-anatomy', key: 'isHidden' } as const, false)
const isLightAtom = atom({ plugin: 'token-usage-anatomy', key: 'isLight' } as const, false)
const unitAtom = atom({ plugin: 'token-usage-anatomy', key: 'unit' } as const, 'tokens')

/** The pane that holds the chart where a surface draws no band (VS Code, mobile). */
const PANE_ID = 'token-anatomy'

const USAGE = 'Usage: /token-anatomy [show|hide|open]'

function configOf(options: PluginOptions): Config {
  return {
    recordRequests: options.recordRequests === true,
    includePromptText: options.includePromptText === true,
    logDir: typeof options.logDir === 'string' ? options.logDir.trim() : '',
  }
}

/** The size of a tool's result, never its contents. */
function resultSize(result: { text?: string; result?: unknown }): number {
  if (typeof result.text === 'string') {
    return result.text.length
  }

  try {
    return result.result === undefined ? 0 : (JSON.stringify(result.result)?.length ?? 0)
  } catch {
    return 0
  }
}

const failed = (what: string, error: unknown): string => `token-usage-anatomy: ${what}: ${String(error)}`

export const register: Register = (on, options) => {
  const recorder = new Recorder(configOf(options))
  /** Reads the theme again; set once the session has started. */
  let refreshTheme: (() => Promise<void>) | undefined
  /** `auto` and custom themes can change under us: read again after each prompt. */
  let isThemeLive = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    try {
      const ports: Ports = {
        now: () => $.clock.now(),
        sleep: ms => $.clock.sleep(ms),
        debug: text => $.ui.log(text, { to: 'debug' }),
        fs: {
          read: path => $.fs.read(path),
          readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
          write: (path, text) => $.fs.write(path, text),
          list: path => $.fs.list(path),
          exists: path => $.fs.exists(path),
          stat: path => $.fs.stat(path),
        },
        run: (argv, init) => $.process.run(argv, init),
        store: {
          get: key => $.store.get(key),
          set: (key, value) => $.store.set(key, value),
        },
        session: {
          id: () => $.session.id(),
          model: () => $.session.model(),
          usage: () => $.session.usage(),
          breakdown: () => $.session.usage({ breakdown: 'summary' }),
        },
        agents: () => $.agent.list(),
        state: {
          rows: {
            get: () => read($, rowsAtom),
            set: async change => void (await update($, rowsAtom, change)),
          },
          sessionUsd: {
            get: () => read($, sessionUsdAtom),
            set: async change => void (await update($, sessionUsdAtom, change)),
          },
          promptNo: {
            get: () => read($, promptNoAtom),
            set: async change => void (await update($, promptNoAtom, change)),
          },
          transcriptPath: {
            get: () => read($, transcriptAtom),
            set: async change => void (await update($, transcriptAtom, change)),
          },
          cache: {
            get: () => read($, cacheAtom),
            set: async change => void (await update($, cacheAtom, change)),
          },
          preloaded: {
            get: () => read($, preloadedAtom),
            set: async change => void (await update($, preloadedAtom, change)),
          },
        },
      }
      const host = hostFrom({
        os: await $.env.get('OS'),
        userProfile: await $.env.get('USERPROFILE'),
        home: await $.env.get('HOME'),
        configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
        pluginRoot: $.plugin.root,
      })

      void recorder.start(ports, host, e.isInteractive).catch(error => $.ui.log(failed('start', error), { to: 'debug' }))

      await $.command.register({
        name: 'token-anatomy',
        description: 'Show or hide the token chart, or print the link to the viewer page',
        argumentHint: '[show|hide|open]',
        immediate: true,
      })

      // Light or dark, for the band's palette: the theme setting, and for
      // `auto` what the terminal or the system says. Anything unclear is dark.
      refreshTheme = async () => {
        const theme = String((await $.config.list()).find(row => row.key === 'theme')?.value ?? 'dark')
        isThemeLive = theme === 'auto' || theme.startsWith('custom:')
        const light = await (async (): Promise<boolean> => {
          if (theme !== 'auto') {
            const slug = customSlug(theme)

            if (slug === undefined) {
              return isBuiltInLight(theme)
            }

            return isCustomLight(await $.fs.read(`${host.claudeDir}/themes/${slug}.json`).catch(() => ''))
          }

          const fromTerminal = lightFromColorFgBg(await $.env.get('COLORFGBG'))

          if (fromTerminal !== undefined) {
            return fromTerminal
          }

          if (host.isWindows) {
            const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
            const run = await $.process.run(['reg', 'query', key, '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 }).catch(() => undefined)

            return (run === undefined ? undefined : lightFromWindows(run.stdout)) ?? false
          }

          const mac = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 }).catch(() => undefined)
          const fromMac = mac === undefined ? undefined : lightFromMacStyle(mac)

          if (fromMac !== undefined) {
            return fromMac
          }

          const gnome = await $.process
            .run(['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme'], { timeoutMs: 5_000 })
            .catch(() => undefined)

          return (gnome === undefined || gnome.exitCode !== 0 ? undefined : lightFromGnome(gnome.stdout)) ?? false
        })()
        await update($, isLightAtom, () => light)
      }
      void refreshTheme().catch(error => $.ui.log(failed('read the theme', error), { to: 'debug' }))

      // The cache countdown: once a second while the cache is warm (and one
      // more second to show it going cold), move the band's clock on.
      $.clock.every(1_000, () => {
        void (async () => {
          const cache = await read($, cacheAtom)
          const now = await $.clock.now()

          if (cache.expiresAt !== null && now <= cache.expiresAt + 1_000) {
            await update($, cacheAtom, value => ({ ...value, now }))
          }
        })().catch(() => undefined)
      })
    } catch (error) {
      $.ui.log(failed('start', error), { to: 'debug' })
    }

    return started
  }).catch(($, e, next) => next(e))

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    void refreshTheme?.().catch(error => $.ui.log(failed('read the theme', error), { to: 'debug' }))

    return result
  }).catch(($, e, next) => next(e))

  // Claude Code names the transcript file only in its settings-hook events.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      await recorder.setTranscript(e.transcript_path)
    } catch (error) {
      $.ui.log(failed('note the transcript', error), { to: 'debug' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    try {
      await recorder.setTranscript(e.transcript_path)
      recorder.stopped()
    } catch (error) {
      $.ui.log(failed('note the title', error), { to: 'debug' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    try {
      recorder.setAgentTranscript(e.agent_id, e.agent_transcript_path)
    } catch (error) {
      $.ui.log(failed('note a subagent transcript', error), { to: 'debug' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await recorder.cleared()
      } catch (error) {
        $.ui.log(failed('clear', error), { to: 'debug' })
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    // Before `next`: the transcript's size now is where this turn's responses start.
    try {
      await recorder.turnStart(e.turnId, e.text, e.agentId)
    } catch (error) {
      $.ui.log(failed('start a turn', error), { to: 'debug' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // One model request: count what streams (characters only, never the text
  // itself), then record its usage. Every chunk passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const chars: CharCounts = { thinking: 0, text: 0, toolInput: 0 }
    const stream = next(e)
    let item = await stream.next()

    while (item.done !== true) {
      const chunk = item.value

      if (chunk.kind === 'thinking' || chunk.kind === 'text') {
        chars[chunk.kind] += chunk.text.length
      } else if (chunk.kind === 'input') {
        chars.toolInput += chunk.json.length
      }

      yield chunk
      item = await stream.next()
    }

    // The stream's return value is the response; `result` holds it too.
    const result = item.value ?? (await stream.result)

    try {
      await recorder.step(e, result, chars, startedAt, await $.clock.now())
    } catch (error) {
      $.ui.log(failed('record a request', error), { to: 'debug' })
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    try {
      const isDenied = 'deny' in result && result.deny !== undefined
      recorder.tool(e.agentId, String(e.tool), isDenied ? 0 : resultSize(result), isDenied || result.isError === true)
    } catch (error) {
      $.ui.log(failed('count a tool call', error), { to: 'debug' })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    try {
      if (result.skip === undefined) {
        await recorder.compacted(e, result.tokensBefore, result.tokensAfter, result.usage)
      }
    } catch (error) {
      $.ui.log(failed('note a compaction', error), { to: 'debug' })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    try {
      if (e.agentId !== undefined) {
        recorder.agentEnded(e.agentId)
      } else {
        await recorder.turnComplete(e)

        if (isThemeLive) {
          void refreshTheme?.().catch(error => $.ui.log(failed('read the theme', error), { to: 'debug' }))
        }
      }
    } catch (error) {
      $.ui.log(failed('end a turn', error), { to: 'debug' })
    }

    return result
  }).catch(($, e, next) => next(e))

  // /token-anatomy [show|hide|open]. Where no surface draws the band (VS
  // Code, mobile), show and hide open and close a pane instead.
  on('command.run', { command: 'token-anatomy' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'open') {
      const logDir = recorder.logDir

      if (logDir === undefined) {
        return { text: 'The log folder is not ready yet; try again in a moment.' }
      }

      return {
        text:
          `Viewer: ${viewerHref(logDir, await $.session.id())}\n` +
          `Open it in a browser. It reads the logs in ${logDir} and needs no network.`,
      }
    }

    if (arg !== '' && arg !== 'show' && arg !== 'hide') {
      return { text: USAGE }
    }

    const surfaces = await $.session.surfaces()
    const hasBand = surfaces.length === 0 || surfaces.some(surface => surface === 'terminal' || surface === 'desktop')

    if (!hasBand) {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE_ID)

      if (arg === 'hide' || (arg === '' && isOpen)) {
        await $.ui.close({ id: PANE_ID })

        return { text: 'Token chart closed. /token-anatomy show opens it again.' }
      }

      const opened = await $.ui.open({ id: PANE_ID, title: 'Token anatomy' })

      return {
        text: opened.isPlaced ? 'Token chart opened in a pane.' : `The token chart could not open a pane here (${opened.reason}).`,
      }
    }

    const hide = arg === 'hide' || (arg === '' && !(await read($, isHiddenAtom)))
    await update($, isHiddenAtom, () => hide)

    if (hide) {
      return { text: 'Token chart hidden. /token-anatomy show brings it back.' }
    }

    return {
      text:
        (await read($, rowsAtom)).length > 0
          ? 'Token chart shown above the prompt.'
          : 'Token chart on: it appears above the prompt after your first prompt.',
    }
  }).catch(() => ({ text: 'token-anatomy: that did not work; the debug log says why.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const cache = await read($, cacheAtom)
    const now = Math.max(cache.now, await $.clock.now())
    const logDir = recorder.logDir
    const view: BandView = {
      rows: await read($, rowsAtom),
      promptCount: await read($, promptNoAtom),
      unit: await read($, unitAtom),
      isLight: await read($, isLightAtom),
      cache: cache.expiresAt === null ? undefined : { remainingMs: cache.expiresAt - now, ttlMs: cache.ttlMs },
      preloaded: await read($, preloadedAtom),
      sessionUsd: await read($, sessionUsdAtom),
      columns: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      pricesAsOf: PRICES.asOf,
      viewer:
        logDir === undefined
          ? undefined
          : { href: viewerHref(logDir, await $.session.id()), path: `${logDir}/viewer.html` },
    }
    const actions: BandActions = {
      hide: () => void update($, isHiddenAtom, () => true),
      show: () => void update($, isHiddenAtom, () => false),
      setUnit: unit => void update($, unitAtom, () => unit),
    }

    return drawBand($.ui.resolve(e), view, actions, await read($, isHiddenAtom)) ?? next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const cache = await read($, cacheAtom)
    const now = Math.max(cache.now, await $.clock.now())
    const logDir = recorder.logDir
    const view: BandView = {
      rows: await read($, rowsAtom),
      promptCount: await read($, promptNoAtom),
      unit: await read($, unitAtom),
      isLight: await read($, isLightAtom),
      cache: cache.expiresAt === null ? undefined : { remainingMs: cache.expiresAt - now, ttlMs: cache.ttlMs },
      preloaded: await read($, preloadedAtom),
      sessionUsd: await read($, sessionUsdAtom),
      columns: e.props.bodyColumns,
      maxRows: Math.max(e.props.scroll.bodyRows, 16),
      pricesAsOf: PRICES.asOf,
      viewer:
        logDir === undefined
          ? undefined
          : { href: viewerHref(logDir, await $.session.id()), path: `${logDir}/viewer.html` },
    }
    const actions: BandActions = {
      hide: () => void $.ui.close({ id: PANE_ID }),
      show: () => undefined,
      setUnit: unit => void update($, unitAtom, () => unit),
    }
    const { Text } = $.ui.resolve(e)

    return (
      drawBand($.ui.resolve(e), view, actions, false) ?? (
        <Text dimColor>The token chart fills in after your first prompt.</Text>
      )
    )
  }).catch(($, e, next) => next(e))
}
