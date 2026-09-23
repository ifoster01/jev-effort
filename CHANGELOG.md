# Changelog

## 0.1.0 (unreleased)

First release.

- `jev-effort [claude args]` runs Claude Code through a local proxy that applies Jev's
  per-step effort without invalidating the prompt cache.
- `--jev-shadow` records Jev's picks without changing anything.
- `setup`, `stats` (with `--share`), `bench` (six tasks with hidden checks), `doctor`, `serve`.
- Effort is capped at your `/effort` setting by default.
- Verified with Claude Code 2.1.280 on Opus 5.5.
