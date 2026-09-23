# jev-effort

**Per-step reasoning effort for Claude Code, without breaking the prompt cache.**

Claude Code runs a whole session at one effort level, but most steps (reading a file, running
a test, applying an edit already decided) don't need deep reasoning. jev-effort asks
[Jev](https://openrouter.ai/typesafe/jev-1.13), a small, cheap decision model, which effort each
step needs, and applies it in a way that keeps Claude Code's prompt cache intact.

> Unofficial. Not affiliated with Anthropic or TypeSafe. Idea from
> [Astra-Ares](https://github.com/miuuyy/Astra-Ares), which does the same for Codex.

```sh
npx jev-effort
```

That's the whole setup: the first run asks for a Jev key, then starts Claude Code. Use it
exactly like `claude`: `jev-effort --resume`, `jev-effort -p "…"`, and so on.

**Will it save you money?** It depends on how much Claude thinks in your sessions. On a small
benchmark it cut hidden thinking by 46% but total cost by only about 1%; see
[Results](#results). Shadow mode measures your own sessions without changing anything.

## Try it without risk first

```sh
npx jev-effort --jev-shadow     # Jev picks are logged, nothing about your session changes
npx jev-effort stats            # what Jev would have done
```

Shadow mode never delays or modifies a request: Jev runs alongside it. When you're
comfortable, drop `--jev-shadow`.

## Results

### Your sessions (shadow mode)

<!-- TODO(maintainer): fill in from `jev-effort stats --share` after running shadow mode on real work. -->
_Coming soon: numbers from real day-to-day sessions._ The number to watch in
`jev-effort stats` is the **hidden thinking share** of output tokens: effort mostly changes
thinking, so that share is the ceiling on what jev-effort can save you.

### Controlled benchmark

`jev-effort bench --runs 2`: six small coding tasks, each run from the same files at a fixed
`high` effort and with Jev choosing per step (capped at `high`). Hidden checks decide pass/fail.
Opus 5.5, Claude Code 2.1.280, 2026-09-23. Raw data:
[docs/results/](docs/results/2026-09-23-opus-5-5-high.json).

| Task | Pass (fixed / Jev) | Cost (fixed / Jev) | Output tokens (fixed / Jev) | Thinking tokens (fixed / Jev) | Jev's effort mix |
| --- | --- | --- | --- | --- | --- |
| expr-eval | 2/2 / 2/2 | $0.428 / $0.430 | 6706 / 6947 | 796 / 458 | low 5, medium 6 |
| interval-merge | 2/2 / 2/2 | $0.253 / $0.265 | 1950 / 2096 | 112 / 39 | low 4, medium 4 |
| lru-cache | 2/2 / 2/2 | $0.245 / $0.277 | 1884 / 2390 | 100 / 0 | low 3, medium 5 |
| paginate-bug | 2/2 / 2/2 | $0.330 / $0.290 | 3521 / 3000 | 121 / 35 | low 2, medium 6 |
| rename-refactor | 2/2 / 2/2 | $0.373 / $0.363 | 3806 / 3825 | 241 / 255 | low 10, high 2 |
| stats-bugs | 2/2 / 2/2 | $0.311 / $0.293 | 2414 / 2257 | 80 / 0 | low 7, medium 2 |
| **Total** | 12/12 / 12/12 | $1.941 / $1.918 (−1.1%) | 20,281 / 20,515 (+1.2%) | 1,450 / 787 (−45.7%) | 55 Jev calls |

What this shows:

- **The mechanism works.** Jev lowered effort on most steps, hidden thinking fell 46%, every
  run still passed its hidden checks, and the prompt cache kept hitting.
- **On these tasks it saved nothing.** Opus 5.5 at `high` spends only about 7% of its output
  on thinking for small, well-specified tasks, so cutting thinking barely moves the total.
  Total output and cost changed by about 1%, within run-to-run noise. Wall time was 6% longer
  (about 300 ms per Jev call).
- **Where it could matter:** sessions where Claude thinks a lot (hard debugging, design work,
  `xhigh`/`max` sessions) with many routine steps in between. Shadow mode tells you whether
  your sessions look like that before you change anything.

## Requirements

- **Node 20+** and **Claude Code** (verified with 2.1.280).
- **Model: Opus 5.5** (verified). Fable 5.1, Mythos 5.1, and Opus 5 support per-message effort
  according to Anthropic's docs but haven't been verified here. Other models pass through
  untouched.
- **Claude API key or Claude subscription.** On Bedrock, Google Cloud, or Foundry,
  jev-effort steps aside and runs plain `claude`.
- **A Jev key**, from any of: [OpenRouter](https://openrouter.ai/settings/keys) (`sk-or-…`),
  [TypeSafe](https://console.typesafe.ai), or Vercel AI Gateway (`vck_…`). OpenRouter lists
  Jev at $0.042 per million input tokens with free output; a decision uses 1-3K tokens.

## How it works

```
claude ──► jev-effort proxy (127.0.0.1) ──► api.anthropic.com
                   │
                   └──► Jev: "which effort does the next step need, and for how long?"
```

- `jev-effort` runs `claude` with `ANTHROPIC_BASE_URL` pointed at a private local proxy for
  that session only. Your `claude` command and settings aren't changed.
- Before each main-model step, Jev gets a trimmed view of the conversation and picks an
  effort plus a lease (how many steps to keep it). No Jev call during a lease.
- The effort is applied with an effort-only system message appended to the request, using
  Anthropic's [per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta)
  beta. Earlier markers are re-inserted exactly where they were, so every request starts
  with the previous one and the cache keeps hitting.
- **By default Jev can only lower effort**, never above your `/effort` setting. Allow raising
  with `--jev-ceiling max`.
- **Everything fails open.** If Jev is slow or down, or anything goes wrong, the request goes
  out exactly as Claude Code built it.

Details and measurements: [docs/how-it-works.md](docs/how-it-works.md).

## Commands

| Command | What it does |
| --- | --- |
| `jev-effort [claude args]` | Run Claude Code with per-step effort |
| `jev-effort --jev-shadow [claude args]` | Log Jev's picks without applying them |
| `jev-effort stats [--since 7d] [--share] [--json]` | Effort mix, Jev latency, cache health; `--share` prints a paste-safe summary |
| `jev-effort bench [--tasks a,b] [--runs N] [--effort high]` | Controlled comparison: fixed effort vs Jev on six coding tasks with hidden checks |
| `jev-effort doctor [--probe]` | Check the setup and explain what will happen |
| `jev-effort setup [--key-file path \| --key-stdin] [--provider p] [--mode m]` | Add or replace the Jev key and defaults |
| `jev-effort serve [--port 8787]` | Standalone proxy, for tools that launch Claude Code themselves |

Options for a Claude Code run all start with `--jev-` (everything else goes to `claude`):
`--jev-shadow`, `--jev-mode apply|shadow|off`, `--jev-floor <effort>`,
`--jev-ceiling <effort|session>`, `--jev-quiet`.

To use it everywhere: `npm install -g jev-effort`, then optionally `alias claude=jev-effort`
in your shell profile (jev-effort itself still finds the real `claude`).

## Configuration

`~/.config/jev-effort/config.json` (written by `jev-effort setup`, mode 0600):

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `apply` | `apply`, `shadow`, or `off` |
| `floor` | `low` | Lowest effort Jev may choose |
| `ceiling` | `session` | Highest; `session` means your `/effort` setting |
| `provider` | `auto` | `openrouter`, `typesafe`, `vercel`; `auto` guesses from the key |
| `apiKey` / `apiKeyFile` / `apiKeyEnv` | | Where the Jev key comes from |
| `maxLeaseSteps` | `10` | Longest lease Jev may grant (1, 2, 5, or 10) |
| `jevTimeoutMs` | `5000` | Give up on Jev after this long and use your effort |
| `claudePath` | `claude` | The Claude Code executable |

Environment: `JEV_API_KEY` (or `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`),
`JEV_EFFORT_MODE`, `JEV_EFFORT_CONFIG_DIR`, `JEV_EFFORT_DATA_DIR`.

## Privacy

- **Jev sees** your prompts, Claude's visible replies, and the last six tool calls with trimmed
  output (about 1,000 tokens each), which can include code. Only while jev-effort is running.
- **Your Claude credentials** pass through the local proxy untouched and are never stored.
- **Local logs** hold counts, effort choices, timings, and session ids, never prompt or code
  text. `stats --share` output has no ids.
- No telemetry. See [SECURITY.md](SECURITY.md).

## Limitations

- It depends on how Claude Code builds requests, which isn't a public interface. A Claude
  Code update could change it; `jev-effort doctor` warns on newer versions, and
  `jev-effort stats` reports rejected rewrites and unexpected cache misses.
- Each Jev call adds about 300 ms before a step (none during leases or in shadow mode).
- Corporate HTTPS proxies (`HTTPS_PROXY`) aren't supported yet; jev-effort runs plain `claude`.
- IDE extensions and the desktop app launch Claude Code themselves; use `jev-effort serve` and
  set `ANTHROPIC_BASE_URL` where they allow it.
- Windows is untested.

## Uninstall

```sh
npm uninstall -g jev-effort
rm -rf ~/.config/jev-effort ~/.local/share/jev-effort
```

## Contributing

Real-world numbers are the most useful thing right now: run shadow mode for a few days and
open a "Share results" issue with `jev-effort stats --share`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

MIT license. Jev question wording adapted from Astra-Ares (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
