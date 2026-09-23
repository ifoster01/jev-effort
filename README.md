# jev-effort

**Does letting Jev choose Claude Code's reasoning effort, step by step, save money? I measured
it on a day of real sessions. It would have saved about 2%.**

> A research project. The code works and the results are reproducible, but it isn't
> recommended as a cost-saving tool. Unofficial; not affiliated with Anthropic or TypeSafe.

> **Correction in progress (0.1.2).** The real-session figures below were inflated by a bug:
> behind the proxy, Claude Code turned off MCP tool search, so every MCP tool definition was
> loaded into every request. That's fixed, and the sessions are being re-measured. A rough
> correction puts Jev's saving at about 4–5% rather than 2%. The benchmark results are
> unaffected.

## Summary

[Jev](https://openrouter.ai/typesafe/jev-1.13) is TypeSafe's small, cheap decision model. After
[Astra-Ares](https://github.com/miuuyy/Astra-Ares) used it to choose GPT-6 Astra's reasoning
effort per step in Codex, several tools appeared doing the same for Claude. The pitch: most
agent steps are routine, so run them at low effort and keep deep reasoning for the hard ones.

I built a proxy that does this for Claude Code without breaking the prompt cache, confirmed it
works, then measured what it saves.

| Test | Result |
| --- | --- |
| Real sessions in shadow mode (310 steps, $86.79) | Jev would lower effort on 86% of steps. Estimated saving: **$1.62 (1.9%)** |
| Where that money went | **91.5%** reading and writing cached context, **4.8%** hidden thinking |
| Controlled benchmark (24 sessions, hidden tests) | Thinking **−46%**, total cost **−1.1%**, every test passed in both arms |

Effort changes how much the model thinks. In long Claude Code sessions the bill is dominated by
the context re-read on every step, which effort doesn't touch.

## Background

- Claude Code runs a whole session at one effort level (`/effort`: low, medium, high, xhigh,
  max).
- Opus 5.5, Fable 5.1, Mythos 5.1, and Opus 5 accept a
  [per-message effort change](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta):
  an effort-only system message inside `messages` that leaves the cached prefix intact. So
  effort can change on every step without re-processing the conversation.
- Research on per-step effort selection ([ARES](https://arxiv.org/abs/2603.07915),
  [TAB](https://arxiv.org/abs/2604.05164)) reports token savings of 35–53%. Both count tokens,
  not dollars. The open question was what per-step effort does to the total cost of real Claude
  Code sessions.

## Method

**1. Mechanism.** `jev-effort` runs `claude` behind a local proxy (`ANTHROPIC_BASE_URL`). Before
each model request it sends Jev a trimmed view of the conversation (prompts, Claude's visible
replies, the last six tool calls) and asks two questions: which effort the next step needs, and
for how many steps to keep it. It applies the answer by appending an effort-only system message,
and re-inserts earlier ones at their original positions so each request begins with the previous
one. Jev may lower effort but never exceed the session's own setting.

**2. Verification.** On a hard counting problem, a `low` marker produced 438–548 output tokens
and `max` produced 1,528–1,809, in line with Claude Code's own `--effort` (438 and 1,733). With
effort alternating on every step, each request read the full previous prefix from cache. Across
the real sessions: 0 unexpected cache misses in 283 checked steps.

**3. Shadow mode on real work.** My normal Claude Code use for one day (September 23, 2026): 6
sessions, 310 model steps, Opus 5.5, Claude Code 2.1.280, sessions at `high` and `max`. For every
step, Jev's choice was logged and nothing was changed. Each request was priced at Claude API list
prices from the usage the API reported: cache reads, cache writes, output, and hidden thinking.

**4. Controlled benchmark.** Six small coding tasks, each with a visible test and hidden checks.
Each task ran from identical files twice, once at fixed `high` and once with Jev choosing (capped
at `high`), for two rounds: 24 headless Claude Code sessions. A warm-up run came first so neither
arm paid to cache the other's system prompt.

## Results

### Where the money went

Opus 5.5 list prices: $0.20 per million tokens read from cache, $8 per million written to the
one-hour cache, $20 per million output tokens. I'm on a subscription, so these are
API-equivalent figures, not a bill.

| Category | Spend | Share |
| --- | ---: | ---: |
| Cache writes | $41.32 | 47.6% |
| Cache reads | $38.08 | 43.9% |
| Hidden thinking | $4.19 | 4.8% |
| Visible output | $3.17 | 3.7% |
| Uncached input | $0.04 | 0.0% |
| **Total** | **$86.79** | |

Sessions averaged 633K tokens of context per step, re-read every time. Thinking was 57% of output
*tokens* but 4.8% of *dollars*.

### What Jev chose

| Effort | Claude Code's setting | Jev's pick |
| --- | ---: | ---: |
| low | 0 | 78 |
| medium | 6 | 99 |
| high | 140 | 115 |
| xhigh | 0 | 0 |
| max | 164 | 18 |

Jev lowered effort on 268 of 310 steps. In `high` sessions it couldn't go higher. In `max`
sessions it could, and mostly didn't: of 164 steps it kept 18 at max, moved 96 to high, and 50 to
medium or low. It never chose xhigh.

### What it would save

| | Amount | Share of spend |
| --- | ---: | ---: |
| Ceiling: all thinking removed on the 267 steps Jev would lower | $3.65 | 4.2% |
| Estimate: at the 46% thinking reduction measured in the benchmark | $1.68 | 1.9% |
| Jev's own cost (1.4M input tokens) | −$0.06 | |
| **Net** | **$1.62** | **1.9%** |

**The break-even is thin.** At 633K tokens of context, one extra step costs about $0.13 to
re-read. The whole net saving equals about 13 extra steps across 267 lowered ones: if lower effort
makes Claude take roughly 5% more steps, it loses money. Shadow mode can't observe that.

**Effort level matters more than Jev.** Thinking's share of each session's spend:

| Session effort | Sessions | Thinking share of spend |
| --- | ---: | ---: |
| high | 4 | 0.9–2.3% |
| max | 2 | 7.3–9.0% |

At `high` there is almost nothing to save. At `max` there is a few percent.

### Controlled benchmark

| | Fixed high | Jev | Change |
| --- | ---: | ---: | ---: |
| Hidden checks passed | 12/12 | 12/12 | |
| Thinking tokens | 1,450 | 787 | −45.7% |
| Output tokens | 20,281 | 20,515 | +1.2% |
| Cost | $1.94 | $1.92 | −1.1% |
| Wall time | 393 s | 417 s | +6% |

Per-task results: [docs/results/](docs/results/2026-09-23-opus-5-5-high.json).

## Interpretation

- **The mechanism works.** Jev roughly halves thinking, the cache survives, and quality held on
  the benchmark.
- **It barely moves cost.** In long, cached sessions, context dominates the bill. The best case is
  `max` sessions, at a few percent.
- **It adds latency.** Jev took 747 ms median and 3.8 s at p95 per decision, with 18 timeouts.
  Applied live, that would have added about 5.5 minutes of waiting to the day.
- **A per-user savings tracker wouldn't be meaningful.** Per-prompt cost had a standard
  deviation of 1.8× its average, so confirming a 2% difference directly would take tens of
  thousands of randomized prompts.
- **The real cost drivers are elsewhere.** Returning to a conversation after the one-hour cache
  expired cost $18.17 (4 times, each re-writing the whole context). Five conversations began with
  281K–500K tokens already in context, costing $16.25. Each is about ten times Jev's total saving.
  Context size is the lever: Opus 5.5 with the 1M window doesn't auto-compact until about 967K
  tokens.

## Limitations

- One developer, one day, six sessions, one model. Short sessions or small repositories could
  show a larger thinking share.
- Dollar figures apply API list prices to subscription usage. How plan limits weigh each token
  type isn't published.
- The shadow-mode estimate borrows the benchmark's 46% thinking reduction. Shadow mode can't
  measure quality or extra steps on real work.
- Behind any proxy, Claude Code drops a few direct-connection features, including claude.ai-backed
  tools such as Artifacts, so each request carried about 4K fewer tokens than a direct session
  would. jev-effort restores tool search, tool streaming, and hint headers
  ([details](docs/usage.md#limitations)).
- The benchmark tasks are small. Two runs per task is enough to see the direction, not a precise
  effect size.

## Notes on Claude Code internals

Found while building this; details and evidence in [docs/how-it-works.md](docs/how-it-works.md).

- Claude Code already sends per-turn effort on a system message right after the prompt (beta
  `per-turn-control-2026-07-01`). The latest effort setting in a request wins, so an injected
  marker must be the last message. Rewriting the top-level `output_config.effort` is silently
  overridden.
- Claude Code re-sends some messages as a plain string after first sending them as text blocks.
  The API caches both the same way, but anything that hashes the history must normalize them.
- Any custom `ANTHROPIC_BASE_URL` makes Claude Code turn off MCP tool search, loading every MCP
  tool definition into every request. With several MCP servers, a fresh session started at
  281K–500K tokens instead of 27K. `ENABLE_TOOL_SEARCH=true` restores it when the proxy forwards
  `tool_reference` blocks.
- Claude Code 2.1.260+ has early-access "function hooks" (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
  A `turn.step` hook can rewrite effort per request, and Claude Code then inserts the same
  cache-safe markers itself.

## Reproduce

```sh
npx jev-effort --jev-shadow          # use like `claude`; logs Jev's choices, changes nothing
npx jev-effort stats                 # where your spend goes and what Jev would save
npx jev-effort stats --share         # the same, safe to paste (no prompts or ids)
npx jev-effort bench --runs 2        # the controlled comparison (uses your Claude usage)
```

Setup, configuration, and privacy details: [docs/usage.md](docs/usage.md). The data behind this
page: [shadow sessions](docs/results/2026-09-23-shadow-sessions.json) and
[benchmark](docs/results/2026-09-23-opus-5-5-high.json). If your numbers look different,
especially with heavy `max` use, please open an issue with `jev-effort stats --share`.

## Related work

| Project | Approach |
| --- | --- |
| [Astra-Ares](https://github.com/miuuyy/Astra-Ares) | The original: Jev picks GPT-6 Astra's effort per step in Codex. jev-effort adapts its Jev prompt wording (MIT) |
| [jev-opus](https://github.com/WXK-AI/jev-opus) | Same proxy approach for Claude Code, plus work-phase adjustments |
| [jev-model-router](https://github.com/moelahmady/jev-model-router) | Claude Code function hooks; effort per prompt, optional model routing |
| [effort-router](https://github.com/handpickedlab/effort-router) | Claude Code plugin; effort per task |
| [ARES](https://arxiv.org/abs/2603.07915), [TAB](https://arxiv.org/abs/2604.05164) | Research on per-step and per-turn reasoning budgets |

None of these, as of September 23, 2026, reports total cost against a fixed-effort baseline.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the Astra-Ares attribution.
