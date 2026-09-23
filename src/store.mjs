// Per-conversation state (markers and lease), one small JSON file per conversation so that
// parallel sessions, `--continue`, and restarts all see the same marker positions.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_MARKERS = 400;
const MAX_AGE_MS = 14 * 24 * 3600_000;

export const freshState = () => ({ v: 1, step: 0, leaseRemaining: 0, markers: [] });

export class ConversationStore {
  #locks = new Map();
  #memory = new Map();

  // dir === null keeps state in memory only (tests, bench arms).
  constructor(dir) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Serializes work per conversation within this process (a fork and its parent can race).
  withLock(key, fn) {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.#locks.set(key, tail);
    tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  load(key) {
    if (!this.dir) return structuredClone(this.#memory.get(key) ?? freshState());
    try {
      const state = JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf8"));
      return state?.v === 1 && Array.isArray(state.markers) ? state : freshState();
    } catch {
      return freshState();
    }
  }

  save(key, state) {
    if (state.markers.length > MAX_MARKERS) {
      state.markers.sort((a, b) => a.t - b.t);
      state.markers = state.markers.slice(-MAX_MARKERS);
    }
    if (!this.dir) return void this.#memory.set(key, structuredClone(state));
    const file = join(this.dir, `${key}.json`);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  }

  // Best effort: forget conversations untouched for two weeks.
  prune(now = Date.now()) {
    if (!this.dir) return;
    try {
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f);
        if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p);
      }
    } catch {
      // Ignore: pruning is housekeeping only.
    }
  }
}
