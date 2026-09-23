/**
 * Evaluates an arithmetic expression string.
 *
 * Supports decimal numbers, + - * /, parentheses, unary minus (including "2*-3" and
 * "-(1+2)"), and any whitespace between tokens. Usual precedence; operators of equal
 * precedence are left-associative. Do not use eval or Function.
 *
 * Throws SyntaxError for malformed input (including an empty string) and RangeError for
 * division by zero.
 *
 * @param {string} expr
 * @returns {number}
 */
function evaluate(expr) {
  throw new Error("not implemented");
}

module.exports = { evaluate };
