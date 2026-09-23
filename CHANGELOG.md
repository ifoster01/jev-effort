# Changelog

## 0.1.2

- **Fix: MCP tool search was off in sessions launched through jev-effort.** Claude Code disables
  tool search behind any custom `ANTHROPIC_BASE_URL`, so every MCP tool definition was loaded
  into every request (a fresh session started at 281K–500K tokens instead of 27K). jev-effort
  now sets `ENABLE_TOOL_SEARCH=true` and `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` when
  forwarding to the Claude API directly, unless you've set them; `serve` prints them and
  `doctor` checks them.
- Also restores Claude Code's request-class hint headers behind the proxy
  (`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`), and uses them: compaction and side requests (titles,
  classifiers) no longer consult Jev or count as steps, and still keep the cached prefix.
- Documents the direct-connection features Claude Code turns off behind any proxy that can't be
  restored: Remote Control, server-managed settings, claude.ai-backed tools. `doctor` warns.
- README rewritten as a research write-up: question, method, results, and limitations from
  a day of real sessions and the benchmark. Tool documentation moved to docs/usage.md.
- docs/results/2026-09-23-shadow-sessions.json: the anonymized aggregate behind the README.

- README: Related work (similar tools, research, Claude Code's own options).
- docs/how-it-works.md: tested Claude Code's early-access function hooks as a native
  alternative to the proxy (effort honored, cache preserved).

## 0.1.1

`jev-effort stats` now answers "would this save me money?" directly:

- **Where the money goes**: spend by cache writes, cache reads, visible output, thinking, and
  uncached input, at Claude API list prices (API-equivalent on a subscription).
- **What Jev could save**, from shadow steps: a ceiling (all thinking on steps Jev would lower),
  an estimate at the 46% thinking cut measured by `bench`, Jev's own cost, and the net.
- **What one extra step costs** at your average context, and how many extra steps the net
  saving is worth.
- **Per-session breakdown**: effort, steps, context size, spend, thinking share, Jev's lowering rate.
- **Latency** that apply mode added, or would add to shadow sessions.
- Rate-limit and overload responses are reported separately from real problems.
- Logs now record whether cache writes used the 1-hour or 5-minute lifetime, so costs are
  exact. Older log lines are priced as 1-hour writes and flagged.

## 0.1.0

First release.

- `jev-effort [claude args]` runs Claude Code through a local proxy that applies Jev's
  per-step effort without invalidating the prompt cache.
- `--jev-shadow` records Jev's picks without changing anything.
- `setup`, `stats` (with `--share`), `bench` (six tasks with hidden checks), `doctor`, `serve`.
- Effort is capped at your `/effort` setting by default.
- Verified with Claude Code 2.1.280 on Opus 5.5.
