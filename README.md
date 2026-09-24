# jev-effort

**Does letting Jev choose Claude Code's reasoning effort, step by step, save money? At `high`
effort, barely: about 1%. At `max` effort, it cut the cost of a coding benchmark by 55% with every
test still passing. In a long real session at `max`, the estimated saving was 4–9%, because
re-reading the conversation's context is most of the bill.**

> A research project. The code works and the results are reproducible. Unofficial; not affiliated
> with Anthropic or TypeSafe.

## Summary

[Jev](https://openrouter.ai/typesafe/jev-1.13) is TypeSafe's small, cheap decision model. After
[Astra-Ares](https://github.com/miuuyy/Astra-Ares) used it to choose GPT-6 Astra's reasoning
effort per step in Codex, several tools appeared doing the same for Claude. The pitch: most agent
steps are routine, so run them at low effort and keep deep reasoning for the hard ones.

I built a proxy that does this for Claude Code without breaking the prompt cache, confirmed it
works, then measured what it saves.

| Test | Result |
| --- | --- |
| Benchmark at `high` (24 sessions, hidden tests) | Cost **−1.1%**, thinking −46%, every test passed in both arms |
| Benchmark at `max` (24 sessions, hidden tests) | Cost **−55%**, thinking −98.5%, wall time −58%, every test passed in both arms |
| Real session at `max`, shadow mode (470 steps, 92 min) | Estimated saving **4–9%**. Cached context was 82% of spend, thinking 9.5% |

Effort changes how much the model thinks, and the saving follows thinking's share of the bill.
At `high`, Claude Opus 5.5 thinks little on routine steps, so there's little to cut. At `max`, it
thinks a lot even on routine steps, and Jev moves those down. But in a long session every step
re-reads hundreds of thousands of tokens of context, which effort doesn't touch.

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
effort alternating on every step, each request read the full previous prefix from cache. In the
real session: 0 unexpected cache misses in 411 checked steps, 99.1% cache hit rate.

**3. Controlled benchmark.** Six small coding tasks, each with a visible test and hidden checks.
Each task ran from identical files twice: once at a fixed effort, once with Jev choosing under
that same effort as its ceiling. Two rounds at `high` and two at `max`, 48 headless Claude Code
sessions in all. A warm-up run came first so neither arm paid to cache the other's system prompt.

**4. Shadow mode on real work.** One 92-minute session of my normal work at `max` effort (470
model steps, Opus 5.5, Claude Code 2.1.280). For every step, Jev's choice was logged and nothing
was changed. Each request was priced at Claude API list prices from the usage the API reported:
cache reads, cache writes, output, and hidden thinking.

## Results

### Benchmark at `max`

| Task | Pass (fixed / Jev) | Cost (fixed / Jev) | Thinking tokens (fixed / Jev) | Jev's effort mix |
| --- | --- | ---: | ---: | --- |
| expr-eval | 2/2 / 2/2 | $2.00 / $0.32 | 54,397 / 551 | low 5, medium 4 |
| interval-merge | 2/2 / 2/2 | $0.36 / $0.25 | 2,907 / 45 | low 5, medium 4 |
| lru-cache | 2/2 / 2/2 | $0.39 / $0.23 | 2,963 / 0 | low 3, medium 4 |
| paginate-bug | 2/2 / 2/2 | $0.35 / $0.28 | 2,788 / 45 | low 4, medium 5 |
| rename-refactor | 2/2 / 2/2 | $0.38 / $0.36 | 1,335 / 313 | low 12, high 2 |
| stats-bugs | 2/2 / 2/2 | $0.27 / $0.28 | 509 / 0 | low 6, medium 4 |
| **Total** | 12/12 / 12/12 | **$3.76 / $1.70 (−55%)** | 64,899 / 954 (−98.5%) | |

Wall time fell from 913 s to 387 s. One task dominates: on expr-eval, `max` thought for about
27,000 tokens per run and Jev's low and medium settings passed the same hidden tests with about
280. Without expr-eval, cost still fell 21%.

### Benchmark at `high`

| | Fixed high | Jev | Change |
| --- | ---: | ---: | ---: |
| Hidden checks passed | 12/12 | 12/12 | |
| Thinking tokens | 1,450 | 787 | −45.7% |
| Output tokens | 20,281 | 20,515 | +1.2% |
| Cost | $1.94 | $1.92 | −1.1% |
| Wall time | 393 s | 417 s | +6% |

### Real session at `max`

Opus 5.5 list prices: $0.20 per million tokens read from cache, $8 per million written to the
one-hour cache, $20 per million output tokens. I'm on a subscription, so these are
API-equivalent figures, not a bill.

| Category | Spend | Share |
| --- | ---: | ---: |
| Cache reads | $41.05 | 63.9% |
| Cache writes | $11.51 | 17.9% |
| Hidden thinking | $6.10 | 9.5% |
| Visible output | $5.13 | 8.0% |
| Uncached input | $0.45 | 0.7% |
| **Total** | **$64.23** | |

The session averaged 441K tokens of context per step, re-read every time.

Jev would have lowered effort on all 470 steps: to high on 261, xhigh on 149, low on 51, and
medium on 9. It never kept `max`.

| | Amount | Share of spend |
| --- | ---: | ---: |
| Ceiling: all thinking removed on those steps | $6.10 | 9.5% |
| Estimate at the `high` benchmark's thinking cut (46%) | $2.80 | 4.4% |
| Estimate at the `max` benchmark's thinking cut (98.5%) | $6.01 | 9.4% |
| Jev's own cost (2.9M input tokens) | −$0.12 | |
| **Net** | **$2.68–$5.89** | **4.2–9.2%** |

The `max` benchmark's cut is likely too high for this session: there Jev mostly chose low and
medium, while here it mostly chose high and xhigh. **The break-even is thin.** One extra step
costs about $0.09 to re-read the context, so the net saving equals 30–67 extra steps across 470.
If lower effort makes Claude take more steps than that, it loses money. Shadow mode can't observe
that; the benchmarks found step counts roughly unchanged (92 vs 87 turns at `max`).

## Interpretation

- **The mechanism works.** Effort changes take hold, the cache survives, and every hidden test
  passed in both arms at both effort levels.
- **At `high`, it doesn't pay.** Opus 5.5 at `high` spends little on thinking during routine
  steps, so a 46% thinking cut moved total cost by about 1%.
- **At `max`, it can pay.** `max` spends heavily on thinking even when the step doesn't need it.
  With short contexts the saving is large (55% on the benchmark, and faster). In a long session
  the same kind of cut is a few percent of the bill, because context dominates.
- **It adds latency, but may not cost time.** Jev took 601 ms median and 793 ms at p95 per
  decision, with no errors. At `max`, less thinking more than made up for it: the Jev arm finished
  the benchmark in 42% of the time.
- **Quality at `max` on real work is untested.** The benchmark tasks are small and well specified.
  If you run `max` because your work needs it, lowering effort may cost more than it saves.

## Limitations

- One real session, at `max`, 92 minutes. There's no real-session measurement at `high`.
- The benchmark tasks are small, and two runs per task shows direction, not a precise effect
  size. One task accounts for most of the `max` result.
- Shadow mode can't measure quality or extra steps on real work, so the real-session saving is a
  range, not a measurement.
- Behind any proxy, Claude Code drops a few direct-connection features, including claude.ai-backed
  tools such as Artifacts, so each request carried about 4K fewer tokens than a direct session
  would ([details](docs/usage.md#limitations)).
- Dollar figures apply API list prices to subscription usage. How plan limits weigh each token
  type isn't published.

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
npx jev-effort --jev-shadow              # use like `claude`; logs Jev's choices, changes nothing
npx jev-effort stats                     # where your spend goes and what Jev would save
npx jev-effort stats --share             # the same, safe to paste (no prompts or ids)
npx jev-effort bench --effort max --runs 2   # the controlled comparison (uses your Claude usage)
```

Setup, configuration, and privacy details: [docs/usage.md](docs/usage.md). The data behind this
page: [real session at max](docs/results/2026-09-23-max-session.json),
[benchmark at max](docs/results/2026-09-23-opus-5-5-max.json), and
[benchmark at high](docs/results/2026-09-23-opus-5-5-high.json). If your numbers look different,
please open an issue with `jev-effort stats --share`.

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
