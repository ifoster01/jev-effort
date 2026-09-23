// calcOdds converts American odds to an implied win probability (0-1).
function calcOdds(american) {
  if (american < 0) return -american / (-american + 100);
  return 100 / (american + 100);
}

module.exports = { calcOdds };
