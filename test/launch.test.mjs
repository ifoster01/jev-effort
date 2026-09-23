import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareVersions } from "../src/doctor.mjs";
import { bypassReason, claudeSettingsEnv } from "../src/environment.mjs";
import { splitArgs } from "../src/launch.mjs";

test("--jev-* options are ours; everything else goes to claude", () => {
  assert.deepEqual(splitArgs(["--jev-shadow", "--resume", "abc", "-p", "hi"]), {
    overrides: { mode: "shadow" },
    quiet: false,
    claudeArgs: ["--resume", "abc", "-p", "hi"],
  });
  assert.deepEqual(splitArgs(["--jev-floor", "medium", "--jev-ceiling=max", "--jev-quiet"]).overrides, { floor: "medium", ceiling: "max" });
  assert.deepEqual(splitArgs(["--model", "opus", "--", "--jev-shadow"]).claudeArgs, ["--model", "opus", "--jev-shadow"]);
  assert.throws(() => splitArgs(["--jev-nope"]), /unknown option/);
  assert.throws(() => splitArgs(["--jev-floor"]), /needs a value/);
});

test("setups the proxy can't serve fall back to plain claude", () => {
  assert.equal(bypassReason({}), null);
  assert.match(bypassReason({ CLAUDE_CODE_USE_BEDROCK: "1" }), /Bedrock/);
  assert.equal(bypassReason({ CLAUDE_CODE_USE_BEDROCK: "0" }), null);
  assert.match(bypassReason({}, { CLAUDE_CODE_USE_VERTEX: "true" }), /Google Cloud/);
  assert.match(bypassReason({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }), /beta/);
  assert.match(bypassReason({}, { ANTHROPIC_BASE_URL: "https://gw" }), /settings/);
  assert.equal(bypassReason({ ANTHROPIC_BASE_URL: "https://gw" }), null, "a shell-level base URL becomes the upstream");
  assert.match(bypassReason({ HTTPS_PROXY: "http://corp:8080" }), /HTTPS proxy/);
  assert.equal(bypassReason({ HTTPS_PROXY: "http://corp:8080", NO_PROXY: ".anthropic.com" }), null);
  assert.match(bypassReason({ JEV_EFFORT_ACTIVE: "1" }), /already running/);
});

test("Claude Code settings env blocks are merged, later files winning", () => {
  const home = mkdtempSync(join(tmpdir(), "jev-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "jev-cwd-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { A: "home", B: "home" } }));
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { B: "local" } }));
  assert.deepEqual(claudeSettingsEnv(cwd, home), { A: "home", B: "local" });
});

test("versions compare numerically", () => {
  assert.ok(compareVersions("2.1.281", "2.1.280") > 0);
  assert.ok(compareVersions("2.1.9", "2.1.280") < 0);
  assert.equal(compareVersions("2.1.280", "2.1.280"), 0);
});
