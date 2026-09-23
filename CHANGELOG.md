# Changelog

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
