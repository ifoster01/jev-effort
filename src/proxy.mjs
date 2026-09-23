// Local HTTP proxy between Claude Code and the Claude API.
//
// Only POST /v1/messages bodies are inspected; everything else is piped through untouched.
// Failure policy: anything that goes wrong on our side forwards Claude Code's original
// request unchanged, so the worst case is running at the effort Claude Code chose itself.

import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { EFFORT_BETA } from "./constants.mjs";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
]);

const AGENTS = {
  "http:": new http.Agent({ keepAlive: true }),
  "https:": new https.Agent({ keepAlive: true }),
};

export function createLogger(dir) {
  return {
    write(rec) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, `${rec.t.slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n", { mode: 0o600 });
      } catch {
        // Logging must never affect the session.
      }
    },
  };
}

export const memoryLogger = () => {
  const records = [];
  return { records, write: (rec) => records.push(rec) };
};

// Opt-in debugging aid for checking a new Claude Code release: writes each outgoing
// /v1/messages body (full conversation content) to JEV_EFFORT_DUMP_DIR. Auth is redacted.
let dumpCount = 0;
function dump(headers, body) {
  const dir = process.env.JEV_EFFORT_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /auth|key|cookie/i.test(k) ? "<redacted>" : v]));
    writeFileSync(join(dir, `${Date.now()}-${++dumpCount}.json`), JSON.stringify({ headers: safe, body: JSON.parse(body) }, null, 2), { mode: 0o600 });
  } catch {
    // Debug output only.
  }
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function withBeta(headers) {
  const betas = String(headers["anthropic-beta"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (betas.includes(EFFORT_BETA)) return headers;
  return { ...headers, "anthropic-beta": [...betas, EFFORT_BETA].join(",") };
}

// Pulls token usage out of the response as it streams by, without buffering the stream.
export class UsageTap {
  #decoder = new TextDecoder();
  #buf = "";
  #json = "";
  constructor(sse) {
    this.sse = sse;
    this.usage = null;
    this.error = null;
  }
  push(chunk) {
    const text = this.#decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.#json.length < 4_000_000) this.#json += text;
      return;
    }
    this.#buf += text;
    let i;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      this.#line(this.#buf.slice(0, i).trimEnd());
      this.#buf = this.#buf.slice(i + 1);
    }
  }
  #line(line) {
    if (!line.startsWith("data:")) return;
    let ev;
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (ev.type === "message_start") this.usage = { ...ev.message?.usage };
    else if (ev.type === "message_delta" && ev.usage) this.usage = { ...this.usage, ...ev.usage };
    else if (ev.type === "error") this.error = ev.error;
  }
  finish() {
    if (this.sse || !this.#json) return;
    try {
      const j = JSON.parse(this.#json);
      if (j.type === "error") this.error = j.error;
      else this.usage = j.usage ?? null;
    } catch {
      // Not JSON; nothing to record.
    }
  }
}

const pickUsage = (u) =>
  u && {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    // Hidden thinking, the part of the output that effort mainly controls.
    ...(u.output_tokens_details?.thinking_tokens != null ? { thinking: u.output_tokens_details.thinking_tokens } : {}),
  };

// mode: "apply" | "shadow" | "off". tag: optional label copied into every log record.
export function createProxy({ upstream = "https://api.anthropic.com", mode, policy, logger, tag, session }) {
  const base = new URL(upstream);
  const basePath = base.pathname.replace(/\/$/, "");
  let applyDisabled = false;
  let injectionRejections = 0;

  function send(method, path, headers, body, signal) {
    const url = new URL(base.origin + basePath + path);
    const mod = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method,
          headers: body.length ? { ...headers, "content-length": body.length } : headers,
          agent: AGENTS[url.protocol],
          signal,
        },
        resolve,
      );
      req.on("error", reject);
      req.end(body.length ? body : undefined);
    });
  }

  async function handle(req, res) {
    const started = performance.now();
    const raw = await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let body = null;
    if (req.method === "POST" && /^\/v1\/messages(?:\?|$)/.test(req.url)) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    if (!body) {
      const upstreamRes = await send(req.method, req.url, headers, raw, abort.signal);
      res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      return finished(res).catch(() => {});
    }

    // We need to read usage out of the response, so ask for it uncompressed.
    headers["accept-encoding"] = "identity";
    const activeMode = mode === "apply" && applyDisabled ? "shadow" : mode;
    const rec = {
      v: 1,
      t: new Date().toISOString(),
      ...(tag ? { tag } : {}),
      mode: activeMode,
      session: session ?? req.headers["x-claude-code-session-id"],
      model: body.model,
      messages: Array.isArray(body.messages) ? body.messages.length : undefined,
    };
    const note = (r) => Object.assign(rec, r.managed ? { managed: true, ...r.record } : { managed: false, reason: r.reason });

    let sendBody = raw;
    let sendHeaders = headers;
    let modified = false;
    let background = null;
    if (activeMode === "apply") {
      try {
        const r = await policy.evaluate(body, "apply");
        note(r);
        if (r.managed && r.addBeta) {
          sendBody = Buffer.from(JSON.stringify(r.body));
          sendHeaders = withBeta(headers);
          modified = true;
        }
      } catch (e) {
        rec.policyError = String(e?.message ?? e).slice(0, 300);
      }
    } else if (activeMode === "shadow") {
      // Shadow never delays the request: Jev runs alongside it.
      background = policy.evaluate(body, "shadow").then(note, (e) => {
        rec.policyError = String(e?.message ?? e).slice(0, 300);
      });
    }

    dump(sendHeaders, sendBody);
    let upstreamRes = await send(req.method, req.url, sendHeaders, sendBody, abort.signal);
    if (modified && upstreamRes.statusCode === 400) {
      // The API refused our rewrite. Retry exactly what Claude Code sent.
      const detail = (await readBody(upstreamRes)).toString("utf8").slice(0, 400);
      upstreamRes = await send(req.method, req.url, headers, raw, abort.signal);
      rec.injectionRejected = detail;
      if (upstreamRes.statusCode < 400 && ++injectionRejections >= 2) applyDisabled = true;
    }

    rec.status = upstreamRes.statusCode;
    res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
    const tap = new UsageTap(/event-stream/.test(upstreamRes.headers["content-type"] ?? ""));
    upstreamRes.on("data", (c) => tap.push(c));
    upstreamRes.pipe(res);
    try {
      await finished(res);
    } catch {
      rec.clientAborted = true;
    }
    tap.finish();
    rec.usage = pickUsage(tap.usage);
    if (tap.error) rec.apiError = { type: tap.error.type, message: String(tap.error.message ?? "").slice(0, 300) };
    rec.durationMs = Math.round(performance.now() - started);
    if (background) await background;
    logger.write(rec);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      logger.write({ v: 1, t: new Date().toISOString(), ...(tag ? { tag } : {}), mode, proxyError: String(e?.message ?? e).slice(0, 300), path: req.url });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `jev-effort proxy: ${e?.message ?? e}` } }));
      } else res.destroy();
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return {
    server,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    get applyDisabled() {
      return applyDisabled;
    },
  };
}

function responseHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h))
    if (!["connection", "keep-alive", "transfer-encoding", "proxy-connection"].includes(k)) out[k] = v;
  return out;
}
