import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.argv[2];
const files = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" || f.startsWith(".") ? [] : files(p)) : p.endsWith(".js") ? [p] : [];
  });
for (const f of files(root)) assert.ok(!readFileSync(f, "utf8").includes("calcOdds"), `calcOdds still in ${f}`);
const req = createRequire(import.meta.url);
const { impliedProbability } = req(join(root, "lib/odds.js"));
assert.equal(impliedProbability(100), 0.5);
assert.equal(impliedProbability(-150), 0.6);
assert.equal(req(join(root, "lib/report.js")).slateReport([{ team: "BOS", odds: 300 }]), "BOS: 25.0%");
execFileSync(process.execPath, ["test.js"], { cwd: root, stdio: "ignore" });
