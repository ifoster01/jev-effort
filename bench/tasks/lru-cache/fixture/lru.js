/**
 * Least-recently-used cache.
 *
 * - new LRUCache(capacity): capacity is an integer >= 0. With capacity 0 nothing is stored.
 * - get(key): returns the value, or undefined if absent. A hit makes the key most recently used.
 * - set(key, value): inserts or updates, making the key most recently used. When the cache is
 *   over capacity, evicts the least recently used key.
 * - size: the number of stored keys.
 *
 * Keys are compared like Map keys (1 and "1" are different keys).
 */
class LRUCache {
  constructor(capacity) {
    throw new Error("not implemented");
  }
}

module.exports = { LRUCache };
