// Claude API list prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing,
// checked 2026-09-23). Used only to estimate where spend goes. On a Claude subscription these
// are API-equivalent figures, not what you're billed.

export const PRICES_CHECKED = "2026-09-23";

const TABLE = [
  ["claude-fable-5-1", { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 }],
  ["claude-mythos-5-1", { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 }],
  ["claude-fable-5", { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 }],
  ["claude-mythos-5", { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 }],
  ["claude-opus-5-5", { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  ["claude-opus-5", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  ["claude-opus-4", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  ["claude-sonnet-5", { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 }],
  ["claude-sonnet-4", { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 }],
  ["claude-haiku-4-5", { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 }],
];

// Longest matching id prefix wins, so claude-opus-5-5 isn't priced as claude-opus-5.
export function priceFor(model) {
  if (typeof model !== "string") return null;
  let best = null;
  for (const [id, p] of TABLE) if ((model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}[`)) && (!best || id.length > best[0].length)) best = [id, p];
  return best?.[1] ?? null;
}

// Jev 1.13 on OpenRouter: $0.042 per million input tokens, output free. Used when the route
// doesn't report a cost.
export const JEV_INPUT_PRICE = 0.042;

// Cost of one logged request, split by where the money goes. Older logs don't say which cache
// lifetime a write used; those are priced as 1-hour writes (Claude Code's subscription default)
// and flagged.
export function requestCost(record) {
  const p = priceFor(record.model);
  const u = record.usage;
  if (!p || !u) return null;
  const thinking = u.thinking ?? 0;
  const known1h = u.cacheWrite1h ?? null;
  const known5m = u.cacheWrite5m ?? null;
  const ttlKnown = known1h != null || known5m != null;
  const write1h = ttlKnown ? (known1h ?? 0) : u.cacheWrite;
  const write5m = ttlKnown ? (known5m ?? 0) : 0;
  return {
    read: (u.cacheRead * p.read) / 1e6,
    write: (write1h * p.write1h + write5m * p.write5m) / 1e6,
    input: (u.input * p.input) / 1e6,
    visibleOutput: ((u.output - thinking) * p.output) / 1e6,
    thinking: (thinking * p.output) / 1e6,
    ttlAssumed: !ttlKnown && u.cacheWrite > 0,
    readPrice: p.read,
  };
}
