import { LOG_DIR, STATE_DIR, loadConfig, resolveKey } from "./config.mjs";
import { passthroughEnv } from "./environment.mjs";
import { VERSION } from "./constants.mjs";
import { JevClient } from "./jev.mjs";
import { launch } from "./launch.mjs";
import { createPolicy } from "./policy.mjs";
import { createLogger, createProxy } from "./proxy.mjs";
import { ConversationStore } from "./store.mjs";

export const HELP = `jev-effort ${VERSION}: per-step reasoning effort for Claude Code, chosen by Jev (unofficial)

Usage
  jev-effort [claude options]      run Claude Code through jev-effort (all options go to claude)
  jev-effort --jev-shadow ...      log what Jev would pick without changing anything
  jev-effort setup                 add or replace your Jev key
  jev-effort stats [--since 7d] [--share] [--json]
  jev-effort bench [--tasks a,b] [--runs N] [--effort high] [--list]
  jev-effort doctor [--probe]
  jev-effort serve [--port 8787]   standalone proxy; point ANTHROPIC_BASE_URL at it

Options for a Claude Code run (anything else is passed to claude)
  --jev-shadow                     same as --jev-mode shadow
  --jev-mode apply|shadow|off
  --jev-floor <effort>             lowest effort Jev may pick (default low)
  --jev-ceiling <effort|session>   highest; "session" = your /effort setting (default)
  --jev-quiet                      no status line at startup

Efforts: low, medium, high, xhigh, max. Docs: README.md and docs/how-it-works.md.
`;

async function serve(argv) {
  const i = argv.indexOf("--port");
  const port = i >= 0 ? Number(argv[i + 1]) : 8787;
  const m = argv.indexOf("--mode");
  const config = loadConfig(m >= 0 ? { mode: argv[m + 1] } : {});
  const key = resolveKey(config);
  if (!key && config.mode !== "off") {
    process.stderr.write("jev-effort serve: no Jev key. Run `jev-effort setup`.\n");
    return 1;
  }
  const store = new ConversationStore(STATE_DIR);
  store.prune();
  const proxy = createProxy({
    upstream: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    mode: config.mode,
    policy: createPolicy({
      config,
      jev: key ? new JevClient({ key: key.key, provider: key.provider, timeoutMs: config.jevTimeoutMs }) : null,
      store,
    }),
    logger: createLogger(LOG_DIR),
  });
  const bound = await proxy.listen(port);
  const extra = Object.entries(passthroughEnv({ upstream: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", env: {} }))
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  process.stderr.write(
    `jev-effort ${config.mode} proxy listening on http://127.0.0.1:${bound}\n` +
      `Start Claude Code with: ${extra}ANTHROPIC_BASE_URL=http://127.0.0.1:${bound} claude\n` +
      (extra ? "(The first variables keep MCP tool search and tool streaming on; Claude Code turns them off behind any proxy.)\n" : "") +
      "Ctrl+C to stop.\n",
  );
  await new Promise((resolve) => process.once("SIGINT", resolve));
  await proxy.close();
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "setup":
      return (await import("./setup.mjs")).setup(rest);
    case "stats":
      return (await import("./stats.mjs")).stats(rest);
    case "bench":
      return (await import("./bench.mjs")).bench(rest);
    case "doctor":
      return (await import("./doctor.mjs")).doctor(rest);
    case "serve":
      return serve(rest);
    case "help":
    case "--help":
    case "-h":
      if (cmd !== "help" && rest.length) break;
      process.stdout.write(HELP);
      return 0;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
  }
  return launch(argv);
}
