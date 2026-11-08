# Contributing

Thank you for helping. This mod runs inside other people's Claude Code sessions, so the bar is: it never breaks a session, never sends anything anywhere, and every number it shows can be traced to a recorded row.

## Run it from your clone

```sh
claude --plugin-dir /path/to/token-usage-anatomy
```

That loads your working copy for one session, and its hooks reload when you save. If you also have the mod installed, disable that copy first (`claude plugin disable token-usage-anatomy@hookworks`) so the two do not both record. Your working copy logs to the same folder an installed copy uses, so set `logDir` to a scratch folder if you want to keep your own history apart.

## Checks

Everything CI runs, from the repository root. You need Claude Code, Node 22.6 or later, and Chrome, Chromium or Edge for the viewer check. There is nothing to install: the mod has no dependencies, and the scripts use none.

```sh
claude plugin validate --strict .                                         # manifest, hooks module, state contract
claude plugin test .                                                       # unit tests in tests/*.test.ts(x)
node scripts/check-files.mjs                                               # the plugin directory's file rules
node --experimental-strip-types --no-warnings scripts/check-reader.mjs     # io.sh and io.ps1 read transcripts alike
node --experimental-strip-types --no-warnings scripts/check-viewer.mjs     # viewer.html in headless Chrome
```

Set `CHROME` to a browser's path if the viewer check cannot find one. CI runs all five on Ubuntu, macOS and Windows; please run at least the first three before opening a pull request.

Read what `validate` prints under `hooks:` and `calls:`. A new hook, `$` call, environment variable or command should be one you meant, and the README's "What it reads, writes and runs" section should say so.

## How the code is laid out

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks module: every hook, the band's state atoms, and the one place `$` is used. It hands the rest of the code small "ports" built from `$`, because `$` may not be passed around |
| `hooks/recorder.ts` | What happens over a session: turns, steps, tools, subagents, compaction, and writing each prompt's rows |
| `hooks/transcript.ts`, `hooks/io.ts` | Reading the transcript, directly or through `scripts/io.sh` / `scripts/io.ps1` past 4 MiB |
| `hooks/steps.ts`, `hooks/subagents.ts`, `hooks/rows.ts` | Pricing each request and building the log rows |
| `hooks/prices.ts`, `hooks/pricing.ts` | The dated price table (data only) and the arithmetic over it |
| `hooks/logbook.ts` | The log folder: appending, segments, the viewer's data copies, the index |
| `hooks/band.tsx`, `hooks/format.ts`, `hooks/theme.ts` | The chart above the prompt |
| `assets/viewer.html` | The viewer page: one file, no libraries |
| `types/index.d.ts` | The state contract `validate` holds the module to |

### Rules the code keeps

- **Every hook catches its own errors.** Wrap new work in `try`/`catch` (or `.catch(($, e, next) => next(e))` on a gating hook) and log failures with `$.ui.log(..., { to: 'debug' })`. A failure in the mod must never reach the session.
- **No network, no telemetry**, and no writes outside the log folder.
- **Privacy**: tool results are measured, never stored. Prompt text is written only when `includePromptText` is on.
- **No runtime dependencies**, no lockfile, readable unminified source, PNG for images. `scripts/check-files.mjs` enforces the plugin directory's rules.
- **Cross-platform**: anything that touches paths or runs a process works on macOS, Linux and Windows. Pass paths as arguments, never inside a command string.
- **Logged text is data.** Anything written into `data/*.js` goes through `scriptString`; the viewer sets logged text with `textContent`, never as markup.

## The log format contract

Every row carries `"schema": "token-usage-anatomy/1"`. People keep their logs for a long time, and the viewer must read all of them.

- **Additive changes keep `/1`**: a new field, a new row `kind`, a new value in an open set. Readers ignore what they do not know, so old viewers keep working. Older rows lack the new field, so code that reads it must handle its absence; if zero would mislead, show nothing instead.
- **A breaking change bumps to `/2`**: renaming or removing a field, changing a field's meaning or unit. The viewer must then read both `/1` and `/2` (it already counts and skips rows of a major version it does not know).
- Field names and meanings are documented where rows are built, in `hooks/rows.ts`. Add a test in `tests/rows.test.ts` for any new field, and a fixture row in `scripts/check-viewer.mjs` if the viewer shows it.

The names in this table never change after v0.1.0: the plugin name `token-usage-anatomy`, the command `/token-anatomy`, the state and store namespace `token-usage-anatomy`, the default folder `~/.claude/token-usage-anatomy/`, and `viewer.html`.

## Updating prices

`hooks/prices.ts` is data copied from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing). To update it, change the numbers and `asOf` together, run the tests (`tests/pricing.test.ts` works examples for standard, fast, US-only and long-prompt rates), and add a line to `CHANGELOG.md`. Never estimate a price; leave a model out until the page lists it.

## Proposing a change

1. Open an issue first for anything beyond a small fix, saying what you want to see and why. For a new chart or insight, say which recorded fields it is computed from. Insights are shown only when the rows support them.
2. Branch from `dev` and open the pull request against `dev`. `main` holds releases only.
3. Keep the pull request to one change, with tests, and note it under "Unreleased" in `CHANGELOG.md`.
4. Make sure CI passes.

## Releasing (maintainers)

1. Move "Unreleased" in `CHANGELOG.md` under the new version and bump `version` in `.claude-plugin/plugin.json` (SemVer).
2. Merge `dev` into `main`.
3. On `main`: `claude plugin tag --push` creates and pushes the `token-usage-anatomy--v<version>` tag.
4. Update the entry in the `hookworks` marketplace repository.
