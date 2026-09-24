// `jev-effort stats`: what jev-effort did (or, in shadow mode, would have done), from the
// local logs. Logs hold counts, ids and effort choices only, never prompt or code content.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { EFFORTS, TESTED_CLAUDE_CODE, VERSION } from "./constants.mjs";
import { JEV_INPUT_PRICE, PRICES_CHECKED, requestCost } from "./pricing.mjs";

// Share of hidden thinking removed when Jev chose effort in `jev-effort bench`: at a `high`
// ceiling (docs/results/2026-09-23-opus-5-5-high.json: 1,450 → 787 thinking tokens) and at a
// `max` ceiling (2026-09-23-opus-5-5-max.json: 64,899 → 954). Savings are shown as the range.
export const BENCH_THINKING_CUT = 0.46;
export const BENCH_MAX_THINKING_CUT = 0.985;

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
  const estimateHigh = ceiling * BENCH_MAX_THINKING_CUT;
  const extraStep = sum(steps, (r) => (context(r) * (requestCost(r)?.readPrice ?? 0)) / 1e6) / steps.length;
  return {
    steps: steps.length,
    lowered: lowered.length,
    ceiling,
    estimate,
    jevCost,
    net: estimate - jevCost,
    estimateHigh,
    netHigh: estimateHigh - jevCost,
    // Shares of the period's total spend.
    ceilingShare: totalSpend ? ceiling / totalSpend : null,
    estimateShare: totalSpend ? estimate / totalSpend : null,
    netShare: totalSpend ? (estimate - jevCost) / totalSpend : null,
    avgContext: Math.round(sum(steps, context) / steps.length),
    extraStep,
    stepsEquivalent: extraStep ? (estimate - jevCost) / extraStep : null,
    stepsEquivalentHigh: extraStep ? (estimateHigh - jevCost) / extraStep : null,
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

// ---------- presentation ----------

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const usd = (n) => (Math.abs(n) >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const share = (x, total) => (total ? `${Math.round((100 * x) / total)}%` : "–");
// Spend shares keep a decimal: small categories like thinking are the point of the table.
const share1 = (x, total) => (total ? `${((100 * x) / total).toFixed(1)}%` : "–");
const pct1 = (x) => `${(100 * x).toFixed(1)}%`;
const mins = (ms) => (ms >= 60e3 ? `${(ms / 60e3).toFixed(1)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`);
const when = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${iso.slice(11, 16)}`;
};
const steps = (n) => (n < 10 ? n.toFixed(0) : Math.round(n));
const bar = (x, total, width = 20) => "█".repeat(total ? Math.round((width * x) / total) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Left/right-aligned columns; `align` is a string of "l"/"r" per column.
function table(rows, align, indent = "  ") {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map(
    (r) =>
      indent +
      r
        .map((cell, i) => (align[i] === "r" ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i])))
        .join("   ")
        .trimEnd(),
  );
}

function spendRows(m) {
  return [
    ["Re-reading cached context", m.read],
    ["Writing to the cache", m.write],
    ["Hidden thinking", m.thinking],
    ["Visible output", m.visibleOutput],
    ["Uncached input", m.input],
  ];
}

function verdict(s) {
  const v = s.savings;
  if (v) {
    const lowEq = v.stepsEquivalent;
    const highEq = v.stepsEquivalentHigh;
    return {
      saving: `${usd(v.net)} – ${usd(v.netHigh)}`,
      share: `${pct1(v.netShare)} – ${pct1(v.netHigh / (s.spend.total || 1))} of your spend`,
      breakEven:
        lowEq > 0
          ? `lost if lower effort makes Claude take ${steps(lowEq)}–${steps(highEq)} more steps (${share(lowEq, v.steps)}–${share(highEq, v.steps)})`
          : "Jev's own cost is more than the thinking it would remove",
      basis: `${plural(v.steps, "shadow step")}, ${v.lowered} of which Jev would lower`,
      jevCost: usd(v.jevCost),
    };
  }
  return null;
}

export function formatSummary(s, { share: asMarkdown = false } = {}) {
  if (!s.requests) return "No jev-effort activity logged yet. Run `npx jev-effort --jev-shadow` and come back.\n";
  return asMarkdown ? formatMarkdown(s) : formatTerminal(s);
}

function formatTerminal(s) {
  const L = [];
  const m = s.spend;
  const mode = s.applySteps && s.shadowSteps ? `${s.applySteps} applied, ${s.shadowSteps} in shadow mode` : s.shadowSteps ? "all in shadow mode" : "all applied";
  L.push(`jev-effort · ${when(s.period.from)} – ${when(s.period.to)} UTC · ${plural(s.perSession.length, "session")} · ${s.managedSteps} steps (${mode})`);

  L.push("", "WOULD JEV SAVE YOU MONEY?");
  const v = verdict(s);
  if (v) {
    L.push(
      ...table(
        [
          ["Estimated saving", `${v.saving}  (${v.share})`],
          ["Break-even", v.breakEven],
          ["Jev's own cost", `${v.jevCost}, already subtracted`],
        ],
        "ll",
      ),
    );
    L.push(`  Based on ${v.basis}. The range applies the thinking cuts`, "  `jev-effort bench` measured at high (46%) and max (98.5%).");
  } else {
    L.push(
      "  Not from these logs: on applied steps the thinking was already reduced, so there's",
      "  nothing to compare. Run `npx jev-effort --jev-shadow` for an estimate, or",
      "  `npx jev-effort bench` for a controlled comparison.",
    );
  }

  if (m.total > 0) {
    L.push("", `WHERE YOUR SPEND WENT${usd(m.total).padStart(55)}`);
    L.push(
      ...table(
        spendRows(m).map(([name, x]) => [name, usd(x), share1(x, m.total), bar(x, m.total) + (name === "Hidden thinking" ? "  ← what effort changes" : "")]),
        "lrrl",
      ),
    );
    L.push("  Claude API list prices; on a subscription, what the same usage would cost via the API.");
    if (m.ttlAssumed) L.push(`  (${plural(m.ttlAssumed, "older request")} didn't record their cache lifetime; priced as 1-hour writes.)`);
    if (m.unpriced) L.push(`  (${plural(m.unpriced, "request")} on models without a known price left out.)`);
  }

  L.push("", "EFFORT");
  L.push(...table([["", "Your setting", "Jev's pick"], ...EFFORTS.map((e) => [e, s.sessionMix[e], s.jevMix[e]])], "lrr"));
  L.push(`  Jev would lower effort on ${s.lowered} of ${s.managedSteps} steps (${share(s.lowered, s.managedSteps)})${s.raised ? ` and raise it on ${s.raised}` : ""}.`);

  if (s.perSession.length) {
    const shown = s.perSession.slice(-10);
    L.push("", "SESSIONS");
    L.push(
      ...table(
        [
          ["Started (UTC)", "Effort", "Steps", "Avg context", "Spend", "Thinking", "Jev lowers"],
          ...shown.map((x) => [when(x.start), x.effort, x.steps, k(x.avgContext), usd(x.spend), share1(x.thinkingShare, 1), share(x.lowered, 1)]),
        ],
        "llrrrrr",
      ),
    );
    if (s.perSession.length > shown.length) L.push(`  …and ${s.perSession.length - shown.length} earlier`);
    L.push("  Thinking = hidden thinking's share of that session's spend.");
  }

  L.push("", "HEALTH");
  const errors = s.jev.errors.length ? s.jev.errors.map(([c, n]) => `${n} ${c}`).join(", ") : "no errors";
  const waiting = [
    s.jev.addedMs ? `${mins(s.jev.addedMs)} added in apply mode` : null,
    s.jev.wouldAddMs ? `${s.jev.addedMs ? "" : "none so far; "}applying Jev would add about ${mins(s.jev.wouldAddMs)}` : null,
  ].filter(Boolean);
  const p = s.problems;
  const problems = [
    p.injectionRejected && plural(p.injectionRejected, "rewrite") + " rejected by the API (sent unmodified instead)",
    p.policyErrors && plural(p.policyErrors, "internal error") + " (request sent unmodified)",
    p.proxyErrors && plural(p.proxyErrors, "proxy error"),
    p.apiErrors && plural(p.apiErrors, "other API error"),
  ].filter(Boolean);
  L.push(
    ...table(
      [
        ["Prompt cache", `${s.cache.hitRate == null ? "–" : pct1(s.cache.hitRate)} hit rate, ${s.cache.breaks} unexpected misses in ${s.cache.checked} checks`],
        ["Jev", s.jev.calls ? `${plural(s.jev.calls, "call")}, ${s.jev.p50Ms} ms typical, ${s.jev.p95Ms} ms slowest 5%, ${errors}` : "not called"],
        ...(waiting.length ? [["Waiting", waiting.join("; ")]] : []),
        ...(s.rateLimits ? [["Rate limits", `${s.rateLimits} from Claude's API, passed through unchanged`]] : []),
        ...(problems.length ? [["Problems", problems.join("; ")]] : []),
      ],
      "ll",
    ),
  );
  return L.join("\n") + "\n";
}

function formatMarkdown(s) {
  const m = s.spend;
  const v = verdict(s);
  const L = [
    `### jev-effort results (${VERSION})`,
    "",
    `${when(s.period.from)} – ${when(s.period.to)} UTC · ${plural(s.perSession.length, "session")} · ${s.managedSteps} steps`,
    "",
    v
      ? `**Would Jev save money?** Estimated saving ${v.saving} (${v.share}), from ${v.basis}. Break-even: ${v.breakEven}.`
      : "**Would Jev save money?** No shadow-mode data in this period.",
  ];
  if (m.total > 0) {
    L.push("", "| Where the spend went | Amount | Share |", "| --- | ---: | ---: |");
    for (const [name, x] of spendRows(m)) L.push(`| ${name} | ${usd(x)} | ${share1(x, m.total)} |`);
    L.push(`| **Total** | **${usd(m.total)}** | |`);
  }
  L.push("", "| Effort | Claude Code's setting | Jev's pick |", "| --- | ---: | ---: |");
  for (const e of EFFORTS) L.push(`| ${e} | ${s.sessionMix[e]} | ${s.jevMix[e]} |`);
  if (s.perSession.length) {
    L.push("", "| Session | Effort | Steps | Avg context | Spend | Thinking share | Jev lowers |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    s.perSession.forEach((x, i) => L.push(`| ${i + 1} | ${x.effort} | ${x.steps} | ${k(x.avgContext)} | ${usd(x.spend)} | ${share1(x.thinkingShare, 1)} | ${share(x.lowered, 1)} |`));
  }
  L.push(
    "",
    `- Prompt cache: ${s.cache.hitRate == null ? "–" : pct1(s.cache.hitRate)} hit rate, ${s.cache.breaks} unexpected misses in ${s.cache.checked} checks`,
    `- Jev: ${s.jev.calls} calls, ${s.jev.p50Ms ?? "–"} ms median, ${s.jev.p95Ms ?? "–"} ms p95`,
    `- Claude Code ${TESTED_CLAUDE_CODE}-era logs; API list prices`,
  );
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
