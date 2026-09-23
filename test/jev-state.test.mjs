import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJevState, countToolFailures, humanText, latestHumanPrompt } from "../src/jev-state.mjs";
import { canonical, insertMarkers, nextTurnSlot, prefixHashes } from "../src/markers.mjs";
import { FakeClaudeCode } from "./helpers.mjs";

test("prompts are separated from Claude Code's system reminders", () => {
  const m = { role: "user", content: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>\nFix it\n<system-reminder>y</system-reminder>" }] };
  assert.equal(humanText(m), "Fix it");
  assert.equal(humanText({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }), "");
  assert.equal(humanText({ role: "assistant", content: "hi" }), "");
  const cc = new FakeClaudeCode({ prompt: "first" }).step().newPrompt("second").step();
  assert.equal(latestHumanPrompt(cc.messages), "second");
});

test("Jev sees prompts, visible replies and the last six tool calls, trimmed", () => {
  const cc = new FakeClaudeCode({ prompt: "original task" });
  for (let i = 0; i < 8; i++) cc.step({ output: i === 7 ? "x".repeat(20_000) : `out ${i}`, isError: i === 3 });
  cc.newPrompt("follow-up");
  cc.messages.push({ role: "assistant", content: [{ type: "text", text: "Looking at it." }, { type: "tool_use", id: "last", name: "Read", input: { path: "a.js" } }] });
  cc.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "last", content: [{ type: "text", text: "file body" }] }] });
  const s = buildJevState({ model: "claude-opus-5-5", messages: cc.messages, step: 9, previousEffort: "high", newToolFailures: 0, supportedEfforts: ["low", "high"] });
  assert.equal(s.latestUserPrompt, "follow-up");
  assert.equal(s.originalTask, "original task");
  assert.deepEqual(s.publicNotes, [{ kind: "assistant_text", text: "Looking at it." }]);
  assert.equal(s.recentToolCalls.length, 6);
  assert.equal(s.omittedOlderToolCalls, 3);
  assert.equal(s.recentToolCalls.at(-1).outputs[0].text, "file body");
  assert.ok(s.recentToolCalls.at(-2).outputs[0].text.length < 4100);
  assert.equal(countToolFailures(cc.messages), 1);
});

test("huge conversations are shrunk to fit Jev's request limit", () => {
  const cc = new FakeClaudeCode({ prompt: "p".repeat(50_000) });
  for (let i = 0; i < 6; i++) cc.step({ output: "y".repeat(50_000) });
  const s = buildJevState({ model: "m", messages: cc.messages, step: 1, previousEffort: "high", newToolFailures: 0, supportedEfforts: ["low"] });
  assert.ok(JSON.stringify(s).length <= 100_000);
});

test("hashing ignores cache_control and string-vs-block content", () => {
  const a = [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }];
  const b = [{ role: "user", content: "hi" }];
  assert.deepEqual(canonical(a), canonical(b));
  assert.equal(prefixHashes(a)[1], prefixHashes(b)[1]);
  const tr = (content) => [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content }] }];
  assert.equal(prefixHashes(tr("ok"))[1], prefixHashes(tr([{ type: "text", text: "ok" }]))[1]);
  assert.notEqual(prefixHashes(b)[1], prefixHashes([{ role: "user", content: "hello" }])[1]);
});

test("markers are inserted at their anchors, including the very end", () => {
  const msgs = ["a", "b", "c"].map((text) => ({ role: "user", content: text }));
  const out = insertMarkers(msgs, [{ at: 1, effort: "low" }, { at: 3, effort: "high" }]);
  assert.deepEqual(out.map((m) => m.output_config?.effort ?? m.content), ["a", "low", "b", "c", "high"]);
  assert.equal(nextTurnSlot([{ role: "user" }, { role: "system" }]), 0);
  assert.equal(nextTurnSlot([{ role: "user" }, { role: "assistant" }]), -1);
});
