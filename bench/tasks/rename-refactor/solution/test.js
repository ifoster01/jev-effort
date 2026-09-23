const assert = require("node:assert/strict");
const { impliedProbability } = require("./lib/odds");
const { slateReport } = require("./lib/report");
const { edge } = require("./lib/edge");
assert.equal(impliedProbability(100), 0.5);
assert.equal(slateReport([{ team: "NYK", odds: -150 }]), "NYK: 60.0%");
assert.ok(Math.abs(edge(0.55, 100) - 0.05) < 1e-9);
console.log("all tests passed");
