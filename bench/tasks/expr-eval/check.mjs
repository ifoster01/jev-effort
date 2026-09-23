import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const file = join(process.argv[2], "calc.js");
const { evaluate } = createRequire(import.meta.url)(file);
assert.ok(!/\beval\s*\(|\bFunction\s*\(/.test(readFileSync(file, "utf8")), "uses eval/Function");
const cases = { "1 + 2 * 3": 7, "(1+2)*3": 9, "10 / 4": 2.5, "2 - 3 - 4": -5, "8/2/2": 2, "-(2+3)*4": -20, "2*-3": -6, "  7 ": 7, "1.5*2": 3, "--2": 2, "((4))": 4, "3 - -3": 6 };
for (const [expr, want] of Object.entries(cases)) assert.equal(evaluate(expr), want, expr);
for (const bad of ["", "1 +", "(1", "1)", "2 3", "*2", "1 + + ", "abc"]) assert.throws(() => evaluate(bad), SyntaxError, JSON.stringify(bad));
assert.throws(() => evaluate("1/0"), RangeError);
assert.throws(() => evaluate("4/(2-2)"), RangeError);
