const { calcOdds } = require("./odds");

// Summarizes a slate of picks using calcOdds for each line.
function slateReport(picks) {
  return picks.map((p) => `${p.team}: ${(calcOdds(p.odds) * 100).toFixed(1)}%`).join("\n");
}

module.exports = { slateReport };
