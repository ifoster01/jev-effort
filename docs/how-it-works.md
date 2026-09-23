# How jev-effort works

This page explains the mechanism and the evidence behind it. It's also the checklist for
verifying a new Claude Code release.

## The problem

Claude Code runs a whole session at one effort level (`/effort`). Most steps of an agentic
session are routine: reading a file, running a test, making an edit that has already been
decided. A few steps need deep reasoning. Changing effort per step used to be impractical:
on most models, changing the top-level `output_config.effort` invalidates the prompt cache,
so the next request re-processes the whole conversation.

Newer models (Opus 5.5, Fable 5.1, Mythos 5.1, Opus 5) accept **per-message effort**: an
effort-only system message inside `messages` (beta `mid-conversation-output-config-2026-07-01`).
The level takes effect from that point on, and everything before it is unchanged, so the
cached prefix still matches. See Anthropic's
[effort docs](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta).

jev-effort uses that primitive, plus a classifier, to choose effort for every step.

## Request flow

```
claude ──► jev-effort proxy (127.0.0.1, random port) ──► api.anthropic.com
                    │
                    └──► Jev: "which effort does the NEXT step need, and for how long?"
```

1. `jev-effort` starts a proxy on a random local port and runs `claude` with
   `ANTHROPIC_BASE_URL` pointing at it. Your normal `claude` command is untouched.
2. For each `POST /v1/messages` to a supported model that ends in a user turn, the proxy
   builds a bounded view of the conversation (below) and asks Jev for an effort and a lease
   of 1, 2, 5, or 10 steps. During a lease, Jev isn't called. A new prompt, a tool failure,
   a model change, or a manual `/effort` change ends the lease early.
3. If the effort differs from what currently applies, the proxy appends
   `{"role": "system", "content": [], "output_config": {"effort": "<level>"}}` as the **last**
   message and adds the beta header. Everything else in the request is byte-for-byte what
   Claude Code sent.
4. The response streams back unchanged. The proxy reads token usage from it for `stats`.

## What we learned about Claude Code's requests (2.1.280)

These were found by capturing real requests and are what the design rests on.

- **Claude Code already sends per-turn effort.** Right after the prompt, it adds a system
  message (the environment block) carrying `output_config: {"effort": ...}` under the
  `per-turn-control-2026-07-01` beta. Stripping that beta makes the API reject the request:
  `messages.1.output_config: Extra inputs are not permitted`.
- **The latest effort setting in a request wins.** A marker placed *before* the prompt was
  silently overridden by Claude Code's own message after it. The marker must be the last
  message.
- **Rewriting the top-level `output_config.effort` does nothing** while that per-turn message
  is present. (It looked cache-safe in an early test only because it had no effect.)
- **Claude Code re-sends some messages in a different form.** The environment message is sent
  as text blocks the first time and as a plain string afterwards. The API renders both the
  same, so the cache still hits, but a naive hash of the history changes. The marker
  bookkeeping hashes a normalized form (string content → one text block, `cache_control`
  removed).
- **Any custom `ANTHROPIC_BASE_URL` turns off MCP tool search.** Claude Code assumes a proxy
  might drop `tool_reference` blocks, so it loads every MCP tool definition into every request
  instead. With several MCP servers connected, a fresh session started at 281K–500K tokens
  instead of 27K. jev-effort's proxy forwards those blocks unchanged, so it sets
  `ENABLE_TOOL_SEARCH=true` for the Claude Code it launches.
- **Thinking is requested with `display: "omitted"`**, so Jev sees Claude's visible text and
  tool activity but no reasoning.

## Keeping the cache intact

Claude Code rebuilds every request from its own history, which doesn't contain our markers.
So each marker is stored with:

- `at`: its position in Claude Code's message list (0 to length; length means "at the end"),
- `hash`: a hash of the normalized messages before it.

On every request, each stored marker whose `hash` matches the request's history at `at` is
re-inserted at `at`. The result is that every rewritten request begins with exactly the
previous rewritten request, which is what prompt caching needs. The test suite checks this
invariant directly (`test/policy.test.mjs`).

Markers are never deleted when histories diverge. A fork, a compaction request, or `/rewind`
produces a different history, so markers from the other branch simply stop matching, and
the original branch still finds its own. State lives in one small file per conversation
(`~/.local/share/jev-effort/state/`), so it survives restarts and `--continue`, and holds only
positions, hashes, effort names, and a hash of the latest prompt.

## Measurements

Opus 5.5, Claude Code 2.1.280, subscription auth.

**The effort is honored.** "How many 8-digit positive integers have digit sum 36 and are
divisible by 11?" with no tools, output tokens (including hidden thinking):

| Method | low | max |
| --- | --- | --- |
| Claude Code `--effort` | 438 | 1,733 |
| Marker appended last | 438, 548 | 1,809, 1,528 |
| Marker before the prompt | 686 | 669 (overridden) |
| Top-level rewrite | 595 | 662 (overridden) |

**The cache holds.** With effort alternating low/high on every step of a bug-fix task, each
request read exactly the previous request's prefix from cache (26,992 → 34,285 → 35,017 →
35,270 → 35,617 tokens), the same pattern as an untouched run. The same held across a
`--continue` second turn with Jev choosing.

**Jev is cheap.** Requests are 1-3K input tokens; median latency about 300 ms on the TypeSafe
route. OpenRouter lists Jev 1.13 at $0.042 per million input tokens with free output.

## What Jev sees

For each decision: the model name, allowed effort levels, the latest prompt (up to 8,000
characters), the original task and up to five earlier prompts (trimmed), Claude's visible
replies since the latest prompt (up to eight, trimmed), and the last six tool calls with
their inputs and head-and-tail previews of their output (about 1,000 tokens each). Requests
are capped well below Jev's 28K-token limit and shrink gracefully for huge conversations.
Tool output can include your code.

## Failure handling

Everything fails toward what Claude Code would have done anyway:

| Situation | What happens |
| --- | --- |
| Jev error or timeout (default 5 s) | This step runs at Claude Code's effort |
| Three Jev failures in a row | Jev is skipped for two minutes |
| The API rejects a rewritten request (400) | The original request is re-sent; after two such rejections the process stops rewriting and continues in shadow mode |
| Any internal error | The original request is forwarded unchanged |
| Unsupported model, Bedrock/Vertex/Foundry, HTTPS proxy, or `ANTHROPIC_BASE_URL` in Claude Code settings | Plain `claude` runs, with a one-line notice |

## Native alternative: function hooks (early access)

Claude Code 2.1.260+ ships an early-access plugin API, "function hooks", switched on with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and documented only by the declarations `/plugin-types`
writes ("EARLY ACCESS: this surface may change between releases without notice"). Its
`turn.step` event wraps each model request, and its input is
`{ turnId, index, model, effort?, messageCount, agentId? }`: a hook may rewrite `model` and
`effort`, and the rest is pinned. A hook can read the conversation with
`$.session.messages({ as: "api" })` and reach Jev with `$.http.fetch`.

A minimal plugin (`hooks/hooks.json` naming one module whose `turn.step` hook calls
`next({ ...e, effort })`), loaded with `--plugin-dir` on 2.1.280 behind the proxy in logging
mode:

| Check | Result |
| --- | --- |
| Effort honored | Counting prompt: 522 thinking tokens forced `low`, 1,678 forced `max` |
| How Claude Code applies it | Step 0: sets the effort on its own environment message. Later steps: appends an empty effort-only system message and keeps every earlier one, the same markers jev-effort inserts |
| Cache, alternating low/high every step | Each read equals the previous read plus write: 24,961 → 34,293 → 35,022 → 35,304 → 35,660 |

So a plugin could replace the proxy: no marker bookkeeping, no `ANTHROPIC_BASE_URL`, and it
would work anywhere function hooks load. Trade-offs today: the API is early access and may
change without notice; it needs the flag; and the per-step usage a plugin receives has input,
output and cache token counts but not thinking tokens or the cache-lifetime split, so the
spend breakdown in `stats` would be less exact.

## Verifying a new Claude Code release

1. `JEV_EFFORT_DUMP_DIR=/tmp/jev-dump jev-effort -p "Run ls" --allowedTools "Bash(ls)"` and
   check that the effort-carrying system message still follows the prompt and that our
   marker is last.
2. `jev-effort bench --tasks stats-bugs,paginate-bug` and confirm no `rejected` notes.
3. `jev-effort stats` should show `unexpected cache misses: 0`.
4. Update `TESTED_CLAUDE_CODE` in `src/constants.mjs`.
