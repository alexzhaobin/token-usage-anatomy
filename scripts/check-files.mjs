#!/usr/bin/env node
// Checks the repository against the Anthropic plugin directory's file
// rules, so a change that would be held at submission fails here first:
//
//   - at most 512 files, every non-image file under 256 KiB
//   - no lockfile, no runtime dependencies, no marketplace.json
//   - no .DS_Store, Thumbs.db, symlinks, submodules or Git LFS
//   - no binaries but PNG images (no .ico)
//   - readable, unminified source
//   - a README.md of 40 words or more, and a LICENSE
//
//   node scripts/check-files.mjs
//
// It looks at what Git would ship: tracked files plus new ones not ignored.
// No npm dependencies.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const MAX_FILES = 512
const MAX_BYTES = 256 * 1024
const MAX_LINE = 2000
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock'])
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const IMAGES = new Set(['.png'])
const CODE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.html', '.css', '.sh', '.ps1'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const problems = []
const fail = (file, why) => problems.push(`${file}: ${why}`)

// What Git would ship, with each tracked file's mode (symlinks, submodules).
const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
const modes = new Map(
  git('ls-files', '--stage', '-z')
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const [meta, path] = line.split('\t')
      return [path, meta.split(' ')[0]]
    }),
)
const present = [...new Set(files)].filter(file => modes.has(file) || existsSync(join(root, file)))

if (present.length > MAX_FILES) fail('(repository)', `${present.length} files; the directory takes at most ${MAX_FILES}`)
if (existsSync(join(root, '.gitmodules'))) fail('.gitmodules', 'submodules are not allowed')

for (const file of present) {
  const name = basename(file)
  const extension = extname(file).toLowerCase()
  const mode = modes.get(file)
  const path = join(root, file)

  if (mode === '160000') {
    fail(file, 'a submodule')
    continue
  }
  if (mode === '120000' || (existsSync(path) && lstatSync(path).isSymbolicLink())) {
    fail(file, 'a symlink')
    continue
  }
  if (!existsSync(path)) continue

  if (JUNK.has(name)) fail(file, 'an operating system file; delete it and keep it in .gitignore')
  if (LOCKFILES.has(name)) fail(file, 'a lockfile; a plugin that installs from one is held for review')
  if (name === 'marketplace.json') fail(file, 'the marketplace catalog lives in its own repository')
  if (extension === '.ico') fail(file, 'an .ico image; use PNG')

  const bytes = readFileSync(path)
  const isBinary = bytes.subarray(0, 8000).includes(0)

  if (IMAGES.has(extension)) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail(file, 'named .png but not a PNG image')
    continue
  }
  if (isBinary) {
    fail(file, 'a binary file; only PNG images may be binary')
    continue
  }
  if (bytes.length >= MAX_BYTES) fail(file, `${(bytes.length / 1024).toFixed(1)} KiB; files must be under 256 KiB`)

  const text = bytes.toString('utf8')
  if (name === '.gitattributes' && /filter=lfs/.test(text)) fail(file, 'Git LFS is not allowed')
  if (name === 'package.json') {
    try {
      const manifest = JSON.parse(text)
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
        if (manifest[field] && Object.keys(manifest[field]).length > 0) fail(file, `${field}: the mod has no runtime dependencies`)
      }
    } catch {
      fail(file, 'not valid JSON')
    }
  }
  if (CODE.has(extension)) {
    const lines = text.split('\n')
    const long = lines.findIndex(line => line.length > MAX_LINE)
    if (long >= 0) fail(file, `line ${long + 1} is ${lines[long].length} characters; minified code is not accepted`)
  }
}

const readme = join(root, 'README.md')
if (!existsSync(readme)) fail('README.md', 'missing')
else {
  const words = readFileSync(readme, 'utf8').split(/\s+/).filter(word => /\w/.test(word)).length
  if (words < 40) fail('README.md', `${words} ${words === 1 ? 'word' : 'words'}; the directory asks for 40 or more`)
}
if (!['LICENSE', 'LICENSE.md', 'LICENSE.txt'].some(name => existsSync(join(root, name)))) fail('LICENSE', 'missing')

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) with the plugin directory's file rules:\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const largest = present
  .filter(file => existsSync(join(root, file)) && !IMAGES.has(extname(file).toLowerCase()))
  .map(file => ({ file, size: readFileSync(join(root, file)).length }))
  .sort((a, b) => b.size - a.size)[0]
console.log(`ok: ${present.length} files (at most ${MAX_FILES}); largest non-image ${largest ? `${largest.file}, ${(largest.size / 1024).toFixed(1)} KiB` : 'none'} (under 256 KiB); no lockfile, symlink, submodule, LFS or binary but PNG; README and LICENSE present`)
