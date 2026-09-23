const assert = require("node:assert");
const { mean, median, winRate } = require("./stats");
const results = [10, 9, 2, 1, 30];
assert.strictEqual(mean([1, 2, 3]), 2);
assert.strictEqual(median(results), 9);
assert.strictEqual(median([1, 2, 3, 4]), 2.5);
assert.strictEqual(winRate([1, -1, 0, 2]), 0.5, "a push (0) is not a win");
console.log("all tests passed");
