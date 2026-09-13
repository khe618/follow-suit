"use strict";
// Deterministic clock + timers for lib/ tests. advance(ms) runs due timers in
// order of their due time, so a callback that arms another timer inside the
// same window also runs.
function createClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: current + ms, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const next = [...timers.values()].filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next.id);
        current = next.due;
        next.fn();
      }
      current = target;
    }
  };
}
module.exports = { createClock };
