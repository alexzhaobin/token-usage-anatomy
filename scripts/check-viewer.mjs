#!/usr/bin/env node
// Opens assets/viewer.html from disk in headless Chrome (or Chromium, or
// Edge) over a log folder built from fixtures, and checks what a reader
// would see: the data read whole, text released, keyboard use, themes,
// local times, lazy tables, notes, insights, and hostile text kept as text.
//
//   node --experimental-strip-types --no-warnings scripts/check-viewer.mjs
//
// Set CHROME to a browser's path to choose one. No npm dependencies: the
// browser is driven over the DevTools protocol with Node's own WebSocket.

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PRICES } from '../hooks/prices.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = join(root, 'assets', 'viewer.html')

// ------------------------------------------------------------ the log folder
// Written as hooks/logbook.ts writes it (its tests pin the format).

const SCHEMA = 'token-usage-anatomy/1'
const scriptString = text =>
  JSON.stringify(text).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const dataStatement = (id, text) => `(window.TUA_DATA = window.TUA_DATA || []).push([${scriptString(id)}, ${scriptString(text)}]);\n`
const jsonl = rows => rows.map(row => (typeof row === 'string' ? row : JSON.stringify({ schema: SCHEMA, ...row }))).join('\n') + '\n'

const HOSTILE_TITLE = '</script><b id="injected-title">bold</b> title \u2028 end'
const HOSTILE_LABEL = '<img id="injected-label" src="x" onerror="window.injected=1">'
const PEAK = 777_777

function prompt(n, at, extra = {}) {
  return {
    kind: 'prompt',
    at,
    promptNo: n,
    turnId: `t${n}`,
    reason: 'answer',
    durationMs: 12_000,
    model: 'claude-opus-5-5',
    models: { 'claude-opus-5-5': 3 },
    effort: 'high',
    requests: 3,
    inputTokens: 30,
    cacheReadTokens: 150_000,
    cacheCreationTokens: 9_000,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 9_000,
    outputTokens: 1_500,
    reasoningTokens: 400,
    answerTokens: 1_100,
    reasoningMethod: 'reported',
    cacheMissRequests: 0,
    recachedTokens: 0,
    idleBeforeMs: 20_000,
    contextTokens: 55_000,
    peakContextTokens: 55_000,
    contextByStep: [50_000, 52_000, 55_000],
    contextWindow: 1_000_000,
    contextAfterTokens: 55_000,
    tools: { Bash: { calls: 2, resultChars: 80_000, errors: 0 }, Read: { calls: 1, resultChars: 4_000, errors: 1 } },
    toolResultTokensEst: 21_000,
    fastRequests: 0,
    usOnlyRequests: 0,
    requestFields: ['inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens', 'isReasoningReported', 'cacheWrite5mTokens', 'costUsd', 'toolUses', 'durationMs', 'model', 'isFast', 'isUsOnly'],
    requestModels: ['claude-opus-5-5'],
    requestDetail: [
      [10, 3_000, 47_000, 500, 100, 1, 0, 0.05, 1, 4_000, 0, 0, 0],
      [10, 3_000, 49_000, 500, 150, 1, 0, 0.05, 1, 4_000, 0, 0, 0],
      [10, 3_000, 54_000, 500, 150, 1, 0, 0.05, 0, 4_000, 0, 0, 0],
    ],
    pricesAsOf: PRICES.asOf,
    estCostUsd: 0.15,
    estCostParts: { input: 0.0002, cacheRead: 0.075, cacheWrite: 0.09, reasoning: 0.01, answer: 0.0275 },
    estSubagentUsd: 0,
    unattributedUsd: 0,
    overUsd: 0,
    ...extra,
  }
}

// A request list far longer than any the mod writes, peaking at PEAK.
const huge = Array.from({ length: 200_000 }, (_, i) => 40_000 + (i % 1000))
huge[123_456] = PEAK

const batch1 = jsonl([
  { kind: 'context', at: '2026-01-02T03:00:00.000Z', promptNo: 0, model: 'claude-opus-5-5', window: 1_000_000, totalTokens: 49_000, maxTokens: 1_000_000, preloadedTokens: 49_000, categories: [
    { name: 'System prompt', tokens: 4_000, kind: 'used' },
    { name: 'System tools', tokens: 28_000, kind: 'used' },
    { name: 'Memory files', tokens: 7_000, kind: 'used' },
    { name: 'Skills', tokens: 10_000, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 918_000, kind: 'free' },
  ] },
  { kind: 'session', at: '2026-01-02T03:00:01.000Z', title: HOSTILE_TITLE },
  prompt(1, '2026-01-02T03:04:05.000Z', { label: HOSTILE_LABEL }),
])
const batch2 = jsonl([
  prompt(2, '2026-01-02T03:10:00.000Z', {
    fastRequests: 2,
    usOnlyRequests: 1,
    requestDetail: [
      [10, 3_000, 47_000, 500, 100, 1, 0, 0.05, 1, 4_000, 0, 1, 0],
      [10, 3_000, 49_000, 500, 150, 1, 0, 0.05, 1, 4_000, 0, 1, 1],
      [10, 3_000, 54_000, 500, 150, 0, 0, 0.05, 0, 4_000, 0, 0, 0],
    ],
    subagents: {
      starts: 1, runs: 0, agentCount: 1, requests: 4,
      tokens: { input: 40, cacheRead: 60_000, cacheWrite: 20_000, reasoning: 2_000, answer: 3_000 },
      estCostUsd: 0.2,
      // Still running when prompt 2 ends; it finishes during prompt 3.
      agents: [{ id: 'a1', type: 'Explore', description: '<script>agent</script> search', starts: 1, runs: 0, isRunning: true, requests: 4, tokens: { input: 40, cacheRead: 60_000, cacheWrite: 20_000, reasoning: 2_000, answer: 3_000 }, totalTokens: 85_040, tools: { Grep: { calls: 3, resultChars: 900, errors: 0 } }, estCostUsd: 0.2 }],
    },
    estSubagentUsd: 0.2,
  }),
])
const segment2 = jsonl([
  prompt(3, '2026-01-02T03:30:00.000Z', {
    cacheMissRequests: 1, recachedTokens: 60_000, cacheCreationTokens: 60_000, idleBeforeMs: 4_000_000, unattributedUsd: 0.01,
    subagents: {
      starts: 0, runs: 1, agentCount: 1, requests: 1,
      tokens: { input: 10, cacheRead: 0, cacheWrite: 0, reasoning: 100, answer: 200 },
      estCostUsd: 0.01,
      agents: [{ id: 'a1', type: 'Explore', description: 'search', starts: 0, runs: 1, isRunning: false, requests: 1, tokens: { input: 10, cacheRead: 0, cacheWrite: 0, reasoning: 100, answer: 200 }, totalTokens: 310, tools: {}, estCostUsd: 0.01 }],
    },
    estSubagentUsd: 0.01,
  }),
  { kind: 'compact', at: '2026-01-02T03:31:00.000Z', trigger: 'auto', tokensBefore: 180_000, tokensAfter: 30_000 },
  { kind: 'context', at: '2026-01-02T03:31:01.000Z', promptNo: 3, model: 'claude-opus-5-5', totalTokens: 30_000, maxTokens: 0, preloadedTokens: 0, categories: [{ name: 'Messages', tokens: 30_000, kind: 'used' }] },
  prompt(4, '2026-01-02T03:40:00.000Z', { requests: 200_000, contextByStep: huge, peakContextTokens: 0 }),
  { schema: 'token-usage-anatomy/2', kind: 'prompt', at: '2026-01-02T03:50:00.000Z', promptNo: 5 },
  '{not json',
])

const work = mkdtempSync(join(tmpdir(), 'tua-viewer-'))
const logs = join(work, 'logs')
mkdirSync(join(logs, 'data'), { recursive: true })
copyFileSync(page, join(logs, 'viewer.html'))
writeFileSync(join(logs, 'pricing.js'), `window.TUA_PRICES = JSON.parse(${scriptString(JSON.stringify(PRICES))});\n`)
writeFileSync(
  join(logs, 'usage-index.js'),
  `window.TUA_INDEX = JSON.parse(${scriptString(JSON.stringify([
    { id: 'sess-a', mtimeMs: 2_000, segments: 2, title: HOSTILE_TITLE },
    // Listed, but its data file is gone.
    { id: 'sess-b', mtimeMs: 1_000, segments: 1, title: 'Older session' },
  ]))});\n`,
)
writeFileSync(join(logs, 'data', 'sess-a.js'), dataStatement('sess-a', batch1) + dataStatement('sess-a', batch2))
writeFileSync(join(logs, 'data', 'sess-a.2.js'), dataStatement('sess-a', segment2))
// A log opened through the file picker.
const opened = join(work, 'sess-x.jsonl')
writeFileSync(opened, jsonl([prompt(1, '2026-01-03T09:00:00.000Z'), prompt(2, '2026-01-03T09:05:00.000Z')]))

// ------------------------------------------------------------ the browser

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [
      ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(name =>
        process.env[name] ? [join(process.env[name], 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env[name], 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : [],
      ),
    ],
  }[process.platform] || []
  for (const path of candidates) if (existsSync(path)) return path
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  return undefined
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function launch(browser) {
  const profile = join(work, 'profile')
  // Ubuntu's AppArmor blocks Chrome's sandbox on CI runners; elsewhere it stays on.
  const sandbox = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
  const child = spawn(browser, [...sandbox, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 150 && !existsSync(portFile); i += 1) await sleep(100)
  if (!existsSync(portFile)) throw new Error('the browser did not open a DevTools port')
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  let targets = []
  for (let i = 0; i < 50 && !targets.some(t => t.type === 'page'); i += 1) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    if (!targets.some(t => t.type === 'page')) await sleep(100)
  }
  const target = targets.find(t => t.type === 'page')
  return { child, url: target.webSocketDebuggerUrl }
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.next = 1
    this.pending = new Map()
    this.waiters = []
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      } else if (message.method) {
        this.waiters = this.waiters.filter(waiter => !(waiter.method === message.method && (waiter.resolve(message.params), true)))
      }
    })
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  once(method) {
    return new Promise(resolve => this.waiters.push({ method, resolve }))
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`${expression}\n  ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result.value
  }

  async key(key, code = key, keyCode = 0) {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode })
  }

  async until(expression, what, ms = 8_000) {
    for (let waited = 0; waited < ms; waited += 50) {
      if (await this.eval(expression)) return
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
}

// ------------------------------------------------------------ the checks

let failures = 0
let passes = 0
function check(name, isOk, detail = '') {
  if (isOk) passes += 1
  else failures += 1
  console.log(`${isOk ? 'ok  ' : 'FAIL'} ${name}${isOk || !detail ? '' : `\n     ${detail}`}`)
}

const browser = findBrowser()
if (!browser) {
  console.error('No Chrome, Chromium or Edge found; set CHROME to a browser to run the viewer check.')
  process.exit(1)
}

const size = statSync(page).size
check(`viewer.html is under 256 KiB (${(size / 1024).toFixed(1)} KiB)`, size < 256 * 1024)

const { child, url } = await launch(browser)
const cdp = new Cdp(url)
await cdp.open()
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('DOM.enable')
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
const errors = []
cdp.send('Log.enable')
const pageUrl = pathToFileURL(join(logs, 'viewer.html')).href

async function visit(hash) {
  // Through a blank page, so a change of hash alone still loads the page afresh.
  const blank = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await blank
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: pageUrl + hash })
  await loaded
  await cdp.until(`!!(document.querySelector('#tiles') || document.querySelector('#empty'))`, 'the page to draw')
}

const text = () => cdp.eval('document.body.innerText')
const noBadNumbers = async where => {
  const body = await text()
  const bad = body.match(/.{0,30}\b(NaN|undefined|Infinity)\b.{0,30}/)
  check(`no NaN, undefined or Infinity on the page (${where})`, bad === null, bad ? bad[0] : '')
}

try {
  // A malformed hash falls back to the newest session.
  await visit('#%E0%A4%A')
  check('a malformed hash opens the newest session', (await cdp.eval(`document.getElementById('subtitle').textContent`)).includes('session sess-a'))

  check('every batch of every segment is read (4 prompts)', (await cdp.eval(`document.querySelector('#tiles .tile:nth-child(2) .value').textContent`)) === '4')
  check('session text is released after reading', await cdp.eval(`Array.isArray(window.TUA_DATA) && window.TUA_DATA.length === 0 && !document.querySelector('script[src^="data/"]')`))
  check('the peak of a 200,000-value array is found', (await cdp.eval(`document.querySelector('#tiles .tile:nth-child(6) .value').textContent`)) === '778k')

  // Hostile text stays text.
  check('a hostile title and label are drawn as text, not markup', await cdp.eval(`!document.getElementById('injected-title') && !document.getElementById('injected-label') && !window.injected && document.getElementById('subtitle').textContent.includes('<b id=')`))
  check('the page title follows the session title', (await cdp.eval('document.title')).includes('bold</b> title'))

  check('every chart is a labelled group', await cdp.eval(`[...document.querySelectorAll('svg.chart')].length > 0 && [...document.querySelectorAll('svg.chart')].every(s => s.getAttribute('role') === 'group' && s.getAttribute('aria-label'))`))

  const insights = await cdp.eval(`document.getElementById('insights')?.innerText || ''`)
  check('insights: the cold cache, from the rows', /went cold 1 time \(prompt #3\)/.test(insights) && /after a pause longer than the cache lasts \(1 hour\)/.test(insights), insights)
  check('insights: what was preloaded', /Before the first prompt, 49k tokens \(4\.9% of the 1M window\)/.test(insights), insights)

  const notes = await cdp.eval(`document.getElementById('notes').innerText`)
  check('notes: dollars are an API list-price equivalent, with the date', notes.includes('API list-price equivalent') && notes.includes(PRICES.asOf))
  check('notes: fast mode counts and rates from the price table', /2 requests ran in fast mode/.test(notes) && /Fast mode rates per million tokens: .*Opus 5\.5 \$8 in \/ \$40 out/.test(notes), notes)
  check('notes: rows from a newer version and unreadable lines are counted', /1 row written by a newer version/.test(notes) && /1 line could not be read/.test(notes), notes)
  const statuses = await cdp.eval(`[...document.querySelectorAll('#chart-agents tbody tr')].map(r => r.children[0].textContent + ' ' + r.children[3].textContent)`)
  check('a subagent that outlasts its prompt: started in one row, finished in the next', JSON.stringify(statuses) === JSON.stringify(['#2 started, still running', '#3 finished (started earlier)']), JSON.stringify(statuses))
  check('notes: unattributed cost is explained', /Unattributed \(\$0\.010\)/.test(notes), notes)

  const preloaded = await cdp.eval(`document.getElementById('preloaded-note')?.textContent || ''`)
  check('the context window note says what was preloaded', /window size was not recorded/.test(preloaded) || /Preloaded/.test(preloaded), preloaded)
  await cdp.eval(`(() => { const s = document.getElementById('snapshot'); s.value = '0'; s.dispatchEvent(new Event('change')) })()`)
  check('the first snapshot names the preloaded share', /Preloaded before you type .*49k, 4\.9% of the window/.test(await cdp.eval(`document.getElementById('preloaded-note').textContent`)))
  await cdp.eval(`(() => { const s = document.getElementById('snapshot'); s.value = '1'; s.dispatchEvent(new Event('change')) })()`)
  check('a snapshot with no window says so instead of a NaN share', /window size was not recorded/.test(await cdp.eval(`document.getElementById('preloaded-note').textContent`)))
  await noBadNumbers('tokens')

  // Keyboard: one tab stop per chart, arrows between columns, Escape closes.
  await cdp.eval(`document.querySelector('#chart-prompts .legend button:last-child').focus()`)
  await cdp.key('Tab', 'Tab', 9)
  check('Tab reaches the chart as one stop', await cdp.eval(`document.activeElement === document.querySelector('#chart-prompts svg')`))
  const tipText = () => cdp.eval(`document.getElementById('tip').hidden ? '' : document.querySelector('#tip .head').textContent`)
  const last = await tipText()
  await cdp.key('ArrowLeft', 'ArrowLeft', 37)
  const previous = await tipText()
  check('arrow keys move between columns, with a tooltip', last.startsWith('Prompt #4') && previous.startsWith('Prompt #3'), `${last} / ${previous}`)
  await cdp.key('Escape', 'Escape', 27)
  check('Escape closes the tooltip', (await tipText()) === '')
  await cdp.key('Tab', 'Tab', 9)
  check('the next Tab leaves the chart', await cdp.eval(`!document.querySelector('#chart-prompts svg').contains(document.activeElement) && document.activeElement !== document.querySelector('#chart-prompts svg')`))

  // Themes: the page and the tooltip, light and dark.
  const colours = () => cdp.eval(`(() => { const tip = document.getElementById('tip'); tip.hidden = false; const out = [getComputedStyle(document.body).backgroundColor, getComputedStyle(tip).backgroundColor]; tip.hidden = true; return out })()`)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  const light = await colours()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  const dark = await colours()
  const luminance = rgb => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  check('light and dark: page and tooltip backgrounds follow the system', luminance(light[0]) > 200 && luminance(light[1]) > 200 && luminance(dark[0]) < 60 && luminance(dark[1]) < 60, `${light} / ${dark}`)
  await cdp.eval(`document.getElementById('theme').click()`)
  check('the theme button overrides the system (auto → light)', luminance((await colours())[0]) > 200 && (await cdp.eval(`document.documentElement.dataset.theme`)) === 'light')
  await cdp.eval(`document.getElementById('theme').click()`)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  check('… and light → dark', luminance((await colours())[0]) < 60)
  await cdp.eval(`document.getElementById('theme').click()`)

  // Lazy tables, and times in the reader's zone.
  check('the tables are not built until opened', await cdp.eval(`!document.querySelector('#table-prompts table') && !document.querySelector('#table-requests table')`))
  await cdp.eval(`document.getElementById('table-prompts').open = true`)
  await cdp.until(`!!document.querySelector('#table-prompts table')`, 'the prompt table')
  check('opened, the prompt table has a row per prompt', (await cdp.eval(`document.querySelectorAll('#table-prompts tbody tr').length`)) === 4)
  const times = await cdp.eval(`[...document.querySelectorAll('#table-prompts tbody tr')].map(r => r.children[1].textContent)`)
  check('times are shown in the reader’s zone (03:04 UTC is 12:04 in Tokyo)', times[0].includes('12:04'), times[0])
  await cdp.eval(`document.getElementById('table-requests').open = true`)
  await cdp.until(`!!document.querySelector('#table-requests table')`, 'the request table')
  check('the request table tags fast and US-only requests', await cdp.eval(`[...document.querySelectorAll('#table-requests .tag')].map(t => t.textContent).join(',') === 'fast,fast,US-only'`))

  // New tokens first; cache reads have their own view.
  const legendOf = () => cdp.eval(`[...document.querySelectorAll('#chart-prompts .legend button')].map(b => b.textContent).join(',')`)
  check('new tokens first, without cache reads', (await cdp.eval(`document.querySelector('#chart-prompts h2').textContent`)) === 'New tokens per prompt' && !(await legendOf()).includes('Cache read'), await legendOf())
  check('the first tile counts new tokens and names the cache reads beside them', (await cdp.eval(`document.querySelector('#tiles .tile').innerText`)).startsWith('New tokens\n') && (await cdp.eval(`document.querySelector('#tiles .tile .more').textContent`)).startsWith('plus '))
  await cdp.eval(`document.getElementById('unit-cacheRead').click()`)
  check('the cache read view draws cache reads alone (and subagents’)', (await cdp.eval(`document.querySelector('#chart-prompts h2').textContent`)) === 'Cache reads per prompt' && (await legendOf()) === 'Cache read,Subagents', await legendOf())
  // 150,000 a prompt and the subagent's 60,000: 660k.
  check('… and its tile adds up every cache read', (await cdp.eval(`document.querySelector('#tiles .tile .value').textContent`)) === '660k')
  await noBadNumbers('cache reads')

  // Dollars.
  await cdp.eval(`document.getElementById('unit-usd').click()`)
  check('the $ button shows the API list-price equivalent', (await cdp.eval(`document.querySelector('#chart-prompts h2').textContent`)) === 'API list-price equivalent per prompt' && (await cdp.eval(`document.querySelector('#tiles .tile .name').textContent`)) === 'API list-price equivalent')
  await noBadNumbers('dollars')
  await cdp.eval(`document.getElementById('unit-tokens').click()`)

  // Every session, then the one whose data file is missing.
  await visit('#all')
  check('#all opens every session', (await cdp.eval(`document.getElementById('subtitle').textContent`)).startsWith('All sessions (2)'))
  await noBadNumbers('all sessions')
  await visit('#sess-b')
  check('a session whose data file is missing says so', (await cdp.eval(`document.getElementById('empty')?.textContent || ''`)).includes('data/sess-b.js is missing'))

  // A log opened through the file picker.
  await visit('')
  const input = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('file-input')` })
  await cdp.send('DOM.setFileInputFiles', { files: [opened], objectId: input.result.objectId })
  await cdp.until(`document.getElementById('session').value === 'sess-x'`, 'the opened file')
  check('an opened .jsonl file becomes a session of its own', (await cdp.eval(`document.querySelector('#tiles .tile:nth-child(2) .value').textContent`)) === '2')
  const resent = await cdp.eval(`document.getElementById('insights')?.innerText || ''`)
  check('insights: the context re-sent with every request', /re-sends the conversation: 318k input tokens went through a context that peaked at 55k/.test(resent), resent)
  check('insights: none about data the rows do not hold (no snapshot, no subagents)', !/Before the first prompt/.test(resent) && !/Subagents/.test(resent), resent)
  await noBadNumbers('opened file')
} catch (error) {
  check('the checks ran to the end', false, String(error && error.stack ? error.stack : error))
} finally {
  child.kill()
  await sleep(300)
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // The browser may still hold its profile on Windows; the temp folder is cleaned later.
  }
}

console.log(`\n${passes} passed, ${failures} failed (${browser})`)
process.exit(failures === 0 ? 0 : 1)
