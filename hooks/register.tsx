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

import { hostFrom } from './io'
import type { Ports } from './ports'
import { Recorder } from './recorder'
import type { Config } from './recorder'
import { initialCache } from './state'
import type { CharCounts } from './steps'

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
    } catch (error) {
      $.ui.log(failed('start', error), { to: 'debug' })
    }

    return started
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
      }
    } catch (error) {
      $.ui.log(failed('end a turn', error), { to: 'debug' })
    }

    return result
  }).catch(($, e, next) => next(e))
}
