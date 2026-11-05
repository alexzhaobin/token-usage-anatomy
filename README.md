# Token Usage Anatomy

A Claude Code mod that shows how every prompt turns into input, output, cache-read and cache-write tokens, so you can get better results with fewer tokens.

**No network, no telemetry.** The mod never sends anything anywhere. Everything it records stays in a folder on your machine.

> **Status: in development, not yet released.** This branch is being built milestone by milestone. It now records every prompt to a log folder; the chart above the prompt and the viewer page come next. The full README (install steps, configuration, every file in detail) arrives before v0.1.0.

## What it reads, writes and runs (so far)

- **Reads** Claude Code's session transcripts under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`), only the token counts of each model response and the session title. Tool results are counted by size, never stored.
- **Writes** only inside its log folder, `~/.claude/token-usage-anatomy/` by default: one `<session>.jsonl` per session (split into `<session>.2.jsonl`, … every 2 MiB), a copy of each under `data/` for the viewer, `usage-index.js` and `pricing.js`. Prompt text is **not** stored unless you turn on `includePromptText`.
- **Runs** `scripts/io.sh` (macOS, Linux) or `scripts/io.ps1` (Windows, via PowerShell) to append to the log and to read transcripts larger than 4 MiB. Paths are passed as arguments, never pasted into a command.

## What it will do

- Record one row per prompt (and optionally per model request) with token counts by type: uncached input, cache reads, cache writes (5-minute and 1-hour), thinking and answer output, plus subagents.
- Draw a chart above the prompt box, and install `viewer.html`, a self-contained page for the full history that works offline from disk.
- Show dollar figures as an **API list-price equivalent** from a dated price table (`hooks/prices.ts`), since most people use Claude Code on a subscription.

## Development

```sh
claude plugin validate --strict .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
