// Effort markers: effort-only system messages, anchored to the exact history before them.
//
// Claude Code re-sends the whole conversation on every request without our markers, so
// each one is re-inserted at the index it was first placed, but only while the messages
// before it hash the same. Markers from other branches (forks, compaction requests,
// /rewind) simply stop matching; they are never needed to rebuild this branch's prefix.

import { createHash } from "node:crypto";

// cache_control breakpoints move every turn and don't change the cached prefix, and Claude
// Code re-sends some messages with string content that it first sent as text blocks (the API
// renders both forms identically).
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    if (typeof value.content === "string" && (typeof value.role === "string" || value.type === "tool_result"))
      return canonical({ ...value, content: [{ type: "text", text: value.content }] });
    const out = {};
    for (const k of Object.keys(value).sort()) if (k !== "cache_control") out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

// hashes[i] identifies messages[0..i). hashes[0] is the empty prefix.
export function prefixHashes(messages) {
  const hashes = [sha("")];
  for (const m of messages) hashes.push(sha(hashes.at(-1) + JSON.stringify(canonical(m))));
  return hashes;
}

export function conversationKey(body) {
  return sha(JSON.stringify(canonical([body.system ?? null, body.messages?.[0] ?? null]))).slice(0, 16);
}

export const isEffortMarker = (m) => m?.role === "system" && typeof m.output_config?.effort === "string";

export const effortMarker = (effort) => ({ role: "system", content: [], output_config: { effort } });

// Index of the user turn the model is about to answer, or -1 when the request doesn't end in
// one (for example an assistant prefill). Claude Code may add system messages after it.
export function nextTurnSlot(messages) {
  const i = messages.findLastIndex((m) => m.role === "user");
  return i >= 0 && !messages.slice(i).some((m) => m.role === "assistant") ? i : -1;
}

// Markers whose anchor matches this request's history, in position order.
export function applicableMarkers(markers, hashes) {
  const len = hashes.length - 1;
  return markers.filter((m) => m.at <= len && hashes[m.at] === m.hash).sort((a, b) => a.at - b.at);
}

// A marker at `at` goes before messages[at]; `at === messages.length` means at the end.
export function insertMarkers(messages, markers) {
  if (!markers.length) return messages;
  const out = [];
  for (let i = 0; i <= messages.length; i++) {
    for (const m of markers) if (m.at === i) out.push(effortMarker(m.effort));
    if (i < messages.length) out.push(messages[i]);
  }
  return out;
}
