// Builds the bounded, public view of the conversation that Jev evaluates: prompts, Claude's
// visible text, and the last few tool calls with head-and-tail previews of their output.
// Claude Code requests thinking with display "omitted", so no reasoning text is available.

const TOOL_CALLS = 6;
const TOOL_OUTPUT_CHARS = 4000; // roughly 1000 tokens per tool call
const MAX_REQUEST_CHARS = 100_000; // stays well under Jev's 28K-token request limit

export const blocks = (m) =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// What the person typed. Claude Code can put the prompt in the same text block as its
// <system-reminder>s, so strip those spans rather than dropping whole blocks.
export function humanText(m) {
  if (m?.role !== "user") return "";
  return blocks(m)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text.replace(REMINDER, "").trim())
    .filter(Boolean)
    .join("\n");
}

export function latestHumanPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = humanText(messages[i]);
    if (text) return text;
  }
  return "";
}

export function countToolFailures(messages) {
  let n = 0;
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_result" && b.is_error) n++;
  return n;
}

export function clip(text, n) {
  if (typeof text !== "string" || text.length <= n) return text;
  const head = Math.floor(n * 0.75);
  return `${text.slice(0, head)}\n[truncated: middle omitted]\n${text.slice(text.length - (n - head))}`;
}

function resultText(block) {
  if (typeof block.content === "string") return block.content;
  return (block.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

export function buildJevState({ model, messages, step, previousEffort, newToolFailures, supportedEfforts }) {
  const prompts = messages.map((m, i) => ({ i, text: humanText(m) })).filter((p) => p.text);
  const latest = prompts.at(-1) ?? { i: -1, text: "" };

  const notes = [];
  for (const m of messages.slice(latest.i + 1)) {
    if (m.role !== "assistant") continue;
    for (const b of blocks(m)) {
      if (b.type === "text" && b.text?.trim()) notes.push({ kind: "assistant_text", text: clip(b.text, 1500) });
      if (b.type === "thinking" && b.thinking?.trim())
        notes.push({ kind: "reasoning_summary", text: clip(b.thinking, 1500) });
    }
  }

  const results = new Map();
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const calls = [];
  for (const m of messages)
    for (const b of blocks(m))
      if (b.type === "tool_use") {
        const r = results.get(b.id);
        calls.push({
          name: b.name,
          input: clip(JSON.stringify(b.input ?? {}), 1000),
          outputs: r ? [{ text: clip(resultText(r), TOOL_OUTPUT_CHARS), isError: !!r.is_error }] : [],
        });
      }

  const state = {
    model,
    supportedEfforts,
    latestUserPrompt: clip(latest.text, 8000),
    originalTask: prompts.length > 1 ? clip(prompts[0].text, 4000) : undefined,
    priorUserPrompts: prompts.slice(1, -1).slice(-5).map((p) => clip(p.text, 1500)),
    publicNotes: notes.slice(-8),
    recentToolCalls: calls.slice(-TOOL_CALLS),
    omittedOlderToolCalls: Math.max(0, calls.length - TOOL_CALLS),
    step,
    previousEffort,
    newToolFailures,
  };
  return shrink(state);
}

// Degrade gracefully instead of failing when a conversation has enormous prompts or outputs.
function shrink(state) {
  const size = () => JSON.stringify(state).length;
  if (size() <= MAX_REQUEST_CHARS) return state;
  state.priorUserPrompts = [];
  state.publicNotes = state.publicNotes.slice(-3);
  if (size() <= MAX_REQUEST_CHARS) return state;
  for (const c of state.recentToolCalls) for (const o of c.outputs) o.text = clip(o.text, 1000);
  state.originalTask = clip(state.originalTask, 1000);
  state.latestUserPrompt = clip(state.latestUserPrompt, 4000);
  if (size() <= MAX_REQUEST_CHARS) return state;
  state.recentToolCalls = state.recentToolCalls.slice(-2);
  state.latestUserPrompt = clip(state.latestUserPrompt, 1500);
  return state;
}
