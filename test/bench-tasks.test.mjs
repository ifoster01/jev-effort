import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listTasks } from "../src/bench.mjs";

const check = (task, dir) => spawnSync(process.execPath, [join(task.dir, "check.mjs"), dir]).status === 0;

for (const task of listTasks()) {
  test(`bench task ${task.name}: starts failing, reference solution passes`, () => {
    assert.ok(task.prompt && task.description);
    const start = mkdtempSync(join(tmpdir(), `jev-task-${task.name}-`));
    cpSync(join(task.dir, "fixture"), start, { recursive: true });
    assert.equal(check(task, start), false, "the hidden check should fail before any work");
    const solved = mkdtempSync(join(tmpdir(), `jev-task-${task.name}-`));
    cpSync(join(task.dir, "fixture"), solved, { recursive: true });
    cpSync(join(task.dir, "solution"), solved, { recursive: true });
    assert.equal(check(task, solved), true, "the reference solution should pass the hidden check");
  });
}
