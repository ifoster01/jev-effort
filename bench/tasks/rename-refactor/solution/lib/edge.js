const odds = require("./odds");

// Model edge: our probability minus the market's impliedProbability probability.
function edge(modelProb, american) {
  return modelProb - odds.impliedProbability(american);
}

module.exports = { edge };
