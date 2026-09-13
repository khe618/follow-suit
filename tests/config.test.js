const test = require("node:test");
const assert = require("node:assert/strict");
const { readConfig } = require("../lib/config.js");

test("defaults with no environment", () => {
  const c = readConfig({});
  assert.equal(c.port, 3000);
  assert.deepEqual(c.game, { dealMs: 7000, bidMs: 20000, revealBidsMs: 3000, revealCardMs: 4000 });
  assert.equal(c.resumeTtlMs, 600000);
  assert.equal(c.heartbeatMs, 30000);
});

test("positive integers from the environment override; junk falls back", () => {
  const c = readConfig({ DEAL_MS: "50", BID_MS: "abc", REVEAL_CARD_MS: "-5", PORT: "3100" });
  assert.equal(c.game.dealMs, 50);
  assert.equal(c.game.bidMs, 20000);
  assert.equal(c.game.revealCardMs, 4000);
  assert.equal(c.port, 3100);
});
