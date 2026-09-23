import assert from "node:assert/strict";
import { test } from "node:test";
import { isEffortMarker } from "../src/markers.mjs";
import { allowedEfforts, createPolicy } from "../src/policy.mjs";
import { ConversationStore } from "../src/store.mjs";
import { FakeClaudeCode, baseConfig, fakeJev, isPrefix } from "./helpers.mjs";

const policyWith = (script, config = {}) => {
  const jev = fakeJev(script);
  const policy = createPolicy({ config: { ...baseConfig, ...config }, jev, store: new ConversationStore(null), now: () => 1 });
  return { jev, policy };
};
const ourMarkers = (messages) => messages.filter((m) => isEffortMarker(m) && Array.isArray(m.content) && m.content.length === 0);

test("the marker goes last, after Claude Code's own per-turn effort", async () => {
  const { policy } = policyWith([{ effort: "low", leaseSteps: 1 }]);
  const cc = new FakeClaudeCode();
  const r = await policy.evaluate(cc.request(), "apply");
  assert.equal(r.managed, true);
  assert.equal(r.addBeta, true);
  assert.deepEqual(r.body.messages.at(-1), { role: "system", content: [], output_config: { effort: "low" } });
  assert.equal(r.record.sessionEffort, "high");
  assert.equal(r.record.appliedEffort, "low");
});

test("every rewritten request starts with the previous rewritten request", async () => {
  const efforts = ["low", "high", "low", "medium", "medium", "high", "low", "low"];
  const { policy } = policyWith(efforts.map((effort) => ({ effort, leaseSteps: 1 })));
  const cc = new FakeClaudeCode();
  let prev = null;
  for (let i = 0; i < efforts.length; i++) {
    if (i === 5) cc.newPrompt("Now add a test for an empty list.");
    else if (i > 0) cc.step({ output: `run ${i}` });
    const r = await policy.evaluate(cc.request(), "apply");
    assert.equal(r.record.appliedEffort, efforts[i]);
    if (prev) assert.ok(isPrefix(prev, r.body.messages), `request ${i} broke the cached prefix`);
    prev = r.body.messages;
  }
  // One marker per change of effort (medium→medium and low→low add nothing).
  assert.equal(ourMarkers(prev).length, 6);
});

test("no marker when Jev agrees with Claude Code's effort", async () => {
  const { policy } = policyWith([{ effort: "high", leaseSteps: 1 }]);
  const r = await policy.evaluate(new FakeClaudeCode().request(), "apply");
  assert.equal(r.addBeta, false);
  assert.equal(ourMarkers(r.body.messages).length, 0);
});

test("the effort range is capped at Claude Code's setting by default", async () => {
  const { policy, jev } = policyWith([{ effort: "medium", leaseSteps: 1 }]);
  await policy.evaluate(new FakeClaudeCode({ effort: "medium" }).request(), "apply");
  assert.deepEqual(jev.calls[0].state.supportedEfforts, ["low", "medium"]);
  assert.deepEqual(allowedEfforts("medium", "xhigh"), ["medium", "high", "xhigh"]);
  assert.deepEqual(allowedEfforts("high", "low"), ["low"]);
});

test("a one-level range skips Jev entirely", async () => {
  const { policy, jev } = policyWith([], { floor: "low" });
  const r = await policy.evaluate(new FakeClaudeCode({ effort: "low" }).request(), "apply");
  assert.equal(jev.calls.length, 0);
  assert.equal(r.record.source, "range");
});

test("a fixed ceiling lets Jev raise effort", async () => {
  const { policy, jev } = policyWith([{ effort: "xhigh", leaseSteps: 1 }], { ceiling: "max" });
  const r = await policy.evaluate(new FakeClaudeCode({ effort: "high" }).request(), "apply");
  assert.equal(jev.calls[0].state.supportedEfforts.at(-1), "max");
  assert.equal(r.record.appliedEffort, "xhigh");
});

test("leases skip Jev until they run out or something resets them", async () => {
  const { policy, jev } = policyWith([
    { effort: "low", leaseSteps: 5 },
    { effort: "medium", leaseSteps: 2 },
    { effort: "high", leaseSteps: 1 },
  ]);
  const cc = new FakeClaudeCode();
  const sources = [];
  for (let i = 0; i < 4; i++) {
    if (i) cc.step();
    sources.push((await policy.evaluate(cc.request(), "apply")).record.source);
  }
  assert.deepEqual(sources, ["jev", "lease", "lease", "lease"]);
  cc.step({ output: "boom", isError: true });
  const failed = await policy.evaluate(cc.request(), "apply");
  assert.deepEqual([failed.record.source, failed.record.resetReasons], ["jev", ["tool_failure"]]);
  cc.newPrompt("next thing");
  const prompted = await policy.evaluate(cc.request(), "apply");
  assert.deepEqual(prompted.record.resetReasons, ["new_user_input"]);
  assert.equal(jev.calls.length, 3);
});

test("a manual /effort change resets the lease and moves the ceiling", async () => {
  const { policy, jev } = policyWith([{ effort: "low", leaseSteps: 10 }, { effort: "medium", leaseSteps: 1 }]);
  const cc = new FakeClaudeCode({ effort: "high" });
  await policy.evaluate(cc.request(), "apply");
  cc.step().setEffort("xhigh");
  const r = await policy.evaluate(cc.request(), "apply");
  assert.deepEqual(r.record.resetReasons, ["manual_effort"]);
  assert.equal(jev.calls[1].state.supportedEfforts.at(-1), "xhigh");
});

test("a retried request reuses its decision without calling Jev", async () => {
  const { policy, jev } = policyWith([{ effort: "low", leaseSteps: 1 }, { effort: "high", leaseSteps: 1 }]);
  const cc = new FakeClaudeCode();
  const a = await policy.evaluate(cc.request(), "apply");
  const b = await policy.evaluate(cc.request(), "apply");
  assert.equal(b.record.source, "retry");
  assert.equal(b.record.step, a.record.step);
  assert.equal(b.body.messages.length, a.body.messages.length);
  assert.ok(isPrefix(a.body.messages, b.body.messages));
  assert.equal(jev.calls.length, 1);
});

test("a Jev failure falls back to Claude Code's effort", async () => {
  const { policy } = policyWith([Object.assign(new Error("down"), { category: "timeout" })]);
  const r = await policy.evaluate(new FakeClaudeCode().request(), "apply");
  assert.equal(r.record.source, "fallback");
  assert.equal(r.record.jevError, "timeout");
  assert.equal(r.record.appliedEffort, "high");
  assert.equal(r.addBeta, false);
});

test("a fallback after a lowered step switches back with a marker", async () => {
  const { policy } = policyWith([{ effort: "low", leaseSteps: 1 }, Object.assign(new Error("down"), { category: "http" })]);
  const cc = new FakeClaudeCode();
  const first = await policy.evaluate(cc.request(), "apply");
  cc.step();
  const r = await policy.evaluate(cc.request(), "apply");
  assert.equal(r.record.appliedEffort, "high");
  assert.ok(isPrefix(first.body.messages, r.body.messages));
  assert.equal(r.body.messages.at(-1).output_config.effort, "high");
});

test("shadow mode never changes the request", async () => {
  const { policy } = policyWith([{ effort: "low", leaseSteps: 1 }]);
  const body = new FakeClaudeCode().request();
  const r = await policy.evaluate(body, "shadow");
  assert.equal(r.body, body);
  assert.equal(r.addBeta, false);
  assert.equal(r.record.decidedEffort, "low");
  assert.equal(r.record.appliedEffort, "high");
});

test("branches keep their own markers (forks, compaction requests, /rewind)", async () => {
  const { policy } = policyWith(["low", "high", "medium", "high", "low"].map((effort) => ({ effort, leaseSteps: 1 })));
  const main = new FakeClaudeCode();
  await policy.evaluate(main.request(), "apply"); // low at the end of turn start
  main.step({ output: "shared" });
  const shared = await policy.evaluate(main.request(), "apply"); // high
  const fork = main.clone();
  fork.step({ output: "fork path" });
  const forked = await policy.evaluate(fork.request(), "apply"); // medium, fork only
  main.step({ output: "main path" });
  const cont = await policy.evaluate(main.request(), "apply"); // high: no new marker
  assert.ok(isPrefix(shared.body.messages, forked.body.messages));
  assert.ok(isPrefix(shared.body.messages, cont.body.messages));
  assert.ok(!cont.body.messages.some((m) => m.output_config?.effort === "medium"), "fork marker leaked into main");
  fork.step({ output: "fork again" });
  const fork2 = await policy.evaluate(fork.request(), "apply");
  assert.ok(isPrefix(forked.body.messages, fork2.body.messages), "fork lost its marker after main moved on");
});

test("models without per-message effort pass through", async () => {
  const { policy } = policyWith([]);
  for (const model of ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5"]) {
    const r = await policy.evaluate(new FakeClaudeCode({ model }).request(), "apply");
    assert.deepEqual(r, { managed: false, reason: "unsupported_model" });
  }
});

test("requests that don't end in a user turn pass through", async () => {
  const { policy } = policyWith([]);
  const body = new FakeClaudeCode().request();
  body.messages.push({ role: "assistant", content: [{ type: "text", text: "Prefill" }] });
  assert.equal((await policy.evaluate(body, "apply")).reason, "not_a_turn");
});

test("state survives a restart (a new process, same store directory)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
  const cc = new FakeClaudeCode();
  const p1 = createPolicy({ config: baseConfig, jev: fakeJev([{ effort: "low", leaseSteps: 1 }]), store: new ConversationStore(dir) });
  const first = await p1.evaluate(cc.request(), "apply");
  cc.step();
  const p2 = createPolicy({ config: baseConfig, jev: fakeJev([{ effort: "low", leaseSteps: 1 }]), store: new ConversationStore(dir) });
  const second = await p2.evaluate(cc.request(), "apply");
  assert.ok(isPrefix(first.body.messages, second.body.messages));
});
