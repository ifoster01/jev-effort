import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const { mergeIntervals } = createRequire(import.meta.url)(join(process.argv[2], "intervals.js"));
assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
assert.deepEqual(mergeIntervals([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]]);
assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
assert.deepEqual(mergeIntervals([]), []);
assert.deepEqual(mergeIntervals([[5, 5]]), [[5, 5]]);
assert.deepEqual(mergeIntervals([[-3, -1], [-2, 4]]), [[-3, 4]]);
assert.deepEqual(mergeIntervals([[1, 2], [1, 2]]), [[1, 2]]);
const input = [[3, 4], [1, 2], [2, 3]];
const snapshot = JSON.stringify(input);
const out = mergeIntervals(input);
assert.equal(JSON.stringify(input), snapshot, "input was mutated");
out[0][0] = 99;
assert.equal(JSON.stringify(input), snapshot, "output shares pairs with the input");
