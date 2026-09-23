import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheBreaks, formatSummary, parseSince, readRecords, summarize } from "../src/stats.mjs";

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
  assert.match(formatSummary(withThinking), /25\.0% hidden thinking/);
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
