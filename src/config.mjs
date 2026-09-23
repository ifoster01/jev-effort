import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { EFFORTS } from "./constants.mjs";

const home = homedir();
export const CONFIG_DIR =
  process.env.JEV_EFFORT_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "jev-effort");
export const DATA_DIR =
  process.env.JEV_EFFORT_DATA_DIR ||
  join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "jev-effort");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const LOG_DIR = join(DATA_DIR, "logs");
export const STATE_DIR = join(DATA_DIR, "state");
export const BENCH_DIR = join(DATA_DIR, "bench");

export const MODES = ["apply", "shadow", "off"];
export const PROVIDERS = ["auto", "openrouter", "typesafe", "vercel"];

export const DEFAULTS = {
  mode: "apply",
  provider: "auto",
  // Never pick below `floor`. `ceiling: "session"` caps Jev at the effort Claude Code would
  // have used anyway, so the proxy can only lower spend; set an effort name to allow raising.
  floor: "low",
  ceiling: "session",
  maxLeaseSteps: 10,
  jevTimeoutMs: 5000,
  claudePath: "claude",
};

// Default key environment variables, per provider.
export const KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
};

export function readConfigFile(file = CONFIG_FILE) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

export function validateConfig(config) {
  const errors = [];
  if (!MODES.includes(config.mode)) errors.push(`mode must be one of ${MODES.join(", ")}`);
  if (!PROVIDERS.includes(config.provider)) errors.push(`provider must be one of ${PROVIDERS.join(", ")}`);
  if (!EFFORTS.includes(config.floor)) errors.push(`floor must be one of ${EFFORTS.join(", ")}`);
  if (config.ceiling !== "session" && !EFFORTS.includes(config.ceiling))
    errors.push(`ceiling must be "session" or one of ${EFFORTS.join(", ")}`);
  if (![1, 2, 5, 10].includes(config.maxLeaseSteps)) errors.push("maxLeaseSteps must be 1, 2, 5, or 10");
  if (!Number.isFinite(config.jevTimeoutMs) || config.jevTimeoutMs < 500)
    errors.push("jevTimeoutMs must be a number >= 500");
  if (config.apiKeyFile && !isAbsolute(config.apiKeyFile)) errors.push("apiKeyFile must be an absolute path");
  return errors;
}

// Defaults < config file < environment < command-line overrides.
export function loadConfig(overrides = {}, file = CONFIG_FILE) {
  const env = {};
  if (process.env.JEV_EFFORT_MODE) env.mode = process.env.JEV_EFFORT_MODE;
  if (process.env.JEV_EFFORT_PROVIDER) env.provider = process.env.JEV_EFFORT_PROVIDER;
  const config = { ...DEFAULTS, ...readConfigFile(file), ...env, ...overrides };
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid jev-effort config: ${errors.join("; ")}`);
  return config;
}

export function saveConfig(values, file = CONFIG_FILE) {
  const next = { ...readConfigFile(file), ...values };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return next;
}

export function detectProvider(key) {
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("vck_")) return "vercel";
  return "typesafe";
}

// Returns { key, source, provider } or null. Never logs or prints the key.
export function resolveKey(config, env = process.env) {
  const candidates = [];
  if (env.JEV_API_KEY) candidates.push([env.JEV_API_KEY, "JEV_API_KEY"]);
  if (config.apiKeyEnv && env[config.apiKeyEnv]) candidates.push([env[config.apiKeyEnv], config.apiKeyEnv]);
  if (config.apiKey) candidates.push([config.apiKey, "config file"]);
  if (config.apiKeyFile) {
    try {
      candidates.push([readFileSync(config.apiKeyFile, "utf8"), config.apiKeyFile]);
    } catch {
      // Reported by `jev-effort doctor`.
    }
  }
  const order = config.provider === "auto" ? Object.keys(KEY_ENV) : [config.provider];
  for (const p of order) if (env[KEY_ENV[p]]) candidates.push([env[KEY_ENV[p]], KEY_ENV[p]]);
  for (const [raw, source] of candidates) {
    const key = raw.trim();
    if (!key || /\s/.test(key)) continue;
    const provider = config.provider === "auto" ? detectProvider(key) : config.provider;
    return { key, source, provider };
  }
  return null;
}
