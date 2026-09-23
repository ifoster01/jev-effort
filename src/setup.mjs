// `jev-effort setup`: store a Jev key (and optional defaults), after checking it works.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CONFIG_FILE, MODES, detectProvider, loadConfig, saveConfig } from "./config.mjs";
import { EFFORTS } from "./constants.mjs";
import { JevClient } from "./jev.mjs";
import { askSecret, readAllStdin } from "./prompt.mjs";

export const PROBE_STATE = {
  model: "claude-opus-5-5",
  supportedEfforts: EFFORTS,
  latestUserPrompt: "Rename the variable `tmp` to `total` in src/sum.js.",
  priorUserPrompts: [],
  publicNotes: [],
  recentToolCalls: [],
  omittedOlderToolCalls: 0,
  step: 1,
  previousEffort: "high",
  newToolFailures: 0,
};

export async function probe({ key, provider, timeoutMs = 15000 }) {
  const client = new JevClient({ key, provider, timeoutMs });
  return client.decide(PROBE_STATE, [1, 2, 5, 10]);
}

const INTRO = `jev-effort needs a Jev API key. Jev is TypeSafe's decision model; any of these routes works:
  OpenRouter         https://openrouter.ai/settings/keys   (key starts with sk-or-)
  TypeSafe direct    https://console.typesafe.ai
  Vercel AI Gateway  https://vercel.com/ai-gateway         (key starts with vck_)

Privacy: Jev sees your prompts, Claude's visible replies, and trimmed tool output (which can
include your code). Nothing is sent to Jev unless jev-effort is running.
`;

function parseSetupArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--key-stdin") opts.keyStdin = true;
    else if (a === "--key-file") opts.keyFile = next();
    else if (a === "--provider") opts.provider = next();
    else if (a === "--mode") opts.mode = next();
    else if (a === "--floor") opts.floor = next();
    else if (a === "--ceiling") opts.ceiling = next();
    else if (a === "--no-probe") opts.noProbe = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

export async function setup(argv, { firstRun = false, stderr = process.stderr } = {}) {
  const out = (s) => stderr.write(s);
  let opts;
  try {
    opts = parseSetupArgs(argv);
  } catch (e) {
    out(`jev-effort setup: ${e.message}\n`);
    return 2;
  }

  const values = {};
  for (const k of ["provider", "mode", "floor", "ceiling"]) if (opts[k]) values[k] = opts[k];
  if (opts.mode && !MODES.includes(opts.mode)) return out(`jev-effort setup: mode must be one of ${MODES.join(", ")}\n`), 2;

  let key;
  const interactive = !opts.keyFile && !opts.keyStdin && (!Object.keys(values).length || firstRun);
  try {
    if (opts.keyFile) {
      const file = isAbsolute(opts.keyFile) ? opts.keyFile : resolve(opts.keyFile);
      values.apiKeyFile = file;
      values.apiKey = undefined;
      key = readFileSync(file, "utf8").trim();
    } else if (opts.keyStdin) {
      key = await readAllStdin();
    } else if (!Object.keys(values).length || firstRun) {
      out(INTRO + "\n");
      key = await askSecret("Paste your Jev API key (input hidden): ");
    }
  } catch (e) {
    out(`jev-effort setup: ${e.message}\n`);
    return 1;
  }
  if (key !== undefined) {
    if (!key || /\s/.test(key)) return out("jev-effort setup: that key is empty or contains spaces.\n"), 1;
    if (!opts.keyFile) {
      values.apiKey = key;
      values.apiKeyFile = undefined;
    }
  }

  // Validate the combined config before saving anything.
  let config;
  try {
    config = loadConfig(values);
  } catch (e) {
    out(`jev-effort setup: ${e.message}\n`);
    return 2;
  }

  // Typed keys get three tries; a key from a file or stdin gets one.
  for (let attempt = 1; key && !opts.noProbe; attempt++) {
    const provider = config.provider === "auto" ? detectProvider(key) : config.provider;
    out(`Checking the key with Jev (${provider})... `);
    try {
      const r = await probe({ key, provider });
      out(`ok (${r.jevModel ?? "jev"}, ${r.jevMs} ms)\n`);
      break;
    } catch (e) {
      out(`failed\n  ${e.message}\n`);
      if (e.category === "auth")
        out("  The key was rejected. Check which service issued it; use --provider to force a route.\n");
      if (!interactive || attempt === 3) {
        out("Nothing was saved. Use --no-probe to save anyway.\n");
        return 1;
      }
      try {
        key = await askSecret("Try again (input hidden, Ctrl+C to cancel): ");
      } catch {
        return 1;
      }
      if (!key || /\s/.test(key)) return out("jev-effort setup: that key is empty or contains spaces.\n"), 1;
      values.apiKey = key;
    }
  }

  saveConfig(values);
  out(`Saved to ${CONFIG_FILE} (readable only by you).\n`);
  if (firstRun || key) {
    out(`Mode: ${config.mode}. Try \`jev-effort --jev-shadow\` to only record what Jev would pick.\n`);
  }
  return 0;
}
