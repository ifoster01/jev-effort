const odds = require("./odds");

// Model edge: our probability minus the market's calcOdds probability.
function edge(modelProb, american) {
  return modelProb - odds.calcOdds(american);
}

module.exports = { edge };
