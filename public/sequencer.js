(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Sequencer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CANCELLED = Symbol("cancelled");

  // One generation counter and at most one active run. Starting a run or
  // calling cancelAll bumps the generation and tears the active run down
  // synchronously (cancel every tracked handle, then cleanup); the stale
  // timeline then throws CANCELLED at its next await, so no continuation of
  // it can ever touch the DOM.
  function createSequencer(deps = {}) {
    const wait = deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let generation = 0;
    let active = null; // { tracked: [], cleanup }

    function teardown(entry) {
      if (!entry || entry.done) return;
      entry.done = true;
      if (active === entry) active = null;
      for (const handle of entry.tracked) {
        try {
          handle.cancel();
        } catch (err) {
          console.error("[sequencer] cancel failed:", err);
        }
      }
      if (entry.cleanup) {
        try {
          entry.cleanup();
        } catch (err) {
          console.error("[sequencer] cleanup failed:", err);
        }
      }
    }

    function run(timeline, options = {}) {
      teardown(active);
      generation += 1;
      const mine = generation;
      const entry = { tracked: [], cleanup: options.cleanup || null, done: false };
      active = entry;
      const check = () => {
        if (generation !== mine) throw CANCELLED;
      };
      const ctx = {
        alive: () => generation === mine,
        track(handle) {
          if (generation === mine) entry.tracked.push(handle);
          return handle;
        },
        async wait(ms) {
          await wait(ms);
          check();
        },
        async until(promise) {
          await promise;
          check();
        }
      };
      return Promise.resolve()
        .then(() => timeline(ctx))
        .then(
          () => {
            const done = generation === mine;
            teardown(entry);
            return done ? "done" : "cancelled";
          },
          (err) => {
            teardown(entry);
            if (err === CANCELLED) return "cancelled";
            throw err;
          }
        );
    }

    function cancelAll() {
      generation += 1;
      teardown(active);
    }

    return { run, cancelAll, generation: () => generation };
  }

  return { createSequencer, CANCELLED };
});
