# Using jev-effort

jev-effort is the instrument behind the [findings in the README](../README.md). It works, but
it isn't recommended as a way to save money; see the results first.

## Requirements

- **Node 20+** and **Claude Code** (verified with 2.1.280).
- **Model: Opus 5.5** (verified). Fable 5.1, Mythos 5.1, and Opus 5 support per-message effort
  according to Anthropic's docs but haven't been verified here. Other models pass through
  untouched.
- **Claude API key or Claude subscription.** On Bedrock, Google Cloud, or Foundry,
  jev-effort steps aside and runs plain `claude`.
- **A Jev key**, from any of: [OpenRouter](https://openrouter.ai/settings/keys) (`sk-or-…`),
  [TypeSafe](https://console.typesafe.ai), or Vercel AI Gateway (`vck_…`). OpenRouter lists
  Jev at $0.042 per million input tokens with free output; a decision averaged about 5K input
  tokens in long sessions.

## Quick start

```sh
npx jev-effort --jev-shadow     # use exactly like `claude`; the first run asks for a Jev key
npx jev-effort stats            # where your spend goes and what Jev would have saved
```

Shadow mode logs Jev's choice for each step without changing any request or adding waiting.
Drop `--jev-shadow` to apply Jev's choices.

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

Details and measurements: [how-it-works.md](how-it-works.md).

## Commands

| Command | What it does |
| --- | --- |
| `jev-effort [claude args]` | Run Claude Code with per-step effort |
| `jev-effort --jev-shadow [claude args]` | Log Jev's picks without applying them |
| `jev-effort stats [--since 7d] [--share] [--json]` | Where your spend goes, what Jev could save, per-session breakdown, Jev latency, cache health; `--share` prints a paste-safe summary |
| `jev-effort bench [--tasks a,b] [--runs N] [--effort high]` | Controlled comparison: fixed effort vs Jev on six coding tasks with hidden checks |
| `jev-effort doctor [--probe]` | Check the setup and explain what will happen |
| `jev-effort setup [--key-file path \| --key-stdin] [--provider p] [--mode m]` | Add or replace the Jev key and defaults |
| `jev-effort serve [--port 8787]` | Standalone proxy, for tools that launch Claude Code themselves |

Options for a Claude Code run all start with `--jev-` (everything else goes to `claude`):
`--jev-shadow`, `--jev-mode apply|shadow|off`, `--jev-floor <effort>`,
`--jev-ceiling <effort|session>`, `--jev-quiet`.

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
- No telemetry. See [SECURITY.md](../SECURITY.md).

## Limitations

- It depends on how Claude Code builds requests, which isn't a public interface. A Claude
  Code update could change it; `jev-effort doctor` warns on newer versions, and
  `jev-effort stats` reports rejected rewrites and unexpected cache misses.
- In apply mode each Jev call adds waiting before a step: 747 ms median and 3.8 s at p95 in
  our sessions. There's none during leases or in shadow mode.
- Corporate HTTPS proxies (`HTTPS_PROXY`) aren't supported; jev-effort runs plain `claude`.
- **Claude Code behaves differently behind any `ANTHROPIC_BASE_URL` proxy.** jev-effort restores
  what it safely can when it forwards to the Claude API directly, unless you've set a value
  yourself (with `jev-effort serve`, set them yourself; the command prints them):

  | Behind a proxy, Claude Code… | jev-effort |
  | --- | --- |
  | Turns off MCP tool search, so every MCP tool definition loads into every request (a fresh session went from 27K to 281K–500K tokens) | Sets `ENABLE_TOOL_SEARCH=true` |
  | Turns off fine-grained tool streaming | Sets `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` |
  | Stops sending request-class hint headers | Sets `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, and uses them to leave compaction and side requests alone |
  | Disables Remote Control, server-managed settings, and claude.ai-backed tools such as Artifacts | Can't be restored. **If your organization relies on server-managed settings, don't use jev-effort.** |
  | Asks the server to review auto-mode actions (directly, only Enterprise and API accounts do) | Unchanged; set `CLAUDE_CODE_AUTO_MODE_SERVER=0` to use Claude Code's own classifier |
  | May run background tasks such as titles on the main model rather than Haiku | Unchanged; `ANTHROPIC_DEFAULT_HAIKU_MODEL` pins a model |
  | Budgets Sonnet 5 at 200K context | Unchanged; select `sonnet[1m]` for the full window |
- IDE extensions and the desktop app launch Claude Code themselves; use `jev-effort serve` and
  set `ANTHROPIC_BASE_URL` where they allow it.
- Windows is untested.

## Uninstall

```sh
npm uninstall -g jev-effort
rm -rf ~/.config/jev-effort ~/.local/share/jev-effort
```
