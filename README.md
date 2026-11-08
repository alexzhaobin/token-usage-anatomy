# Token Usage Anatomy

A Claude Code mod that shows how every prompt turns into input, output, cache-read and cache-write tokens, so you can get better results with fewer tokens.

**No network, no telemetry.** The mod never sends anything anywhere. Everything it records stays in a folder on your machine.

> **Status: in development, not yet released.** This branch is being built milestone by milestone. It records every prompt to a log folder, draws the token chart above the prompt and installs the viewer page. The full README (install steps, configuration, every file in detail) arrives before v0.1.0.

## The chart and /token-anatomy

Above the prompt box (terminal and desktop app) a bar per prompt shows the **new tokens** it took, by type: uncached input, cache writes, thinking and answer, plus subagents. Cache reads, the context re-sent with every model request, have a view of their own (they are usually most of the count, at a tenth of the input price), and a third view shows the API list-price equivalent in dollars. The title line counts down until the prompt cache goes cold. Under each bar is the number of model requests the prompt took, and below the chart the context window as it stands now. Every request re-sends the whole context, so one prompt's bar is often many times the context's size.

- `/token-anatomy` toggles the chart; `show` and `hide` set it.
- `/token-anatomy open` prints the link to `viewer.html`.
- In VS Code and the mobile apps, which draw no band, `show` opens the chart in a pane.

## The viewer page

`viewer.html` sits in the log folder and opens from disk in any browser, offline. It reads the folder's `data/*.js` copies of the logs (a page opened from disk cannot read `.jsonl` files itself), or any `.jsonl` logs you open or drop on it.

- Totals, then **What stands out**: plain-language findings computed from your rows, such as a cold cache and what writing it again cost, one prompt doing most of the work, or tool results filling the context. A finding appears only when the rows support it.
- New tokens per prompt by type, the running total, each type on its own scale, the context size at every model request, what fills the context window, tool results, subagents and the cache hit rate. Buttons switch every chart to cache reads alone or to the API list-price equivalent.
- Every prompt and every model request in tables, and notes on how each figure was measured or estimated.
- Charts work from the keyboard (one Tab stop each, arrow keys between columns, Escape closes the tooltip) and follow your light or dark theme.

## What it reads, writes and runs (so far)

- **Reads** Claude Code's session transcripts under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`), only the token counts of each model response and the session title. Tool results are counted by size, never stored.
- **Writes** only inside its log folder, `~/.claude/token-usage-anatomy/` by default: one `<session>.jsonl` per session (split into `<session>.2.jsonl`, … every 2 MiB), a copy of each under `data/` for the viewer, `usage-index.js`, `pricing.js` and `viewer.html` (copied from `assets/` when a session starts). Prompt text is **not** stored unless you turn on `includePromptText`.
- **Runs** `scripts/io.sh` (macOS, Linux) or `scripts/io.ps1` (Windows, via PowerShell) to append to the log and to read transcripts larger than 4 MiB. Paths are passed as arguments, never pasted into a command.
- **Reads your theme** for the chart's colours: the `theme` setting, a custom theme's file under `~/.claude/themes/`, and for the `auto` theme the `COLORFGBG` variable, then `defaults read -g AppleInterfaceStyle` (macOS), `gsettings get org.gnome.desktop.interface color-scheme` (GNOME) or `reg query …\Personalize /v AppsUseLightTheme` (Windows).

## What it will do

- Record one row per prompt (and optionally per model request) with token counts by type: uncached input, cache reads, cache writes (5-minute and 1-hour), thinking and answer output, plus subagents.
- Show dollar figures as an **API list-price equivalent** from a dated price table (`hooks/prices.ts`), since most people use Claude Code on a subscription.

## Development

```sh
claude plugin validate --strict .
claude plugin test .
node --experimental-strip-types --no-warnings scripts/check-viewer.mjs   # needs Chrome, Chromium or Edge
```

## License

MIT, see [LICENSE](LICENSE).
