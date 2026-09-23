import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const { paginate } = createRequire(import.meta.url)(join(process.argv[2], "paginate.js"));
const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
assert.deepEqual(paginate(items, 1, 3), { items: [1, 2, 3], page: 1, totalPages: 4, hasNext: true });
assert.deepEqual(paginate(items, 4, 3), { items: [10], page: 4, totalPages: 4, hasNext: false });
assert.deepEqual(paginate(items, 5, 3), { items: [], page: 5, totalPages: 4, hasNext: false });
assert.deepEqual(paginate(items, 1, 20), { items, page: 1, totalPages: 1, hasNext: false });
assert.deepEqual(paginate([], 1, 5), { items: [], page: 1, totalPages: 0, hasNext: false });
assert.deepEqual(paginate(items, 2, 5), { items: [6, 7, 8, 9, 10], page: 2, totalPages: 2, hasNext: false });
assert.throws(() => paginate(items, 0, 3), RangeError);
assert.throws(() => paginate(items, 1.5, 3), RangeError);
assert.throws(() => paginate(items, 1, 0), RangeError);
