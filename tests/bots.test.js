const test = require("node:test");
const assert = require("node:assert/strict");
const { BOT_NAMES, BOT_PROFILES, pickBotName, botProfile, computeBotBid, botDelayMs } = require("../lib/bots.js");
const { fairValue } = require("../lib/fair-value.js");

const situation = { hand: { spades: 6, hearts: 1, diamonds: 1, clubs: 0 }, flips: { spades: 0, hearts: 0, diamonds: 0, clubs: 0 }, playerCount: 2, reference: "spades" };

test("five distinct bot names, then null", () => {
  assert.equal(new Set(BOT_NAMES).size, 5);
  assert.equal(pickBotName([]), BOT_NAMES[0]);
  assert.equal(pickBotName([BOT_NAMES[0]]), BOT_NAMES[1]);
  assert.equal(pickBotName(BOT_NAMES), null);
});

test("profiles cycle", () => {
  assert.equal(BOT_PROFILES.length, 4);
  assert.equal(botProfile(0).key, "careful");
  assert.equal(botProfile(3).key, "wild");
  assert.equal(botProfile(4).key, "careful");
});

test("bid is an integer in range for every profile", () => {
  for (const profile of BOT_PROFILES) {
    for (let i = 0; i < 200; i++) {
      const bid = computeBotBid({ profile, ...situation });
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= 100, `${profile.key}: ${bid}`);
    }
  }
});

test("shade is applied: with zero noise the bid is round(fair * shade)", () => {
  // sigma 0 skips the gaussian entirely, so the bid is deterministic.
  const noNoise = { key: "test", shade: 0.5, sigma: 0 };
  const fair = fairValue(situation);
  const bid = computeBotBid({ profile: noNoise, ...situation }, () => 0.5);
  assert.equal(bid, Math.round(fair * 0.5));
});

test("delay stays inside the bidding window", () => {
  for (let i = 0; i < 200; i++) {
    const d = botDelayMs(20000);
    assert.ok(d >= 1500 && d <= 6000, String(d));
    const short = botDelayMs(4000);
    assert.ok(short >= 1500 && short <= 2000, String(short));
    const tiny = botDelayMs(1000);
    assert.ok(tiny <= 500, String(tiny));
  }
});
