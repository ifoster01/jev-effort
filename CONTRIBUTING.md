# Contributing

Thanks for helping. The most useful contributions right now are **real-world numbers**:
run `jev-effort --jev-shadow` for a few days, then open a "Share results" issue with
`jev-effort stats --share`.

## Development

No dependencies; Node 20+.

```sh
npm test                          # unit and integration tests (no network)
node bin/jev-effort.mjs help
JEV_EFFORT_DATA_DIR=/tmp/jev node bin/jev-effort.mjs --jev-shadow   # keep test logs separate
```

The tests include a fake Claude Code (`test/helpers.mjs`) shaped like real 2.1.280 traffic
and a fake Claude API. The key invariant, that every rewritten request starts with the
previous one, is checked in `test/policy.test.mjs`.

## Adding a bench task

Create `bench/tasks/<name>/` with:

- `task.json`: `{ "description": "...", "prompt": "..." }` (optional `allowedTools`)
- `fixture/`: the starting files, including a visible `test.js`
- `check.mjs`: `node check.mjs <workdir>` exits 0 when the task is done correctly. Test
  what the prompt or doc comments specify, including cases the visible test skips.
- `solution/`: a reference solution overlaid on the fixture

`npm test` verifies that each fixture fails its check and each solution passes.

## When Claude Code updates

Follow "Verifying a new Claude Code release" in docs/how-it-works.md and bump
`TESTED_CLAUDE_CODE` in `src/constants.mjs`.
