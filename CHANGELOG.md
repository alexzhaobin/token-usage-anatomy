# Changelog

All notable changes to this mod are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-09

The first release.

### Added

- Records every prompt to a JSONL log in `~/.claude/token-usage-anatomy/` (schema `token-usage-anatomy/1`): tokens by type (uncached input, cache reads, 5-minute and 1-hour cache writes, thinking, answer), requests, context per request, tools by size, subagents, context snapshots and compactions. Optional rows per model request (`recordRequests`) and prompt text (`includePromptText`), both off by default.
- Tokens read from the session transcript, so thinking tokens, the cache write split, fast mode and US-only inference are counted; each streamed request is counted once.
- The API list-price equivalent from a dated price table (prices as of 2026-11-05), compared with Claude Code's own cost count each prompt; any shortfall shown as "unattributed".
- A chart above the prompt in three views (new tokens, cache reads, API list-price equivalent), with the request count under each bar, the context window now, what was preloaded, and a countdown to a cold cache. Light and dark themes.
- `/token-anatomy [show|hide|open]`; in VS Code and the mobile apps, `show` opens the chart in a pane.
- `viewer.html`: a self-contained, offline page for the whole history, with findings computed from the rows, charts that work from the keyboard, and prompt and request tables.
- Subagents counted per prompt, including runs that start in one prompt and finish in a later one (`starts` and `runs`, shown as a status in the viewer).
- macOS, Linux and Windows support: transcripts past 4 MiB and log appends go through `scripts/io.sh` or `scripts/io.ps1`.
- CI on Ubuntu, macOS and Windows: strict validation, unit tests, the plugin directory's file rules, both transcript readers, and the viewer in headless Chrome.

[Unreleased]: https://github.com/alexzhaobin/token-usage-anatomy/compare/token-usage-anatomy--v0.1.0...HEAD
[0.1.0]: https://github.com/alexzhaobin/token-usage-anatomy/releases/tag/token-usage-anatomy--v0.1.0
