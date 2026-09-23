// Detects setups where the proxy can't (or shouldn't) sit in front of Claude Code.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const truthy = (v) => v !== undefined && v !== "" && v !== "0" && String(v).toLowerCase() !== "false";

// Claude Code also applies the `env` block from its settings files.
export function claudeSettingsEnv(cwd = process.cwd(), home = homedir()) {
  const files = [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  const env = {};
  for (const f of files) {
    try {
      Object.assign(env, JSON.parse(readFileSync(f, "utf8")).env ?? {});
    } catch {
      // Missing or unreadable settings files are normal.
    }
  }
  return env;
}

function noProxyCovers(noProxy, host) {
  return String(noProxy ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => p === "*" || host === p.replace(/^\./, "") || host.endsWith(p.startsWith(".") ? p : `.${p}`));
}

// Returns a reason string when jev-effort should step aside and run plain `claude`.
export function bypassReason(env, settingsEnv = {}) {
  const all = { ...env, ...settingsEnv };
  if (truthy(env.JEV_EFFORT_ACTIVE))
    return "jev-effort is already running in this environment (is `claudePath` pointing back at jev-effort?)";
  if (truthy(all.CLAUDE_CODE_USE_BEDROCK)) return "Amazon Bedrock is configured, and per-step effort isn't cache-safe there";
  if (truthy(all.CLAUDE_CODE_USE_VERTEX)) return "Google Cloud is configured, and per-step effort isn't cache-safe there";
  if (truthy(all.CLAUDE_CODE_USE_FOUNDRY)) return "Microsoft Foundry is configured, which jev-effort doesn't support";
  if (truthy(all.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS))
    return "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set, and the effort marker relies on a beta";
  if (settingsEnv.ANTHROPIC_BASE_URL)
    return "your Claude Code settings set ANTHROPIC_BASE_URL, which would override the proxy";
  const httpsProxy = all.HTTPS_PROXY ?? all.https_proxy;
  if (httpsProxy && !noProxyCovers(all.NO_PROXY ?? all.no_proxy, "api.anthropic.com"))
    return "an HTTPS proxy is configured, which jev-effort doesn't support yet";
  return null;
}
