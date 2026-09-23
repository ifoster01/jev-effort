// `jev-effort [claude args]`: start the proxy, run Claude Code through it, exit with its code.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { LOG_DIR, STATE_DIR, loadConfig, resolveKey } from "./config.mjs";
import { bypassReason, claudeSettingsEnv, passthroughEnv } from "./environment.mjs";
import { JevClient } from "./jev.mjs";
import { createPolicy } from "./policy.mjs";
import { createLogger, createProxy } from "./proxy.mjs";
import { setup } from "./setup.mjs";
import { ConversationStore } from "./store.mjs";

const VALUE_FLAGS = { "--jev-mode": "mode", "--jev-floor": "floor", "--jev-ceiling": "ceiling" };

// Our flags all start with --jev-; everything else (and everything after `--`) goes to claude.
export function splitArgs(argv) {
  const overrides = {};
  const claudeArgs = [];
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      claudeArgs.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--jev-")) {
      claudeArgs.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (flag === "--jev-shadow") overrides.mode = "shadow";
    else if (flag === "--jev-off") overrides.mode = "off";
    else if (flag === "--jev-quiet") quiet = true;
    else if (VALUE_FLAGS[flag]) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${flag} needs a value`);
      overrides[VALUE_FLAGS[flag]] = value;
    } else throw new Error(`unknown option ${flag} (see \`jev-effort help\`)`);
  }
  return { overrides, quiet, claudeArgs };
}

export function runClaude(cmd, args, env) {
  return new Promise((resolve) => {
    let child;
    const start = (shell) => {
      child = spawn(cmd, args, { stdio: "inherit", env, shell });
      child.on("error", (e) => {
        if (e.code === "ENOENT" && process.platform === "win32" && !shell) return start(true);
        process.stderr.write(
          `jev-effort: could not start \`${cmd}\` (${e.message}). Is Claude Code installed? ` +
            "If it isn't on PATH, set claudePath in the config (see `jev-effort doctor`).\n",
        );
        resolve(127);
      });
      child.on("exit", (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 1)));
    };
    start(false);
    // The terminal delivers Ctrl+C to Claude Code directly; don't let it kill the proxy first.
    process.on("SIGINT", () => {});
    process.on("SIGQUIT", () => {});
    for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child?.kill(sig));
  });
}

export async function launch(argv, { stderr = process.stderr } = {}) {
  let parsed;
  let config;
  try {
    parsed = splitArgs(argv);
    config = loadConfig(parsed.overrides);
  } catch (e) {
    stderr.write(`jev-effort: ${e.message}\n`);
    return 2;
  }
  const { quiet, claudeArgs, overrides } = parsed;
  const say = (msg) => {
    if (quiet) return;
    stderr.write(stderr.isTTY ? `\x1b[2mjev-effort: ${msg}\x1b[0m\n` : `jev-effort: ${msg}\n`);
  };
  const plain = () => runClaude(config.claudePath, claudeArgs, process.env);

  if (config.mode === "off") return plain();
  const settingsEnv = claudeSettingsEnv();
  const bypass = bypassReason(process.env, settingsEnv);
  if (bypass) {
    say(`running plain claude: ${bypass}.`);
    return plain();
  }

  let key = resolveKey(config);
  if (!key && process.stdin.isTTY && stderr.isTTY) {
    stderr.write("jev-effort: first run, let's add your Jev key.\n\n");
    const ok = (await setup([], { firstRun: true })) === 0;
    if (ok) {
      config = loadConfig(overrides);
      key = resolveKey(config);
      stderr.write("\n");
    }
  }
  if (!key) {
    say("no Jev key found, running plain claude. Run `jev-effort setup` to add one.");
    return plain();
  }

  const store = new ConversationStore(STATE_DIR);
  store.prune();
  const policy = createPolicy({
    config,
    jev: new JevClient({ key: key.key, provider: key.provider, timeoutMs: config.jevTimeoutMs }),
    store,
  });
  const upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const proxy = createProxy({
    upstream,
    mode: config.mode,
    policy,
    logger: createLogger(LOG_DIR),
  });
  let port;
  try {
    port = await proxy.listen(0);
  } catch (e) {
    say(`could not start the proxy (${e.message}), running plain claude.`);
    return plain();
  }

  const range = config.ceiling === "session" ? `${config.floor} up to your /effort` : `${config.floor}–${config.ceiling}`;
  say(
    config.mode === "shadow"
      ? `shadow mode: Jev (${key.provider}) picks are logged, not applied. Results: jev-effort stats`
      : `Jev (${key.provider}) sets effort per step, ${range}. Results: jev-effort stats`,
  );
  const code = await runClaude(config.claudePath, claudeArgs, {
    ...process.env,
    ...passthroughEnv({ upstream, settingsEnv }),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    JEV_EFFORT_ACTIVE: "1",
  });
  await proxy.close();
  return code;
}
