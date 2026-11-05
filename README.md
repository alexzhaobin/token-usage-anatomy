# Token Usage Anatomy

A Claude Code mod that shows how every prompt turns into input, output, cache-read and cache-write tokens, so you can get better results with fewer tokens.

**No network, no telemetry.** The mod never sends anything anywhere. Everything it records stays in a folder on your machine.

> **Status: in development, not yet released.** This branch is being built milestone by milestone. Right now it contains the price table and the cost maths with their tests; the hooks module registers nothing yet, so installing it changes nothing in a session. The full README (what it reads, writes and runs, install steps, configuration) arrives before v0.1.0.

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
