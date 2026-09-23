// Minimal interactive prompts with no dependencies.

import { createInterface } from "node:readline";

export function ask(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Reads a secret without echoing it. Pasting works; Ctrl+C aborts.
export function askSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return Promise.reject(new Error("A terminal is required to enter the key (or use --key-stdin)."));
  return new Promise((resolve, reject) => {
    output.write(question);
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      err ? reject(err) : resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          output.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

export async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}
