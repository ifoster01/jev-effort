// `jev-effort doctor [--probe]`: explain what will happen when you run jev-effort.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { CONFIG_FILE, DATA_DIR, loadConfig, resolveKey } from "./config.mjs";
import { SUPPORTED_MODEL_NAMES, TESTED_CLAUDE_CODE, VERSION } from "./constants.mjs";
import { bypassReason, claudeSettingsEnv } from "./environment.mjs";
import { probe } from "./setup.mjs";

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export async function doctor(argv, { stdout = process.stdout } = {}) {
  const lines = [];
  let problems = 0;
  const ok = (m) => lines.push(`  ✓ ${m}`);
  const warn = (m) => lines.push(`  ! ${m}`);
  const bad = (m) => {
    problems++;
    lines.push(`  ✗ ${m}`);
  };

  lines.push(`jev-effort ${VERSION}`);
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}; version 20 or newer is required`);

  let config;
  try {
    config = loadConfig();
    ok(`config: ${CONFIG_FILE}`);
  } catch (e) {
    bad(e.message);
    config = null;
  }

  if (config) {
    const r = spawnSync(config.claudePath, ["--version"], { encoding: "utf8", timeout: 15000, shell: process.platform === "win32" });
    const version = r.stdout?.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) bad(`Claude Code not found (tried \`${config.claudePath}\`). Install it, or set "claudePath" in the config.`);
    else if (compareVersions(version, TESTED_CLAUDE_CODE) > 0)
      warn(`Claude Code ${version} is newer than the last verified release (${TESTED_CLAUDE_CODE}). It should still work; if \`jev-effort stats\` shows cache breaks or rejected requests, please open an issue.`);
    else ok(`Claude Code ${version}`);

    const key = resolveKey(config);
    if (key) ok(`Jev key from ${key.source} (route: ${key.provider})`);
    else if (config.apiKeyFile) bad(`Jev key file ${config.apiKeyFile} is missing or unreadable`);
    else bad("no Jev key. Run `jev-effort setup`.");

    ok(`mode: ${config.mode}; effort ${config.floor} to ${config.ceiling === "session" ? "your /effort setting" : config.ceiling}`);
    const bypass = bypassReason(process.env, claudeSettingsEnv());
    if (bypass) warn(`jev-effort will run plain claude here: ${bypass}.`);
    if (process.env.ANTHROPIC_BASE_URL) warn(`requests will be forwarded to ANTHROPIC_BASE_URL (${process.env.ANTHROPIC_BASE_URL}); a gateway must pass anthropic-beta headers through.`);
    ok(`manages ${SUPPORTED_MODEL_NAMES.join(", ")} (verified: Opus 5.5); other models pass through untouched`);

    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      accessSync(DATA_DIR, constants.W_OK);
      ok(`logs and state: ${DATA_DIR}`);
    } catch (e) {
      bad(`can't write ${DATA_DIR}: ${e.message}`);
    }

    if (argv.includes("--probe")) {
      if (!key) bad("probe skipped: no key");
      else
        try {
          const d = await probe({ key: key.key, provider: key.provider });
          ok(`Jev answered in ${d.jevMs} ms (${d.jevModel ?? "jev"})`);
        } catch (e) {
          bad(`Jev probe failed: ${e.message}`);
        }
    } else lines.push("  (run `jev-effort doctor --probe` to make one small Jev request)");
  }

  stdout.write(lines.join("\n") + "\n");
  return problems ? 1 : 0;
}
