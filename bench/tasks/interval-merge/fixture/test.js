const assert = require("node:assert/strict");
const { mergeIntervals } = require("./intervals");
assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
console.log("all tests passed");
