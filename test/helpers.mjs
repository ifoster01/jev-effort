// Synthetic Claude Code traffic, shaped like what Claude Code 2.1.280 actually sends:
// the prompt shares a text block with <system-reminder>s, a system message after it carries
// Claude Code's per-turn effort, that message is re-sent as a plain string on later requests,
// and cache_control breakpoints move to the newest message each time.

import http from "node:http";
import { canonical } from "../src/markers.mjs";

export class FakeClaudeCode {
  constructor({ prompt = "Fix the failing test in stats.js", effort = "high", model = "claude-opus-5-5" } = {}) {
    this.model = model;
    this.effort = effort;
    this.sent = 0;
    this.nextId = 1;
    this.messages = [
      { role: "user", content: [{ type: "text", text: `<system-reminder>\nToday is Tuesday.\n</system-reminder>\n${prompt}` }] },
      { role: "system", content: [{ type: "text", text: "# Environment\n - cwd: /tmp/project" }], output_config: { effort } },
    ];
  }

  // Claude used a tool and got a result back.
  step({ output = "ok", isError = false, name = "Bash" } = {}) {
    const id = `toolu_${this.nextId++}`;
    this.messages.push({ role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "node test.js" } }] });
    this.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, ...(isError ? { is_error: true } : {}) }] });
    return this;
  }

  // Claude finished its turn and the person typed something new.
  newPrompt(text) {
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }] });
    this.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>\nnote\n</system-reminder>\n${text}` }] });
    return this;
  }

  // /effort mid-session: Claude Code appends a new effort-carrying system message.
  setEffort(effort) {
    this.effort = effort;
    this.messages.push({ role: "system", content: [{ type: "text", text: `Effort is now ${effort}.` }], output_config: { effort } });
    return this;
  }

  clone() {
    return Object.assign(Object.create(FakeClaudeCode.prototype), structuredClone({ ...this }));
  }

  request() {
    const messages = structuredClone(this.messages);
    if (this.sent++ > 0) messages[1] = { ...messages[1], content: messages[1].content[0].text };
    const last = messages.at(-1);
    if (Array.isArray(last.content)) last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
    return {
      model: this.model,
      max_tokens: 64000,
      stream: true,
      system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: this.effort },
      messages,
    };
  }
}

// The property the whole design exists for: each request must start with the previous one.
export function isPrefix(prev, next) {
  if (prev.length > next.length) return false;
  return JSON.stringify(canonical(prev)) === JSON.stringify(canonical(next.slice(0, prev.length)));
}

export function fakeJev(script = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async decide(state, leases) {
      calls.push({ state, leases });
      const next = script[Math.min(i++, script.length - 1)] ?? { effort: "low", leaseSteps: 1 };
      if (next instanceof Error) throw next;
      return { jevMs: 5, jevModel: "jev-test", ...next };
    },
  };
}

export const baseConfig = { floor: "low", ceiling: "session", maxLeaseSteps: 10 };

export async function fakeUpstream(handler) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const entry = { method: req.method, url: req.url, headers: req.headers, raw, body: raw.length ? safeJson(raw) : null };
    received.push(entry);
    await handler(entry, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}

const safeJson = (b) => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

export function sse(res, { input = 10, cacheRead = 30000, cacheWrite = 500, output = 42 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } } })}\n\n`);
  res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: output } })}\n\n`);
  res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
}
