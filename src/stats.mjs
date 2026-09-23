// `jev-effort stats`: what jev-effort did (or, in shadow mode, would have done), from the
// local logs. Logs hold counts, ids and effort choices only, never prompt or code content.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { EFFORTS, TESTED_CLAUDE_CODE, VERSION } from "./constants.mjs";

export function parseSince(value, now = Date.now()) {
  if (!value || value === "all") return 0;
  const m = /^(\d+)([hdw])$/.exec(value);
  if (!m) throw new Error(`--since takes a duration like 12h, 7d, 2w, or "all" (got ${value})`);
  return now - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
}

export function readRecords(dir = LOG_DIR, sinceMs = 0) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  const records = [];
  for (const f of files.sort()) {
    if (f.slice(0, 10) < sinceDay) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (Date.parse(r.t) >= sinceMs) records.push(r);
      } catch {
        // Skip a torn line.
      }
    }
  }
  return records;
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// A request that should have read the previous request's whole prefix from cache but didn't.
// Only checked for consecutive steps of one conversation within the 5-minute cache TTL.
export function cacheBreaks(records) {
  const byConv = new Map();
  for (const r of records) if (r.conv && r.usage && r.status === 200) (byConv.get(r.conv) ?? byConv.set(r.conv, []).get(r.conv)).push(r);
  let breaks = 0;
  let checked = 0;
  for (const rs of byConv.values()) {
    rs.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    for (let i = 1; i < rs.length; i++) {
      const prev = rs[i - 1];
      const cur = rs[i];
      if (cur.messages <= prev.messages || Date.parse(cur.t) - Date.parse(prev.t) > 5 * 60e3) continue;
      const expected = prev.usage.cacheRead + prev.usage.cacheWrite;
      if (expected < 2048) continue;
      checked++;
      if (cur.usage.cacheRead < expected * 0.9) breaks++;
    }
  }
  return { breaks, checked };
}

export function summarize(records) {
  const sum = (rs, f) => rs.reduce((n, r) => n + (f(r) ?? 0), 0);
  const withUsage = records.filter((r) => r.usage);
  const managed = records.filter((r) => r.managed);
  const byMode = (mode) => managed.filter((r) => r.mode === mode);
  const decisions = managed.filter((r) => r.source !== "retry");
  const jevCalls = decisions.filter((r) => r.source === "jev");
  const jevMs = jevCalls.map((r) => r.jevMs).filter(Number.isFinite);
  const mix = (rs, field) => Object.fromEntries(EFFORTS.map((e) => [e, rs.filter((r) => r[field] === e).length]));
  const read = sum(withUsage, (r) => r.usage.cacheRead);
  const write = sum(withUsage, (r) => r.usage.cacheWrite);
  const input = sum(withUsage, (r) => r.usage.input);
  const lowered = (rs) => rs.filter((r) => EFFORTS.indexOf(r.decidedEffort) < EFFORTS.indexOf(r.sessionEffort)).length;
  const raised = (rs) => rs.filter((r) => EFFORTS.indexOf(r.decidedEffort) > EFFORTS.indexOf(r.sessionEffort)).length;
  const thinkingRecords = withUsage.filter((r) => r.usage.thinking != null);
  const thinking = thinkingRecords.length
    ? { tokens: sum(thinkingRecords, (r) => r.usage.thinking), share: sum(thinkingRecords, (r) => r.usage.thinking) / Math.max(1, sum(thinkingRecords, (r) => r.usage.output)) }
    : null;
  const outPerStep = (rs) => {
    const u = rs.filter((r) => r.usage);
    return u.length ? Math.round(sum(u, (r) => r.usage.output) / u.length) : null;
  };
  const days = new Set(records.map((r) => r.t.slice(0, 10)));
  return {
    period: records.length ? { from: records[0].t, to: records.at(-1).t, days: days.size } : null,
    sessions: new Set(records.map((r) => r.session).filter(Boolean)).size,
    requests: records.length,
    managedSteps: decisions.length,
    applySteps: byMode("apply").filter((r) => r.source !== "retry").length,
    shadowSteps: byMode("shadow").filter((r) => r.source !== "retry").length,
    sessionMix: mix(decisions, "sessionEffort"),
    jevMix: mix(decisions, "decidedEffort"),
    lowered: lowered(decisions),
    raised: raised(decisions),
    sources: Object.fromEntries(["jev", "lease", "range", "fallback", "retry"].map((s) => [s, managed.filter((r) => r.source === s).length])),
    jev: {
      calls: jevCalls.length,
      p50Ms: quantile(jevMs, 0.5),
      p95Ms: quantile(jevMs, 0.95),
      inputTokens: sum(jevCalls, (r) => r.jevInputTokens),
      costUsd: jevCalls.some((r) => r.jevCost != null) ? sum(jevCalls, (r) => Number(r.jevCost)) : null,
      errors: Object.entries(
        managed.filter((r) => r.jevError).reduce((m, r) => ((m[r.jevError] = (m[r.jevError] ?? 0) + 1), m), {}),
      ),
    },
    cache: { read, write, uncached: input, hitRate: read + write + input ? read / (read + write + input) : null, ...cacheBreaks(records) },
    outputPerStep: { apply: outPerStep(byMode("apply")), shadow: outPerStep(byMode("shadow")) },
    output: { tokens: sum(withUsage, (r) => r.usage.output), thinking },
    problems: {
      injectionRejected: records.filter((r) => r.injectionRejected).length,
      policyErrors: records.filter((r) => r.policyError).length,
      proxyErrors: records.filter((r) => r.proxyError).length,
      apiErrors: records.filter((r) => r.status >= 400 || r.apiError).length,
    },
  };
}

function mixLine(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  return EFFORTS.filter((e) => mix[e]).map((e) => `${e} ${pct(mix[e], total)}`).join(" · ") || "none";
}

export function formatSummary(s, { share = false } = {}) {
  if (!s.requests) return "No jev-effort activity logged yet. Run `jev-effort` (or `jev-effort --jev-shadow`) and come back.\n";
  const L = [];
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
  const period = `${s.period.from.slice(0, 16).replace("T", " ")} to ${s.period.to.slice(0, 16).replace("T", " ")} UTC`;
  if (share) {
    L.push(`### jev-effort ${VERSION} results`, "", `- Tested Claude Code release: ${TESTED_CLAUDE_CODE}; ${s.period.days} day(s), ${s.sessions} session(s)`);
  } else L.push(`jev-effort activity, ${period}`, `${s.sessions} sessions · ${s.requests} API requests · ${s.managedSteps} managed steps`, "");
  const b = share ? "- " : "  ";
  L.push(`${share ? "" : "Effort\n"}${b}Claude Code's setting: ${mixLine(s.sessionMix)}`);
  L.push(`${b}Jev's pick:            ${mixLine(s.jevMix)}`);
  L.push(`${b}Jev lowered effort on ${pct(s.lowered, s.managedSteps)} of steps, raised it on ${pct(s.raised, s.managedSteps)}`);
  L.push(`${b}Steps: ${s.applySteps} applied, ${s.shadowSteps} shadow (logged only)`);
  if (!share) L.push("", "Jev");
  const ms = s.jev.p50Ms != null ? `, ${s.jev.p50Ms} ms median / ${s.jev.p95Ms} ms p95` : "";
  const reuse = s.managedSteps ? `; ${pct(s.sources.lease, s.managedSteps)} of steps reused a lease` : "";
  L.push(`${b}${s.jev.calls} calls${ms}${reuse}`);
  L.push(`${b}${k(s.jev.inputTokens)} Jev input tokens${s.jev.costUsd != null ? `, $${s.jev.costUsd.toFixed(4)} reported` : ""}`);
  if (s.jev.errors.length) L.push(`${b}errors (fell back to Claude Code's effort): ${s.jev.errors.map(([c, n]) => `${c} ${n}`).join(", ")}`);
  if (!share) L.push("", "Prompt cache");
  L.push(`${b}hit rate ${s.cache.hitRate == null ? "n/a" : pct(s.cache.read, s.cache.read + s.cache.write + s.cache.uncached)} (${k(s.cache.read)} read, ${k(s.cache.write)} written, ${k(s.cache.uncached)} uncached)`);
  L.push(`${b}unexpected cache misses: ${s.cache.breaks} of ${s.cache.checked} checked steps`);
  if (!share) L.push("", "Output");
  const th = s.output.thinking;
  L.push(
    `${b}${k(s.output.tokens)} output tokens` +
      (th ? `, of which ${pct(th.tokens, s.output.tokens)} hidden thinking. Effort mostly changes thinking, so this share bounds the savings.` : ""),
  );
  if (s.outputPerStep.apply != null || s.outputPerStep.shadow != null) {
    if (!share) L.push("", "Output tokens per managed step (not a controlled comparison; use `jev-effort bench`)");
    else L.push("- Output tokens per managed step (uncontrolled):");
    if (s.outputPerStep.apply != null) L.push(`${b}${share ? "  " : ""}with Jev's effort: ${s.outputPerStep.apply}`);
    if (s.outputPerStep.shadow != null) L.push(`${b}${share ? "  " : ""}at Claude Code's effort (shadow): ${s.outputPerStep.shadow}`);
  }
  const p = s.problems;
  const probs = [
    p.injectionRejected && `${p.injectionRejected} rewrites rejected by the API (retried unmodified)`,
    p.policyErrors && `${p.policyErrors} internal errors (request forwarded unmodified)`,
    p.proxyErrors && `${p.proxyErrors} proxy errors`,
    p.apiErrors && `${p.apiErrors} API error responses`,
  ].filter(Boolean);
  if (probs.length) L.push(share ? "- Problems: " + probs.join("; ") : "\nProblems\n  " + probs.join("\n  "));
  return L.join("\n") + "\n";
}

export async function stats(argv, { stdout = process.stdout, dir = LOG_DIR } = {}) {
  let since = "7d";
  const i = argv.indexOf("--since");
  if (i >= 0) since = argv[i + 1];
  let records;
  try {
    records = readRecords(dir, parseSince(since));
  } catch (e) {
    stdout.write(`jev-effort stats: ${e.message}\n`);
    return 2;
  }
  const s = summarize(records);
  if (argv.includes("--json")) stdout.write(JSON.stringify(s, null, 2) + "\n");
  else stdout.write(formatSummary(s, { share: argv.includes("--share") }));
  return 0;
}
