import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const effortRank = (effort) => EFFORTS.indexOf(effort);

// Beta that allows an effort-only system message inside `messages`.
export const EFFORT_BETA = "mid-conversation-output-config-2026-07-01";

// Newest Claude Code release this version was verified against (request shape changes can
// break the approach; see docs/how-it-works.md).
export const TESTED_CLAUDE_CODE = "2.1.280";

// Models that accept per-message effort on the Claude API. Only Opus 5.5 has been tested
// end to end; the others are documented by Anthropic but unverified here.
const MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5", defaultEffort: "medium", tested: true },
  { id: "claude-fable-5-1", name: "Fable 5.1", defaultEffort: "high", tested: false },
  { id: "claude-mythos-5-1", name: "Mythos 5.1", defaultEffort: "high", tested: false },
  { id: "claude-opus-5", name: "Opus 5", defaultEffort: "high", tested: false },
];

// Exact id, optionally followed by a date snapshot or a bracketed variant like [1m].
export function modelInfo(model) {
  if (typeof model !== "string") return null;
  return (
    MODELS.find((m) => new RegExp(`^${m.id}(?:-\\d{8})?(?:\\[[^\\]]*\\])?$`).test(model)) || null
  );
}

export const SUPPORTED_MODEL_NAMES = MODELS.map((m) => m.name);
