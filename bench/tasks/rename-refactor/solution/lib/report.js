const { impliedProbability } = require("./odds");

// Summarizes a slate of picks using impliedProbability for each line.
function slateReport(picks) {
  return picks.map((p) => `${p.team}: ${(impliedProbability(p.odds) * 100).toFixed(1)}%`).join("\n");
}

module.exports = { slateReport };
