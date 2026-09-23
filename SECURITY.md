# Security and privacy

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability)
rather than a public issue.

## What jev-effort handles

- **Your Claude credentials** pass through the local proxy exactly as Claude Code sends them,
  on to `api.anthropic.com` (or your `ANTHROPIC_BASE_URL`). They are never stored or logged.
- **The proxy listens on 127.0.0.1 only**, on a random port, for the lifetime of the Claude
  Code session. It adds no credentials of its own to Claude API requests, so another local
  process can't use it to act as you.
- **Your Jev key** is stored in `~/.config/jev-effort/config.json` with mode 0600 (or read
  from a file or environment variable you choose). It is only sent to the Jev route you
  configured.
- **Jev receives conversation excerpts**: prompts, Claude's visible replies, and trimmed tool
  output, which can include source code. See docs/how-it-works.md for exact limits.
- **Local logs** (`~/.local/share/jev-effort/logs`) contain token counts, effort choices,
  timings, model names, and Claude Code session ids. They never contain prompt or code text.
- **Local state** (`~/.local/share/jev-effort/state`) contains message hashes and effort
  names only, and is pruned after 14 days.
- `JEV_EFFORT_DUMP_DIR` (off by default) writes full request bodies for debugging. Don't
  share those files.

No telemetry is collected. `jev-effort stats --share` prints aggregates you can choose to paste.
