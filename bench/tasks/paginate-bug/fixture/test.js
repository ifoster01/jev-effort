const assert = require("node:assert/strict");
const { paginate } = require("./paginate");
const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
assert.deepEqual(paginate(items, 1, 3), { items: [1, 2, 3], page: 1, totalPages: 4, hasNext: true });
console.log("all tests passed");
