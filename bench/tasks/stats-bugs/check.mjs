import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const { mean, median, winRate } = createRequire(import.meta.url)(join(process.argv[2], "stats.js"));
assert.equal(mean([1, 2, 3]), 2);
assert.equal(median([10, 9, 2, 1, 30]), 9);
assert.equal(median([-5, -10, 3]), -5);
assert.equal(median([100, 20, 3]), 20);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(winRate([1, -1, 0, 2]), 0.5);
assert.equal(winRate([0, 0]), 0);
assert.equal(winRate([1, 2]), 1);
