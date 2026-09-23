function evaluate(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|\.\d+|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function expression() {
    let v = term();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = factor();
      if (op === "/" && r === 0) throw new RangeError("division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function factor() {
    const t = next();
    if (t === "-") return -factor();
    if (t === "(") {
      const v = expression();
      if (next() !== ")") throw new SyntaxError("expected )");
      return v;
    }
    if (t !== undefined && /^(\d+(\.\d+)?|\.\d+)$/.test(t)) return Number(t);
    throw new SyntaxError(`unexpected ${t ?? "end of input"}`);
  }
  const v = expression();
  if (i !== tokens.length) throw new SyntaxError(`unexpected ${peek()}`);
  return v;
}

module.exports = { evaluate };
