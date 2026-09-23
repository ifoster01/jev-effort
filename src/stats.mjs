// `jev-effort stats`: what jev-effort did (or, in shadow mode, would have done), from the
// local logs. Logs hold counts, ids and effort choices only, never prompt or code content.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { EFFORTS, TESTED_CLAUDE_CODE, VERSION } from "./constants.mjs";
import { JEV_INPUT_PRICE, PRICES_CHECKED, requestCost } from "./pricing.mjs";

// Share of hidden thinking removed when Jev chose effort in `jev-effort bench`
// (docs/results/2026-09-23-opus-5-5-high.json: 1,450 → 787 thinking tokens).
export const BENCH_THINKING_CUT = 0.46;

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
const sum = (rs, f) => rs.reduce((n, r) => n + (f(r) ?? 0), 0);
const rank = (e) => EFFORTS.indexOf(e);
const context = (r) => r.usage.cacheRead + r.usage.cacheWrite + r.usage.input;

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

const isRateLimit = (r) => r.status === 429 || r.status === 529 || ["rate_limit_error", "overloaded_error"].includes(r.apiError?.type);

// Where the money went, at API list prices.
export function spend(records) {
  const priced = records.map((r) => [r, requestCost(r)]).filter(([, c]) => c);
  const total = { read: 0, write: 0, input: 0, visibleOutput: 0, thinking: 0 };
  for (const [, c] of priced) for (const k of Object.keys(total)) total[k] += c[k];
  return {
    ...total,
    total: Object.values(total).reduce((a, b) => a + b, 0),
    ttlAssumed: priced.filter(([, c]) => c.ttlAssumed).length,
    unpriced: records.filter((r) => r.usage && !requestCost(r)).length,
  };
}

// What Jev would have saved, from shadow steps only: in apply mode the thinking was already
// reduced, so there's no "before" to compare against.
export function savings(records, totalSpend) {
  const steps = records.filter((r) => r.managed && r.mode === "shadow" && r.source !== "retry" && r.usage);
  if (!steps.length) return null;
  const lowered = steps.filter((r) => rank(r.decidedEffort) < rank(r.sessionEffort));
  const ceiling = sum(lowered, (r) => requestCost(r)?.thinking);
  const jevCalls = steps.filter((r) => r.source === "jev");
  const reported = jevCalls.filter((r) => r.jevCost != null);
  const jevCost =
    sum(reported, (r) => Number(r.jevCost)) +
    sum(jevCalls.filter((r) => r.jevCost == null), (r) => ((r.jevInputTokens ?? 0) * JEV_INPUT_PRICE) / 1e6);
  const estimate = ceiling * BENCH_THINKING_CUT;
  const extraStep = sum(steps, (r) => (context(r) * (requestCost(r)?.readPrice ?? 0)) / 1e6) / steps.length;
  return {
    steps: steps.length,
    lowered: lowered.length,
    ceiling,
    estimate,
    jevCost,
    net: estimate - jevCost,
    // Shares of the period's total spend.
    ceilingShare: totalSpend ? ceiling / totalSpend : null,
    estimateShare: totalSpend ? estimate / totalSpend : null,
    netShare: totalSpend ? (estimate - jevCost) / totalSpend : null,
    avgContext: Math.round(sum(steps, context) / steps.length),
    extraStep,
    stepsEquivalent: extraStep ? (estimate - jevCost) / extraStep : null,
  };
}

export function perSession(records) {
  const by = new Map();
  for (const r of records) if (r.session && r.usage) (by.get(r.session) ?? by.set(r.session, []).get(r.session)).push(r);
  return [...by.entries()]
    .map(([id, rs]) => {
      const s = spend(rs);
      const managed = rs.filter((r) => r.managed && r.source !== "retry");
      return {
        id,
        start: rs[0].t,
        model: [...new Set(rs.map((r) => r.model))].join(","),
        effort: [...new Set(managed.map((r) => r.sessionEffort))].join("→") || "-",
        modes: [...new Set(managed.map((r) => r.mode))].join(",") || "-",
        steps: managed.length,
        avgContext: Math.round(sum(rs, context) / rs.length),
        spend: s.total,
        thinkingShare: s.total ? s.thinking / s.total : 0,
        lowered: managed.length ? managed.filter((r) => rank(r.decidedEffort) < rank(r.sessionEffort)).length / managed.length : 0,
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function summarize(records) {
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
  const thinkingRecords = withUsage.filter((r) => r.usage.thinking != null);
  const thinkingTokens = sum(thinkingRecords, (r) => r.usage.thinking);
  const outPerStep = (rs) => {
    const u = rs.filter((r) => r.usage);
    return u.length ? Math.round(sum(u, (r) => r.usage.output) / u.length) : null;
  };
  const money = spend(records);
  const days = new Set(records.map((r) => r.t.slice(0, 10)));
  const latency = (mode) => sum(jevCalls.filter((r) => r.mode === mode), (r) => r.jevMs);
  return {
    period: records.length ? { from: records[0].t, to: records.at(-1).t, days: days.size } : null,
    sessions: new Set(records.map((r) => r.session).filter(Boolean)).size,
    requests: records.length,
    managedSteps: decisions.length,
    applySteps: byMode("apply").filter((r) => r.source !== "retry").length,
    shadowSteps: byMode("shadow").filter((r) => r.source !== "retry").length,
    sessionMix: mix(decisions, "sessionEffort"),
    jevMix: mix(decisions, "decidedEffort"),
    lowered: decisions.filter((r) => rank(r.decidedEffort) < rank(r.sessionEffort)).length,
    raised: decisions.filter((r) => rank(r.decidedEffort) > rank(r.sessionEffort)).length,
    sources: Object.fromEntries(["jev", "lease", "range", "fallback", "retry"].map((s) => [s, managed.filter((r) => r.source === s).length])),
    jev: {
      calls: jevCalls.length,
      p50Ms: quantile(jevMs, 0.5),
      p95Ms: quantile(jevMs, 0.95),
      inputTokens: sum(jevCalls, (r) => r.jevInputTokens),
      costUsd: jevCalls.some((r) => r.jevCost != null) ? sum(jevCalls, (r) => Number(r.jevCost)) : null,
      addedMs: latency("apply"),
      wouldAddMs: latency("shadow"),
      errors: Object.entries(
        managed.filter((r) => r.jevError).reduce((m, r) => ((m[r.jevError] = (m[r.jevError] ?? 0) + 1), m), {}),
      ),
    },
    spend: money,
    savings: savings(records, money.total),
    perSession: perSession(records),
    cache: { read, write, uncached: input, hitRate: read + write + input ? read / (read + write + input) : null, ...cacheBreaks(records) },
    outputPerStep: { apply: outPerStep(byMode("apply")), shadow: outPerStep(byMode("shadow")) },
    output: {
      tokens: sum(withUsage, (r) => r.usage.output),
      thinking: thinkingRecords.length
        ? { tokens: thinkingTokens, share: thinkingTokens / Math.max(1, sum(thinkingRecords, (r) => r.usage.output)) }
        : null,
    },
    rateLimits: records.filter(isRateLimit).length,
    problems: {
      injectionRejected: records.filter((r) => r.injectionRejected).length,
      policyErrors: records.filter((r) => r.policyError).length,
      proxyErrors: records.filter((r) => r.proxyError).length,
      apiErrors: records.filter((r) => (r.status >= 400 || r.apiError) && !isRateLimit(r)).length,
    },
  };
}

function mixLine(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  return EFFORTS.filter((e) => mix[e]).map((e) => `${e} ${pct(mix[e], total)}`).join(" · ") || "none";
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const usd = (n) => (n >= 10 ? `$${n.toFixed(2)}` : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const secs = (ms) => (ms >= 60e3 ? `${(ms / 60e3).toFixed(1)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`);

export function formatSummary(s, { share = false } = {}) {
  if (!s.requests) return "No jev-effort activity logged yet. Run `jev-effort` (or `jev-effort --jev-shadow`) and come back.\n";
  const L = [];
  const b = share ? "- " : "  ";
  const section = (title) => L.push(share ? `\n**${title}**` : `\n${title}`);
  const period = `${s.period.from.slice(0, 16).replace("T", " ")} to ${s.period.to.slice(0, 16).replace("T", " ")} UTC`;
  if (share) L.push(`### jev-effort ${VERSION} results`, "", `Claude Code ${TESTED_CLAUDE_CODE}-era logs; ${s.period.days} day(s), ${s.sessions} session(s), ${s.managedSteps} managed steps.`);
  else L.push(`jev-effort activity, ${period}`, `${s.sessions} sessions · ${s.requests} API requests · ${s.managedSteps} managed steps`);

  section("Effort");
  L.push(`${b}Claude Code's setting: ${mixLine(s.sessionMix)}`);
  L.push(`${b}Jev's pick:            ${mixLine(s.jevMix)}`);
  L.push(`${b}Jev lowered effort on ${pct(s.lowered, s.managedSteps)} of steps, raised it on ${pct(s.raised, s.managedSteps)}`);
  L.push(`${b}Steps: ${s.applySteps} applied, ${s.shadowSteps} shadow (logged only)`);

  const m = s.spend;
  if (m.total > 0) {
    section(`Where the money goes (API list prices as of ${PRICES_CHECKED}; on a subscription these are API-equivalent)`);
    const parts = [
      ["cache writes", m.write],
      ["cache reads", m.read],
      ["visible output", m.visibleOutput],
      ["thinking", m.thinking],
      ["uncached input", m.input],
    ]
      .sort((a, b) => b[1] - a[1])
      .map(([name, v]) => `${name} ${pct(v, m.total)}`);
    L.push(`${b}${usd(m.total)} total: ${parts.join(" · ")}`);
    if (m.ttlAssumed) L.push(`${b}(${m.ttlAssumed} older requests didn't log their cache lifetime; priced as 1-hour writes)`);
    if (m.unpriced) L.push(`${b}(${m.unpriced} requests on models without a known price are left out)`);
  }

  const v = s.savings;
  section("What Jev could save");
  if (!v) {
    L.push(`${b}Needs shadow-mode data: run \`jev-effort --jev-shadow\`. (Applied steps can't show savings, because their`);
    L.push(`${b}thinking was already reduced; use \`jev-effort bench\` for a controlled comparison.)`);
  } else {
    const of = (x) => pct(x, m.total);
    L.push(`${b}From ${v.steps} shadow steps; Jev would lower effort on ${v.lowered}.`);
    L.push(`${b}Ceiling: ${usd(v.ceiling)} (${of(v.ceiling)} of spend) if all thinking on those steps disappeared.`);
    L.push(`${b}Estimate: ${usd(v.estimate)} (${of(v.estimate)}) at the ${Math.round(BENCH_THINKING_CUT * 100)}% thinking cut measured by \`jev-effort bench\`.`);
    L.push(`${b}Jev's own cost: ${usd(v.jevCost)}. Net: ${usd(v.net)} (${of(v.net)}).`);
    L.push(`${b}For scale: one extra step costs about ${usd(v.extraStep)} (re-reading ${k(v.avgContext)} tokens of context on average).`);
    if (v.stepsEquivalent != null)
      L.push(
        `${b}${v.stepsEquivalent <= 0 ? "No net saving to protect." : `The net saving is worth ${v.stepsEquivalent < 10 ? v.stepsEquivalent.toFixed(1) : Math.round(v.stepsEquivalent)} extra steps; if lower effort makes Claude take more steps than that, Jev costs you money.`}`,
      );
  }

  section("Jev");
  const ms = s.jev.p50Ms != null ? `, ${s.jev.p50Ms} ms median / ${s.jev.p95Ms} ms p95` : "";
  const reuse = s.managedSteps ? `; ${pct(s.sources.lease, s.managedSteps)} of steps reused a lease` : "";
  L.push(`${b}${s.jev.calls} calls${ms}${reuse}`);
  L.push(`${b}${k(s.jev.inputTokens)} Jev input tokens${s.jev.costUsd != null ? `, $${s.jev.costUsd.toFixed(4)} reported` : ""}`);
  if (s.jev.addedMs) L.push(`${b}Apply mode added ${secs(s.jev.addedMs)} of waiting before steps.`);
  if (s.jev.wouldAddMs) L.push(`${b}Apply mode would have added ${secs(s.jev.wouldAddMs)} of waiting to these shadow sessions.`);
  if (s.jev.errors.length) L.push(`${b}errors (fell back to Claude Code's effort): ${s.jev.errors.map(([c, n]) => `${c} ${n}`).join(", ")}`);

  if (s.perSession.length) {
    section("Sessions");
    if (share) {
      L.push("| # | Effort | Steps | Avg context | Spend | Thinking share of spend | Jev would lower |", "| --- | --- | --- | --- | --- | --- | --- |");
      s.perSession.forEach((x, i) => L.push(`| ${i + 1} | ${x.effort} | ${x.steps} | ${k(x.avgContext)} | ${usd(x.spend)} | ${pct(x.thinkingShare, 1)} | ${pct(x.lowered, 1)} |`));
    } else
      s.perSession.forEach((x, i) =>
        L.push(
          `${b}#${i + 1} ${x.id.slice(0, 8)}  ${x.effort.padEnd(12)} ${String(x.steps).padStart(4)} steps  ${k(x.avgContext).padStart(6)} ctx  ${usd(x.spend).padStart(7)}  thinking ${pct(x.thinkingShare, 1).padStart(5)} of spend  lowers ${pct(x.lowered, 1)}`,
        ),
      );
  }

  section("Prompt cache");
  L.push(`${b}hit rate ${s.cache.hitRate == null ? "n/a" : pct(s.cache.read, s.cache.read + s.cache.write + s.cache.uncached)} (${k(s.cache.read)} read, ${k(s.cache.write)} written, ${k(s.cache.uncached)} uncached)`);
  L.push(`${b}unexpected cache misses: ${s.cache.breaks} of ${s.cache.checked} checked steps`);

  section("Output");
  const th = s.output.thinking;
  L.push(`${b}${k(s.output.tokens)} output tokens${th ? `, ${pct(th.tokens, s.output.tokens)} of them hidden thinking` : ""}`);
  if (s.outputPerStep.apply != null) L.push(`${b}per managed step with Jev's effort: ${s.outputPerStep.apply}`);
  if (s.outputPerStep.shadow != null) L.push(`${b}per managed step at Claude Code's effort (shadow): ${s.outputPerStep.shadow}`);

  if (s.rateLimits) L.push(share ? `\n- Claude API rate limits (429/529, passed through): ${s.rateLimits}` : `\nRate limits\n  ${s.rateLimits} Claude API rate-limit or overload responses, passed through unchanged (not caused by jev-effort)`);
  const p = s.problems;
  const probs = [
    p.injectionRejected && `${p.injectionRejected} rewrites rejected by the API (retried unmodified)`,
    p.policyErrors && `${p.policyErrors} internal errors (request forwarded unmodified)`,
    p.proxyErrors && `${p.proxyErrors} proxy errors`,
    p.apiErrors && `${p.apiErrors} other API error responses`,
  ].filter(Boolean);
  if (probs.length) L.push(share ? `- Problems: ${probs.join("; ")}` : `\nProblems\n  ${probs.join("\n  ")}`);
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
