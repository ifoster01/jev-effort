class LRUCache {
  #map = new Map();
  constructor(capacity) {
    this.capacity = capacity;
  }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.capacity <= 0) return;
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value);
  }
  get size() {
    return this.#map.size;
  }
}

module.exports = { LRUCache };
