import assert from "node:assert/strict";
import { test } from "node:test";
import { JevClient, ROUTES, decisionRequest, parseDecision } from "../src/jev.mjs";
import { PROBE_STATE } from "../src/setup.mjs";

const answer = (effort, lease) => ({ model: "jev-1.13.0", answers: { effort: { type: "choice", choice: effort, probabilities: { [effort]: 1 } }, lease: { type: "choice", choice: String(lease) } }, usage: { input_tokens: 900 } });
const respond = (status, json) => async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

test("each route gets its own model id and endpoint", () => {
  for (const provider of Object.keys(ROUTES)) {
    const body = decisionRequest(provider, PROBE_STATE, [1, 2, 5, 10]);
    assert.equal(body.model, ROUTES[provider].fields.model);
    assert.deepEqual(Object.keys(body.questions.effort.criteria), PROBE_STATE.supportedEfforts);
    assert.deepEqual(Object.keys(body.questions.lease.criteria), ["1", "2", "5", "10"]);
  }
  assert.deepEqual(decisionRequest("openrouter", PROBE_STATE, [1]).provider, { only: ["typesafe"], allow_fallbacks: false });
});

test("answers outside the allowed range are rejected", () => {
  assert.equal(parseDecision(answer("low", 2), ["low", "high"], [1, 2]).effort, "low");
  assert.throws(() => parseDecision(answer("max", 2), ["low", "high"], [1, 2]), /unusable/);
  assert.throws(() => parseDecision(answer("low", 10), ["low"], [1, 2]), /unusable/);
  assert.throws(() => parseDecision({}, ["low"], [1]), /unusable/);
});

test("the client sends the key as a bearer token and times the call", async () => {
  let seen;
  const client = new JevClient({
    key: "k-123",
    provider: "typesafe",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return respond(200, answer("medium", 5))();
    },
  });
  const d = await client.decide(PROBE_STATE, [1, 2, 5, 10]);
  assert.equal(seen.url, ROUTES.typesafe.url);
  assert.equal(seen.init.headers.authorization, "Bearer k-123");
  assert.deepEqual([d.effort, d.leaseSteps, d.jevInputTokens], ["medium", 5, 900]);
  assert.ok(Number.isFinite(d.jevMs));
});

test("errors are categorized", async () => {
  const auth = new JevClient({ key: "k", provider: "openrouter", fetchImpl: respond(401, { error: { message: "Missing Authentication header" } }) });
  await assert.rejects(auth.decide(PROBE_STATE, [1]), (e) => e.category === "auth" && /401/.test(e.message));
  const slow = new JevClient({ key: "k", provider: "openrouter", timeoutMs: 500, fetchImpl: (_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) });
  // AbortSignal.timeout doesn't hold the event loop open; before Node 24 the test runner
  // would give up on the pending promise. (In real use the proxy server keeps it alive.)
  const keepAlive = setTimeout(() => {}, 5000);
  await assert.rejects(slow.decide(PROBE_STATE, [1]), (e) => e.category === "timeout");
  clearTimeout(keepAlive);
});

test("repeated failures open the circuit for a while", async () => {
  let now = 0;
  let calls = 0;
  const client = new JevClient({ key: "k", provider: "typesafe", now: () => now, fetchImpl: async () => (calls++, respond(500, {})()) });
  for (let i = 0; i < 3; i++) await assert.rejects(client.decide(PROBE_STATE, [1]));
  await assert.rejects(client.decide(PROBE_STATE, [1]), (e) => e.category === "circuit_open");
  assert.equal(calls, 3);
  now += 3 * 60_000;
  await assert.rejects(client.decide(PROBE_STATE, [1]), (e) => e.category === "http");
  assert.equal(calls, 4);
});
