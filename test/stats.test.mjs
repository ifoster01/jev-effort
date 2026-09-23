import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { priceFor, requestCost } from "../src/pricing.mjs";
import { BENCH_THINKING_CUT, cacheBreaks, formatSummary, parseSince, perSession, readRecords, savings, spend, summarize } from "../src/stats.mjs";

const t0 = Date.parse("2026-09-23T10:00:00Z");
const rec = (i, extra = {}) => ({
  v: 1,
  t: new Date(t0 + i * 10_000).toISOString(),
  session: "s1",
  model: "claude-opus-5-5",
  status: 200,
  managed: true,
  conv: "c1",
  messages: 2 + 2 * i,
  mode: "apply",
  source: "jev",
  sessionEffort: "high",
  decidedEffort: "low",
  appliedEffort: "low",
  jevMs: 200 + i,
  jevInputTokens: 1000,
  usage: { input: 2, cacheRead: 30000 + 500 * i, cacheWrite: 500, output: 100 },
  ...extra,
});

test("cache breaks are counted only when a step failed to read the previous prefix", () => {
  const ok = [rec(0), rec(1), rec(2)];
  assert.deepEqual(cacheBreaks(ok), { breaks: 0, checked: 2 });
  const broken = [rec(0), rec(1, { usage: { input: 2, cacheRead: 20000, cacheWrite: 11000, output: 5 } })];
  assert.deepEqual(cacheBreaks(broken), { breaks: 1, checked: 1 });
  const idle = [rec(0), { ...rec(1), t: new Date(t0 + 10 * 60_000).toISOString(), usage: { input: 2, cacheRead: 0, cacheWrite: 31000, output: 1 } }];
  assert.deepEqual(cacheBreaks(idle), { breaks: 0, checked: 0 }, "past the TTL a miss is expected");
});

test("summary covers effort mix, Jev, cache and problems", () => {
  const records = [
    rec(0),
    rec(1, { source: "lease" }),
    rec(2, { decidedEffort: "high", appliedEffort: "high" }),
    rec(3, { mode: "shadow", appliedEffort: "high" }),
    rec(4, { source: "fallback", jevError: "timeout", decidedEffort: "high", appliedEffort: "high" }),
    { v: 1, t: new Date(t0 + 60_000).toISOString(), session: "s1", model: "claude-haiku-4-5", managed: false, status: 200, usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 3 } },
  ];
  const s = summarize(records);
  assert.equal(s.managedSteps, 5);
  assert.equal(s.shadowSteps, 1);
  assert.equal(s.lowered, 3);
  assert.equal(s.jev.calls, 3);
  assert.deepEqual(s.jev.errors, [["timeout", 1]]);
  assert.equal(s.sources.lease, 1);
  assert.equal(s.output.thinking, null, "no thinking counts in these records");
  const withThinking = summarize([rec(0, { usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 200, thinking: 50 } })]);
  assert.equal(withThinking.output.thinking.share, 0.25);
  assert.match(formatSummary(withThinking), /25\.0% of them hidden thinking/);
  const text = formatSummary(s);
  assert.match(text, /Jev lowered effort on 60\.0% of steps/);
  assert.match(formatSummary(s, { share: true }), /^### jev-effort/);
  assert.ok(!formatSummary(s, { share: true }).includes("s1"), "share output has no session ids");
});

test("log files are read by date and filtered by --since", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-logs-"));
  writeFileSync(join(dir, "2026-09-20.jsonl"), JSON.stringify({ ...rec(0), t: "2026-09-20T12:00:00Z" }) + "\n");
  writeFileSync(join(dir, "2026-09-23.jsonl"), JSON.stringify(rec(0)) + "\n{torn line\n");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  assert.equal(readRecords(dir, 0).length, 2);
  assert.equal(readRecords(dir, Date.parse("2026-09-22T00:00:00Z")).length, 1);
  assert.equal(parseSince("7d", t0), t0 - 7 * 86400e3);
  assert.equal(parseSince("all"), 0);
  assert.throws(() => parseSince("yesterday"), /--since/);
});

test("an empty log says how to get started", () => {
  assert.match(formatSummary(summarize([])), /No jev-effort activity/);
});

test("prices match by longest model id", () => {
  assert.equal(priceFor("claude-opus-5-5").read, 0.2);
  assert.equal(priceFor("claude-opus-5").read, 0.5);
  assert.equal(priceFor("claude-opus-5-20260301").read, 0.5);
  assert.equal(priceFor("claude-opus-4-7").output, 25);
  assert.equal(priceFor("claude-haiku-4-5-20251001").output, 5);
  assert.equal(priceFor("claude-fable-5-1").read, 0.25);
  assert.equal(priceFor("gpt-6"), null);
});

test("request cost splits thinking from visible output and prices cache lifetimes", () => {
  const known = requestCost({ model: "claude-opus-5-5", usage: { input: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6, cacheWrite5m: 1e6, output: 1e6, thinking: 25e4 } });
  assert.deepEqual(
    Object.fromEntries(["input", "read", "write", "visibleOutput", "thinking"].map((k) => [k, Number(known[k].toFixed(4))])),
    { input: 4, read: 0.2, write: 13, visibleOutput: 15, thinking: 5 },
  );
  assert.equal(known.ttlAssumed, false);
  const old = requestCost({ model: "claude-opus-5-5", usage: { input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 } });
  assert.equal(old.write, 8, "unknown lifetime is priced as a 1-hour write");
  assert.equal(old.ttlAssumed, true);
});

test("savings: ceiling, bench-calibrated estimate, Jev cost, and the cost of one extra step", () => {
  const big = { input: 0, cacheRead: 1e6, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 2000, thinking: 1000 };
  const records = [
    rec(0, { mode: "shadow", usage: big, jevInputTokens: 1e6 }),
    rec(1, { mode: "shadow", source: "lease", decidedEffort: "high", usage: big }),
  ];
  const total = spend(records).total;
  const v = savings(records, total);
  assert.equal(v.steps, 2);
  assert.equal(v.lowered, 1);
  assert.equal(Number(v.ceiling.toFixed(4)), 0.02, "1,000 thinking tokens at $20/M on the one lowered step");
  assert.equal(Number(v.estimate.toFixed(4)), Number((0.02 * BENCH_THINKING_CUT).toFixed(4)));
  assert.equal(Number(v.jevCost.toFixed(4)), 0.042, "estimated from Jev input tokens when no cost is reported");
  assert.equal(Number(v.extraStep.toFixed(4)), 0.2, "re-reading 1M cached tokens at $0.20/M");
  assert.ok(v.net < 0 && v.stepsEquivalent < 0);
  assert.match(formatSummary(summarize(records)), /one extra step costs about \$0\.20/);
  assert.equal(savings([rec(0)], 1), null, "apply-mode steps can't show savings");
  assert.match(formatSummary(summarize([rec(0)])), /Needs shadow-mode data/);
});

test("sessions are broken out, and rate limits aren't counted as problems", () => {
  const records = [
    rec(0, { session: "a" }),
    rec(1, { session: "b", sessionEffort: "max", decidedEffort: "max" }),
    { ...rec(2, { session: "b" }), status: 429, usage: undefined, apiError: { type: "rate_limit_error" } },
    { ...rec(3, { session: "b" }), status: 500, usage: undefined, apiError: { type: "api_error" } },
  ];
  const sessions = perSession(records);
  assert.deepEqual(sessions.map((x) => [x.id, x.effort, x.steps, x.lowered]), [["a", "high", 1, 1], ["b", "max", 1, 0]]);
  const s = summarize(records);
  assert.equal(s.rateLimits, 1);
  assert.equal(s.problems.apiErrors, 1);
  const shared = formatSummary(s, { share: true });
  assert.match(shared, /\| 2 \| max \| 1 \|/);
  assert.ok(!/\ba\b.*\bb\b/.test(shared.split("Sessions")[1] ?? ""), "share output uses numbers, not session ids");
});
