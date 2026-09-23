// `jev-effort bench`: a controlled comparison. Each task runs headless (`claude -p`) twice from
// the same starting files: once at a fixed effort, once with Jev choosing per step under that
// same effort as the ceiling. A hidden check decides pass/fail. Costs come from Claude Code's
// own `total_cost_usd`.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, loadConfig, resolveKey } from "./config.mjs";
import { EFFORTS, VERSION, modelInfo } from "./constants.mjs";
import { bypassReason, claudeSettingsEnv, passthroughEnv } from "./environment.mjs";
import { JevClient } from "./jev.mjs";
import { createPolicy } from "./policy.mjs";
import { createProxy, memoryLogger } from "./proxy.mjs";
import { ConversationStore } from "./store.mjs";

export const TASKS_DIR = fileURLToPath(new URL("../bench/tasks/", import.meta.url));
const DEFAULT_TOOLS = "Read,Edit,Write,Glob,Grep,Bash(node test.js)";
// Variables a parent Claude Code session sets that would confuse a nested headless run.
const NESTED_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "JEV_EFFORT_ACTIVE",
];

export function listTasks(dir = TASKS_DIR) {
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, "task.json")))
    .sort()
    .map((name) => ({ name, dir: join(dir, name), ...JSON.parse(readFileSync(join(dir, name, "task.json"), "utf8")) }));
}

function parseBenchArgs(argv) {
  const opts = { runs: 1, effort: "high", model: "claude-opus-5-5", arms: ["baseline", "jev"], timeoutSec: 900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--tasks") opts.tasks = v().split(",");
    else if (a === "--runs") opts.runs = Number(v());
    else if (a === "--effort") opts.effort = v();
    else if (a === "--model") opts.model = v();
    else if (a === "--arms") opts.arms = v().split(",");
    else if (a === "--timeout") opts.timeoutSec = Number(v());
    else if (a === "--keep") opts.keep = true;
    else if (a === "--list") opts.list = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!EFFORTS.includes(opts.effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  if (!modelInfo(opts.model)) throw new Error(`--model must be a model jev-effort manages (got ${opts.model})`);
  if (!opts.arms.length || opts.arms.some((a) => !["baseline", "jev"].includes(a))) throw new Error("--arms takes baseline,jev");
  return opts;
}

function runClaudeHeadless({ claudePath, args, cwd, env, timeoutSec }) {
  return new Promise((resolve) => {
    const child = spawn(claudePath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: e.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

function claudeArgs(prompt, opts, tools) {
  return ["-p", prompt, "--model", opts.model, "--effort", opts.effort, "--strict-mcp-config", "--allowedTools", tools, "--output-format", "json"];
}

function headlessEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of NESTED_ENV) delete env[k];
  return env;
}

// Claude Code's system prompt and tools (~30K tokens) are identical across runs. Without a
// warm-up, whichever arm runs first pays to write them to the cache and looks more expensive.
async function warmUp(opts, config) {
  const work = mkdtempSync(join(tmpdir(), "jev-bench-warmup-"));
  await runClaudeHeadless({
    claudePath: config.claudePath,
    cwd: work,
    env: headlessEnv(),
    timeoutSec: 120,
    args: claudeArgs("Reply with the single word OK.", opts, DEFAULT_TOOLS),
  });
  rmSync(work, { recursive: true, force: true });
}

async function runArm({ task, arm, opts, config, key }) {
  const work = mkdtempSync(join(tmpdir(), `jev-bench-${task.name}-`));
  cpSync(join(task.dir, "fixture"), work, { recursive: true });
  const logger = memoryLogger();
  const policy = createPolicy({
    config: { ...config, ceiling: "session" },
    jev: arm === "jev" ? new JevClient({ key: key.key, provider: key.provider, timeoutMs: config.jevTimeoutMs }) : null,
    store: new ConversationStore(null),
  });
  const proxy = createProxy({
    upstream: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    mode: arm === "jev" ? "apply" : "off",
    policy,
    logger,
    tag: `${task.name}/${arm}`,
  });
  const port = await proxy.listen(0);
  const upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const env = headlessEnv({ ...passthroughEnv({ upstream, settingsEnv: claudeSettingsEnv() }), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
  const started = Date.now();
  const res = await runClaudeHeadless({
    claudePath: config.claudePath,
    cwd: work,
    env,
    timeoutSec: opts.timeoutSec,
    args: claudeArgs(task.prompt, opts, task.allowedTools ?? DEFAULT_TOOLS),
  });
  await proxy.close();
  let result = null;
  try {
    result = JSON.parse(res.stdout);
  } catch {
    // Reported below as an error run.
  }
  const check = spawnSync(process.execPath, [join(task.dir, "check.mjs"), work], { encoding: "utf8", timeout: 60_000 });
  const records = logger.records.filter((r) => r.managed || r.usage);
  const steps = records.filter((r) => r.managed && r.source !== "retry");
  const out = {
    task: task.name,
    arm,
    pass: check.status === 0,
    failure: check.status === 0 ? undefined : (check.stderr || check.stdout || "").trim().split("\n").slice(0, 3).join(" | "),
    costUsd: result?.total_cost_usd ?? null,
    outputTokens: result?.usage?.output_tokens ?? null,
    thinkingTokens: result?.usage?.output_tokens_details?.thinking_tokens ?? null,
    cacheRead: result?.usage?.cache_read_input_tokens ?? null,
    cacheWrite: result?.usage?.cache_creation_input_tokens ?? null,
    turns: result?.num_turns ?? null,
    wallMs: Date.now() - started,
    claudeError: res.code !== 0 || !result || result.is_error ? (res.timedOut ? "timeout" : (result?.subtype ?? res.stderr.trim().slice(0, 200)) || `exit ${res.code}`) : undefined,
    efforts: Object.fromEntries(EFFORTS.map((e) => [e, steps.filter((r) => r.appliedEffort === e).length]).filter(([, n]) => n)),
    jevCalls: steps.filter((r) => r.source === "jev").length,
    jevFallbacks: steps.filter((r) => r.source === "fallback").length,
    jevMs: steps.filter((r) => r.source === "jev").reduce((n, r) => n + (r.jevMs ?? 0), 0),
    rejected: records.filter((r) => r.injectionRejected).length,
  };
  if (opts.keep) out.workdir = work;
  else rmSync(work, { recursive: true, force: true });
  return out;
}

const money = (n) => (n == null ? "?" : `$${n.toFixed(3)}`);
const sumOf = (rs, f) => rs.reduce((n, r) => n + (r[f] ?? 0), 0);

export function formatBench(report) {
  const { results, opts } = report;
  const L = [
    `### jev-effort bench: ${opts.model}, ceiling ${opts.effort}, ${opts.runs} run(s) per task`,
    "",
    "| Task | Pass (fixed / Jev) | Cost (fixed / Jev) | Output tokens (fixed / Jev) | Thinking tokens (fixed / Jev) | Jev's effort mix |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const tasks = [...new Set(results.map((r) => r.task))];
  for (const t of tasks) {
    const b = results.filter((r) => r.task === t && r.arm === "baseline");
    const j = results.filter((r) => r.task === t && r.arm === "jev");
    const mix = {};
    for (const r of j) for (const [e, n] of Object.entries(r.efforts)) mix[e] = (mix[e] ?? 0) + n;
    const mixText = Object.entries(mix).map(([e, n]) => `${e} ${n}`).join(", ") || "-";
    L.push(
      `| ${t} | ${b.filter((r) => r.pass).length}/${b.length} / ${j.filter((r) => r.pass).length}/${j.length} | ${money(sumOf(b, "costUsd"))} / ${money(sumOf(j, "costUsd"))} | ${sumOf(b, "outputTokens")} / ${sumOf(j, "outputTokens")} | ${sumOf(b, "thinkingTokens")} / ${sumOf(j, "thinkingTokens")} | ${mixText} |`,
    );
  }
  const B = results.filter((r) => r.arm === "baseline");
  const J = results.filter((r) => r.arm === "jev");
  if (B.length && J.length) {
    const cb = sumOf(B, "costUsd");
    const cj = sumOf(J, "costUsd");
    const ob = sumOf(B, "outputTokens");
    const oj = sumOf(J, "outputTokens");
    const tb = sumOf(B, "thinkingTokens");
    const tj = sumOf(J, "thinkingTokens");
    const delta = (a, b) => (a ? `${(((b - a) / a) * 100).toFixed(1)}%` : "n/a");
    L.push(
      `| **Total** | ${B.filter((r) => r.pass).length}/${B.length} / ${J.filter((r) => r.pass).length}/${J.length} | ${money(cb)} / ${money(cj)} (${delta(cb, cj)}) | ${ob} / ${oj} (${delta(ob, oj)}) | ${tb} / ${tj} (${delta(tb, tj)}) | ${sumOf(J, "jevCalls")} Jev calls |`,
    );
  }
  const errors = results.filter((r) => r.claudeError || r.rejected);
  if (errors.length) L.push("", ...errors.map((r) => `- ${r.task}/${r.arm}: ${r.claudeError ?? ""}${r.rejected ? ` ${r.rejected} rewrite(s) rejected` : ""}`));
  L.push(
    "",
    `Output tokens include hidden thinking and are the direct measure of effort. Costs are Claude Code's own`,
    `estimates (total_cost_usd) and also move with cache timing. Single runs are noisy; use --runs 3 or more.`,
    `jev-effort ${VERSION}, ${report.date.slice(0, 10)}.`,
  );
  return L.join("\n") + "\n";
}

export async function bench(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseBenchArgs(argv);
  } catch (e) {
    stderr.write(`jev-effort bench: ${e.message}\n`);
    return 2;
  }
  const all = listTasks();
  if (opts.list) {
    for (const t of all) stdout.write(`${t.name.padEnd(18)}${t.description}\n`);
    return 0;
  }
  const tasks = opts.tasks ? all.filter((t) => opts.tasks.includes(t.name)) : all;
  if (opts.tasks && tasks.length !== opts.tasks.length) {
    stderr.write(`jev-effort bench: unknown task. Available: ${all.map((t) => t.name).join(", ")}\n`);
    return 2;
  }
  const config = loadConfig();
  const bypass = bypassReason({ ...process.env, JEV_EFFORT_ACTIVE: undefined }, claudeSettingsEnv());
  if (bypass) {
    stderr.write(`jev-effort bench: can't run here: ${bypass}.\n`);
    return 1;
  }
  const key = resolveKey(config);
  if (opts.arms.includes("jev") && !key) {
    stderr.write("jev-effort bench: the jev arm needs a Jev key. Run `jev-effort setup`.\n");
    return 1;
  }
  const total = tasks.length * opts.arms.length * opts.runs;
  stderr.write(
    `Running ${total} headless Claude Code sessions (${tasks.length} tasks × ${opts.arms.length} arms × ${opts.runs} runs) on ${opts.model}.\n` +
      "This uses your Claude usage or API credit. Ctrl+C to stop.\n\n",
  );

  const report = { version: VERSION, date: new Date().toISOString(), opts, results: [] };
  mkdirSync(BENCH_DIR, { recursive: true });
  const file = join(BENCH_DIR, `${report.date.replace(/[:.]/g, "-")}.json`);
  const save = () => writeFileSync(file, JSON.stringify(report, null, 2));
  stderr.write("Warming the prompt cache so neither arm pays for Claude Code's system prompt... ");
  await warmUp(opts, config);
  stderr.write("done\n");
  const results = report.results;
  let n = 0;
  for (let run = 0; run < opts.runs; run++) {
    for (const [i, task] of tasks.entries()) {
      // Alternate arm order so neither arm always runs first (and warms shared caches).
      const arms = (run + i) % 2 ? [...opts.arms].reverse() : opts.arms;
      for (const arm of arms) {
        stderr.write(`[${++n}/${total}] ${task.name} (${arm}) ... `);
        const r = await runArm({ task, arm, opts, config, key });
        results.push(r);
        save();
        stderr.write(
          `${r.pass ? "pass" : "FAIL"} · ${money(r.costUsd)} · ${r.outputTokens ?? "?"} out · ${Math.round(r.wallMs / 1000)}s` +
            `${arm === "jev" ? ` · ${Object.entries(r.efforts).map(([e, c]) => `${e}×${c}`).join(" ")}` : ""}` +
            `${r.claudeError ? ` · error: ${r.claudeError}` : ""}\n`,
        );
      }
    }
  }

  stdout.write("\n" + formatBench(report));
  stderr.write(`\nFull results: ${file}\n`);
  return 0;
}
