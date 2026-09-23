const assert = require("node:assert/strict");
const { evaluate } = require("./calc");
assert.equal(evaluate("1 + 2 * 3"), 7);
console.log("all tests passed");
