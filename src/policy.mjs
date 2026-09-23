// Decides the effort for each main-model step and, in apply mode, rewrites the request so
// that effort takes hold without disturbing the cached prefix.
//
// Claude Code already carries its own per-turn effort on a system message just after the
// prompt, and the latest effort setting in a request wins. So our marker is appended as the
// very last message, and every earlier marker is re-inserted where it was first placed.

import { createHash } from "node:crypto";
import { EFFORTS, effortRank, modelInfo } from "./constants.mjs";
import { buildJevState, countToolFailures, latestHumanPrompt } from "./jev-state.mjs";
import {
  applicableMarkers,
  conversationKey,
  insertMarkers,
  isEffortMarker,
  nextTurnSlot,
  prefixHashes,
} from "./markers.mjs";

export function allowedEfforts(floor, ceiling) {
  const lo = effortRank(floor);
  const hi = effortRank(ceiling);
  return lo > hi ? [ceiling] : EFFORTS.slice(lo, hi + 1);
}

function nearestAllowed(allowed, effort) {
  if (allowed.includes(effort)) return effort;
  return effortRank(effort) > effortRank(allowed.at(-1)) ? allowed.at(-1) : allowed[0];
}

const promptHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function createPolicy({ config, jev, store, now = Date.now }) {
  const leases = [1, 2, 5, 10].filter((n) => n <= config.maxLeaseSteps);

  // mode: "apply" rewrites the request; "shadow" only records what Jev would have chosen.
  async function evaluate(body, mode) {
    const info = modelInfo(body?.model);
    if (!info) return { managed: false, reason: "unsupported_model" };
    const original = body.messages;
    if (!Array.isArray(original) || nextTurnSlot(original) < 0) return { managed: false, reason: "not_a_turn" };
    const conv = conversationKey(body);
    return store.withLock(conv, () => decide(conv, body, original, info, mode));
  }

  async function decide(conv, body, original, info, mode) {
    const st = store.load(conv);
    const hashes = prefixHashes(original);
    const len = original.length;

    // What Claude Code asked for: its per-turn marker, else top-level, else the model default.
    const nativeIdx = original.findLastIndex(isEffortMarker);
    const sessionEffort =
      nativeIdx >= 0 ? original[nativeIdx].output_config.effort : (body.output_config?.effort ?? info.defaultEffort);

    // A marker already in this exact slot means this request is a retry; decide afresh.
    const markers = st.markers.filter((m) => !(m.at === len && m.hash === hashes[len]));
    const lastOurs = applicableMarkers(markers, hashes).at(-1);
    const current = mode === "apply" && lastOurs && lastOurs.at > nativeIdx ? lastOurs.effort : sessionEffort;

    const ceiling = config.ceiling === "session" ? sessionEffort : config.ceiling;
    const allowed = allowedEfforts(config.floor, EFFORTS.includes(ceiling) ? ceiling : "max");

    const retry = st.last && st.lastLen === len && st.lastHash === hashes[len];
    const prompt = promptHash(latestHumanPrompt(original));
    const failures = countToolFailures(original);
    const newToolFailures = Math.max(0, failures - (st.failures ?? 0));
    const resetReasons = [];
    if (prompt !== st.lastPrompt) resetReasons.push("new_user_input");
    if (newToolFailures) resetReasons.push("tool_failure");
    if (st.model && st.model !== body.model) resetReasons.push("model_change");
    if (st.sessionEffort && st.sessionEffort !== sessionEffort) resetReasons.push("manual_effort");
    Object.assign(st, { lastPrompt: prompt, failures, model: body.model, sessionEffort, lastLen: len, lastHash: hashes[len] });

    let decision;
    if (retry) {
      decision = { effort: nearestAllowed(allowed, st.last.effort), leaseSteps: st.last.leaseSteps, source: "retry" };
    } else {
      st.step += 1;
      if (resetReasons.length) st.leaseRemaining = 0;
      if (allowed.length === 1) {
        decision = { effort: allowed[0], leaseSteps: 1, source: "range" };
        st.leaseRemaining = 0;
      } else if (st.leaseRemaining > 0 && st.last && allowed.includes(st.last.effort)) {
        decision = { effort: st.last.effort, leaseSteps: st.last.leaseSteps, source: "lease" };
        st.leaseRemaining -= 1;
      } else {
        try {
          if (!jev) throw Object.assign(new Error("No Jev API key configured"), { category: "no_key" });
          const state = buildJevState({
            model: body.model,
            messages: original,
            step: st.step,
            previousEffort: current,
            newToolFailures,
            supportedEfforts: allowed,
          });
          decision = { ...(await jev.decide(state, leases)), source: "jev" };
          st.leaseRemaining = decision.leaseSteps - 1;
        } catch (e) {
          // Fail toward what Claude Code would have done anyway.
          decision = {
            effort: nearestAllowed(allowed, sessionEffort),
            leaseSteps: 1,
            source: "fallback",
            jevError: e.category ?? "error",
            jevErrorMessage: String(e.message).slice(0, 300),
          };
          st.leaseRemaining = 0;
        }
      }
      st.last = { effort: decision.effort, leaseSteps: decision.leaseSteps };
    }

    let out = body;
    let markerCount = 0;
    let markerAdded = false;
    if (mode === "apply") {
      if (decision.effort !== current) {
        markers.push({ at: len, hash: hashes[len], effort: decision.effort, t: now() });
        markerAdded = true;
      }
      st.markers = markers;
      const use = applicableMarkers(markers, hashes);
      markerCount = use.length;
      if (markerCount) out = { ...body, messages: insertMarkers(original, use) };
    }
    store.save(conv, st);

    const { effort, leaseSteps, source, ...jevInfo } = decision;
    return {
      managed: true,
      body: out,
      addBeta: markerCount > 0,
      record: {
        conv,
        step: st.step,
        source,
        sessionEffort,
        previousEffort: current,
        decidedEffort: effort,
        appliedEffort: mode === "apply" ? effort : sessionEffort,
        leaseSteps,
        allowed: `${allowed[0]}-${allowed.at(-1)}`,
        resetReasons,
        markers: markerCount,
        markerAdded,
        ...jevInfo,
      },
    };
  }

  return { evaluate };
}
