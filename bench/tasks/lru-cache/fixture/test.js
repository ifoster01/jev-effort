const assert = require("node:assert/strict");
const { LRUCache } = require("./lru");
const c = new LRUCache(2);
c.set("a", 1);
c.set("b", 2);
c.set("c", 3);
assert.equal(c.get("a"), undefined);
assert.equal(c.get("c"), 3);
console.log("all tests passed");
