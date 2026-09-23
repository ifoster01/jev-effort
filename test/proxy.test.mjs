import assert from "node:assert/strict";
import { test } from "node:test";
import { EFFORT_BETA } from "../src/constants.mjs";
import { createPolicy } from "../src/policy.mjs";
import { createProxy, memoryLogger } from "../src/proxy.mjs";
import { ConversationStore } from "../src/store.mjs";
import { FakeClaudeCode, baseConfig, fakeJev, fakeUpstream, sse } from "./helpers.mjs";

async function setup({ mode = "apply", script = [{ effort: "low", leaseSteps: 1 }], handler = (_, res) => sse(res), policy } = {}) {
  const upstream = await fakeUpstream(handler);
  const logger = memoryLogger();
  const jev = fakeJev(script);
  const proxy = createProxy({
    upstream: upstream.url,
    mode,
    logger,
    policy: policy ?? createPolicy({ config: baseConfig, jev, store: new ConversationStore(null) }),
  });
  const port = await proxy.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "claude-code-20250219,per-turn-control-2026-07-01", ...headers },
      body: JSON.stringify(body),
    });
  return {
    upstream,
    logger,
    jev,
    proxy,
    base,
    post,
    async done() {
      await proxy.close();
      await upstream.close();
    },
  };
}

test("apply: forwards the marker and beta, streams the response back, logs usage", async () => {
  const t = await setup();
  try {
    const res = await t.post(new FakeClaudeCode().request());
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /message_stop/);
    const sent = t.upstream.received[0];
    assert.equal(sent.body.messages.at(-1).output_config.effort, "low");
    assert.ok(sent.headers["anthropic-beta"].split(",").includes(EFFORT_BETA));
    assert.ok(sent.headers["anthropic-beta"].includes("per-turn-control-2026-07-01"), "kept Claude Code's betas");
    assert.equal(sent.headers["accept-encoding"], "identity");
    const rec = t.logger.records[0];
    assert.deepEqual(rec.usage, { input: 10, cacheRead: 30000, cacheWrite: 500, output: 42 });
    assert.equal(rec.appliedEffort, "low");
    assert.equal(rec.status, 200);
    assert.ok(!JSON.stringify(rec).includes("stats.js"), "log records must not contain prompt text");
  } finally {
    await t.done();
  }
});

test("shadow: the upstream gets Claude Code's exact bytes, and Jev's pick is logged", async () => {
  const t = await setup({ mode: "shadow" });
  try {
    const body = new FakeClaudeCode().request();
    await (await t.post(body)).text();
    assert.equal(t.upstream.received[0].raw.toString(), JSON.stringify(body));
    assert.ok(!t.upstream.received[0].headers["anthropic-beta"].includes(EFFORT_BETA));
    const rec = t.logger.records[0];
    assert.equal(rec.mode, "shadow");
    assert.equal(rec.decidedEffort, "low");
    assert.equal(rec.appliedEffort, "high");
  } finally {
    await t.done();
  }
});

test("other endpoints pass through untouched", async () => {
  const t = await setup({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    },
  });
  try {
    const counted = await fetch(`${t.base}/v1/messages/count_tokens`, { method: "POST", body: JSON.stringify(new FakeClaudeCode().request()) });
    assert.deepEqual(await counted.json(), { path: "/v1/messages/count_tokens" });
    const models = await fetch(`${t.base}/v1/models?limit=5`);
    assert.deepEqual(await models.json(), { path: "/v1/models?limit=5" });
    assert.equal(t.jev.calls.length, 0);
    assert.equal(t.logger.records.length, 0);
  } finally {
    await t.done();
  }
});

test("if the API rejects the rewrite, the original request is retried; twice disables apply", async () => {
  const t = await setup({
    script: [{ effort: "low", leaseSteps: 1 }],
    handler: (req, res) => {
      if (req.body?.messages?.some((m) => m.role === "system" && Array.isArray(m.content) && !m.content.length)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
      }
      sse(res);
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await t.post(new FakeClaudeCode({ prompt: `task ${i}` }).request());
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.equal(t.logger.records.filter((r) => r.injectionRejected).length, 2);
    assert.equal(t.proxy.applyDisabled, true);
    await (await t.post(new FakeClaudeCode({ prompt: "task 3" }).request())).text();
    assert.equal(t.logger.records.at(-1).mode, "shadow");
  } finally {
    await t.done();
  }
});

test("a policy crash forwards the original request", async () => {
  const t = await setup({ policy: { evaluate: async () => { throw new Error("bug"); } } });
  try {
    const body = new FakeClaudeCode().request();
    const res = await t.post(body);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(t.upstream.received[0].raw.toString(), JSON.stringify(body));
    assert.equal(t.logger.records[0].policyError, "bug");
  } finally {
    await t.done();
  }
});

test("API errors are passed back to Claude Code as-is", async () => {
  const t = await setup({
    handler: (_, res) => {
      res.writeHead(529, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    },
  });
  try {
    const res = await t.post(new FakeClaudeCode().request());
    assert.equal(res.status, 529);
    assert.equal((await res.json()).error.type, "overloaded_error");
    assert.equal(t.logger.records[0].apiError.type, "overloaded_error");
  } finally {
    await t.done();
  }
});

test("an unreachable upstream becomes a 502 Claude Code can retry", async () => {
  const logger = memoryLogger();
  const proxy = createProxy({ upstream: "http://127.0.0.1:9", mode: "off", logger, policy: null });
  const port = await proxy.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).type, "error");
  } finally {
    await proxy.close();
  }
});

test("an upstream base path is kept (gateways)", async () => {
  const upstream = await fakeUpstream((_, res) => sse(res));
  const proxy = createProxy({ upstream: `${upstream.url}/anthropic/`, mode: "off", logger: memoryLogger(), policy: null });
  const port = await proxy.listen(0);
  try {
    await (await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, { method: "POST", body: "{}" })).text();
    assert.equal(upstream.received[0].url, "/anthropic/v1/messages?beta=true");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
