const test = require("node:test");
const assert = require("node:assert/strict");
const { createSequencer } = require("../public/sequencer.js");

// A wait() that only resolves when the test says so. release() yields one
// microtask first so a timeline started this tick has registered its waiter.
function manualWait() {
  const pending = [];
  return {
    wait: () => new Promise((resolve) => pending.push(resolve)),
    async release() {
      await Promise.resolve();
      for (const r of pending.splice(0)) r();
      await new Promise((r) => setImmediate(r));
    }
  };
}
const fakeHandle = (log, name) => ({ cancel: () => log.push(`cancel:${name}`) });

test("a timeline runs to completion and resolves done", async () => {
  const w = manualWait();
  const seq = createSequencer({ wait: w.wait });
  const calls = [];
  const p = seq.run(async (ctx) => {
    calls.push("a");
    await ctx.wait(10);
    calls.push("b");
  });
  await w.release();
  assert.equal(await p, "done");
  assert.deepEqual(calls, ["a", "b"]);
});

test("cancelAll stops a timeline at its next wait and later hooks never run", async () => {
  const w = manualWait();
  const seq = createSequencer({ wait: w.wait });
  const calls = [];
  const p = seq.run(async (ctx) => {
    calls.push("a");
    await ctx.wait(10);
    calls.push("b");
    await ctx.wait(10);
    calls.push("c");
  });
  seq.cancelAll();
  await w.release();
  assert.equal(await p, "cancelled");
  assert.deepEqual(calls, ["a"]);
});

test("starting a new timeline cancels the running one", async () => {
  const w = manualWait();
  const seq = createSequencer({ wait: w.wait });
  const calls = [];
  const first = seq.run(async (ctx) => {
    calls.push("first-a");
    await ctx.wait(10);
    calls.push("first-b");
  });
  const second = seq.run(async (ctx) => {
    calls.push("second-a");
    await ctx.wait(10);
    calls.push("second-b");
  });
  await w.release();
  assert.equal(await first, "cancelled");
  assert.equal(await second, "done");
  assert.deepEqual(calls, ["first-a", "second-a", "second-b"]);
});

test("until() wraps a foreign promise with the same cancellation check", async () => {
  const seq = createSequencer({ wait: () => Promise.resolve() });
  let resolveAnim;
  const anim = new Promise((r) => (resolveAnim = r));
  const calls = [];
  const p = seq.run(async (ctx) => {
    await ctx.until(anim);
    calls.push("after");
  });
  seq.cancelAll();
  resolveAnim();
  assert.equal(await p, "cancelled");
  assert.deepEqual(calls, []);
});

test("a timeline that throws a real error rejects, and still cleans up", async () => {
  const log = [];
  const seq = createSequencer({ wait: () => Promise.resolve() });
  await assert.rejects(seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "x"));
    throw new Error("boom");
  }, { cleanup: () => log.push("cleanup") }), /boom/);
  assert.deepEqual(log, ["cancel:x", "cleanup"]);
});

test("cancelAll cancels tracked handles and runs cleanup synchronously, before the timeline resumes", async () => {
  const w = manualWait();
  const log = [];
  const seq = createSequencer({ wait: w.wait });
  const p = seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "a"));
    log.push("started");
    await ctx.wait(10);
    ctx.track(fakeHandle(log, "late"));
    log.push("after-wait");
  }, { cleanup: () => log.push("cleanup") });
  await Promise.resolve();
  seq.cancelAll();
  assert.deepEqual(log, ["started", "cancel:a", "cleanup"], "cancelled synchronously");
  await w.release();
  assert.equal(await p, "cancelled");
  assert.deepEqual(log, ["started", "cancel:a", "cleanup"], "no hook runs after the cancel point, and late tracks are ignored");
});

test("a run that finishes cancels its own handles and runs cleanup exactly once", async () => {
  const log = [];
  const seq = createSequencer({ wait: () => Promise.resolve() });
  const result = await seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "fill-forwards"));
    await ctx.wait(1);
  }, { cleanup: () => log.push("cleanup") });
  assert.equal(result, "done");
  assert.deepEqual(log, ["cancel:fill-forwards", "cleanup"]);
  seq.cancelAll();
  assert.deepEqual(log, ["cancel:fill-forwards", "cleanup"], "cancelAll after completion is a no-op");
});

test("a newer run cancels the previous run's handles and cleanup first", async () => {
  const w = manualWait();
  const log = [];
  const seq = createSequencer({ wait: w.wait });
  const first = seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "first"));
    await ctx.wait(10);
  }, { cleanup: () => log.push("cleanup-first") });
  await Promise.resolve();
  const second = seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "second"));
    await ctx.wait(10);
  }, { cleanup: () => log.push("cleanup-second") });
  assert.deepEqual(log, ["cancel:first", "cleanup-first"]);
  await w.release();
  assert.equal(await first, "cancelled");
  assert.equal(await second, "done");
  assert.deepEqual(log, ["cancel:first", "cleanup-first", "cancel:second", "cleanup-second"]);
});

test("a handle tracked by a run superseded before its first checkpoint is cancelled on the spot", async () => {
  const log = [];
  const seq = createSequencer({ wait: () => Promise.resolve() });
  const first = seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "first"));
    log.push("first-body");
  });
  const second = seq.run(async (ctx) => {
    ctx.track(fakeHandle(log, "second"));
    await ctx.wait(1);
  });
  assert.equal(await first, "cancelled");
  assert.equal(await second, "done");
  assert.deepEqual(log.slice(0, 2), ["cancel:first", "first-body"], "stale handle cancelled inside track, before the body continues");
  assert.deepEqual(log.slice(2), ["cancel:second"], "the live run's handle is cancelled once at completion");
});
