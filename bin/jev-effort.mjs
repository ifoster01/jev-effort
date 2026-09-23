#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(`jev-effort needs Node 20 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (e) => {
    process.stderr.write(`jev-effort: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
