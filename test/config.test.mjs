import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, detectProvider, loadConfig, readConfigFile, resolveKey, saveConfig, validateConfig } from "../src/config.mjs";
import { modelInfo } from "../src/constants.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-config-"));

test("the provider is guessed from the key prefix", () => {
  assert.equal(detectProvider("sk-or-v1-abc"), "openrouter");
  assert.equal(detectProvider("vck_abc"), "vercel");
  assert.equal(detectProvider("tsk_live_abc"), "typesafe");
});

test("key resolution order: JEV_API_KEY, apiKeyEnv, config, key file, provider env", () => {
  const dir = tmp();
  const file = join(dir, "key");
  writeFileSync(file, "from-file\n");
  const config = { ...DEFAULTS, apiKeyEnv: "MY_KEY", apiKey: "from-config", apiKeyFile: file };
  assert.equal(resolveKey(config, { JEV_API_KEY: "a", MY_KEY: "b" }).source, "JEV_API_KEY");
  assert.equal(resolveKey(config, { MY_KEY: "b" }).key, "b");
  assert.equal(resolveKey(config, {}).key, "from-config");
  assert.equal(resolveKey({ ...DEFAULTS, apiKeyFile: file }, {}).key, "from-file");
  const env = resolveKey(DEFAULTS, { OPENROUTER_API_KEY: "sk-or-v1-x" });
  assert.deepEqual([env.provider, env.source], ["openrouter", "OPENROUTER_API_KEY"]);
  assert.equal(resolveKey(DEFAULTS, {}), null);
  assert.equal(resolveKey({ ...DEFAULTS, apiKey: "has space" }, {}), null);
  assert.equal(resolveKey({ ...DEFAULTS, provider: "vercel", apiKey: "sk-or-v1-x" }, {}).provider, "vercel");
});

test("invalid settings are reported together", () => {
  const errors = validateConfig({ ...DEFAULTS, mode: "loud", floor: "tiny", maxLeaseSteps: 3 });
  assert.equal(errors.length, 3);
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test("config is saved privately and merged over defaults", () => {
  const file = join(tmp(), "nested", "config.json");
  saveConfig({ apiKey: "secret", mode: "shadow" }, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  saveConfig({ apiKey: undefined, apiKeyFile: "/abs/key" }, file);
  assert.deepEqual(readConfigFile(file), { mode: "shadow", apiKeyFile: "/abs/key" });
  assert.equal(loadConfig({}, file).floor, "low");
  assert.equal(loadConfig({ mode: "off" }, file).mode, "off");
});

test("model ids match exactly, with optional snapshot or variant suffix", () => {
  assert.equal(modelInfo("claude-opus-5-5").name, "Opus 5.5");
  assert.equal(modelInfo("claude-opus-5-5[1m]").name, "Opus 5.5");
  assert.equal(modelInfo("claude-opus-5").name, "Opus 5");
  assert.equal(modelInfo("claude-opus-5-20260301").name, "Opus 5");
  assert.equal(modelInfo("claude-fable-5-1").name, "Fable 5.1");
  assert.equal(modelInfo("claude-fable-5"), null);
  assert.equal(modelInfo("claude-sonnet-5"), null);
  assert.equal(modelInfo(undefined), null);
});
