#!/usr/bin/env node
// Runs the transcript helpers (scripts/io.sh, scripts/io.ps1) on the test
// fixture and checks they print exactly what the hooks module expects, so
// the reader behaves the same on macOS, Linux and Windows.
//
//   node --experimental-strip-types --no-warnings scripts/check-reader.mjs
//
// io.sh runs wherever `sh` exists; io.ps1 runs on Windows (powershell.exe)
// and wherever PowerShell 7 (`pwsh`) is installed. No npm dependencies.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REDUCED, TRANSCRIPT, TRANSCRIPT_LINES } from '../tests/fixtures/transcript.ts'

const scripts = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'tua-reader-'))
const transcript = join(work, 'session.jsonl')
writeFileSync(transcript, TRANSCRIPT)

const has = command => spawnSync(command, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
const hasPwsh = command => spawnSync(command, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0

const runners = []

if (process.platform !== 'win32' && has('sh')) {
  runners.push({ name: 'io.sh', argv: ['sh', join(scripts, 'io.sh')] })
}

for (const shell of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
  if (hasPwsh(shell)) {
    const argv = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'io.ps1')]
    runners.push({ name: `io.ps1 (${shell})`, argv })
  }
}

let failures = 0

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`ok   ${label}`)

    return
  }

  failures += 1
  console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
}

function run(runner, args, input) {
  const [command, ...rest] = runner.argv
  const result = spawnSync(command, [...rest, ...args], { input, encoding: 'utf8' })

  if (result.status !== 0) {
    return `exit ${result.status}: ${result.stderr}`
  }

  return result.stdout.replace(/\r\n/g, '\n')
}

const byteLength = text => Buffer.byteLength(text, 'utf8')
const titleLines = TRANSCRIPT_LINES.filter(line => /^\{"type":"(ai-title|custom-title)"/.test(line))

if (runners.length === 0) {
  console.log('FAIL no helper could be run here (neither sh nor PowerShell)')
  process.exit(1)
}

for (const runner of runners) {
  check(`${runner.name} assistant from 0`, run(runner, ['assistant', transcript, '0']), `${REDUCED}\n`)

  // From the start of the third line: the first two lines are skipped.
  const offset = byteLength(TRANSCRIPT_LINES.slice(0, 2).join('\n') + '\n')
  check(`${runner.name} assistant from an offset`, run(runner, ['assistant', transcript, String(offset)]), `${REDUCED}\n`)

  const pastReqA = byteLength(TRANSCRIPT_LINES.slice(0, 4).join('\n') + '\n')
  check(
    `${runner.name} assistant past the first response`,
    run(runner, ['assistant', transcript, String(pastReqA)]),
    REDUCED.split('\n').slice(2).join('\n') + '\n',
  )

  check(`${runner.name} titles`, run(runner, ['titles', transcript]), titleLines.join('\n') + '\n')

  // Appending creates the folder, keeps what is there, and is byte-exact.
  const log = join(work, runner.name.replace(/\W+/g, '-'), 'nested', 'log.jsonl')
  const first = '{"kind":"prompt","text":"café \u2028 </script>"}\n'
  const second = '{"kind":"prompt","n":2}\n'
  run(runner, ['append', log], first)
  run(runner, ['append', log], second)
  check(`${runner.name} append`, readFileSync(log, 'utf8'), first + second)
}

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? `\nall ${runners.length} helper(s) agree` : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
