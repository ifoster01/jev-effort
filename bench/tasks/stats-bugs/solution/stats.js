function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function winRate(xs) {
  return xs.filter((x) => x > 0).length / xs.length;
}

module.exports = { mean, median, winRate };
