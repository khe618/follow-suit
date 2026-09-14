const test = require("node:test");
const assert = require("node:assert/strict");
const { createGame } = require("../lib/game.js");
const { createClock } = require("./helpers/clock.js");

const CONFIG = { dealMs: 7000, bidMs: 20000, revealBidsMs: 3000, revealCardMs: 4000 };

function setup({ seats, randomInt, stayDealing } = {}) {
  const clock = createClock();
  const changes = [];
  const game = createGame({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    randomInt: randomInt || ((n) => n - 1), random: () => 0.5, config: CONFIG,
    onChange: () => changes.push(game.phase + ":" + game.revealStep)
  });
  const defaultSeats = [
    { id: "p1", name: "Ann", isBot: false, connected: true },
    { id: "p2", name: "Ben", isBot: false, connected: true }
  ];
  game.start(seats || defaultSeats);
  // Every test but the dealing ones wants auction 1 open.
  if (!stayDealing) clock.advance(CONFIG.dealMs);
  return { clock, game, changes };
}

test("start deals, flips one card, and opens auction 1 once dealing ends", () => {
  const { game, changes } = setup();
  assert.equal(game.phase, "bidding");
  assert.equal(game.matchId, 1);
  assert.equal(game.flipIndex, 1);
  assert.equal(game.deck.length, 20);
  assert.equal(game.players[0].hand.length, 10);
  assert.equal(game.auction.index, 1);
  assert.equal(game.cardsRemaining(), 19);
  assert.ok(game.reference());
  assert.equal(game.remainingMs(), 20000);
  assert.deepEqual(changes, ["dealing:null", "bidding:null"]);
  assert.deepEqual(game.timing, { dealMs: 7000, bidMs: 20000, revealBidsMs: 3000, revealCardMs: 4000 });
});

test("dealing: no bids, no lobby return, no restart, then auction 1 after dealMs", () => {
  const { clock, game, changes } = setup({ stayDealing: true });
  assert.equal(game.phase, "dealing");
  assert.equal(game.revealStep, null);
  assert.equal(game.auction, null);
  assert.equal(game.flipIndex, 1);
  assert.ok(game.reference());
  assert.equal(game.remainingMs(), 7000);
  assert.deepEqual(changes, ["dealing:null"]);
  assert.deepEqual(game.bid("p1", { auction: 1, amount: 10, locked: true }), { ok: false, error: "not_bidding" });
  assert.equal(game.returnToLobby(), false);
  assert.throws(() => game.start([]), /lobby/);
  game.setConnected("p2", false);
  assert.equal(game.phase, "dealing", "a disconnect during dealing changes nothing");
  clock.advance(6999);
  assert.equal(game.phase, "dealing");
  assert.equal(game.remainingMs(), 1);
  clock.advance(1);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 1);
  assert.equal(game.remainingMs(), 20000);
});

test("no bot timers are armed during dealing", () => {
  const seats = [
    { id: "p1", name: "Ann", isBot: false, connected: true },
    { id: "b1", name: "Kai", isBot: true, connected: true, profile: { key: "keen", shade: 1, sigma: 0 } }
  ];
  const { clock, game } = setup({ seats, stayDealing: true });
  assert.equal(clock.pending(), 1, "only the deal timer");
  clock.advance(6000);
  assert.equal(game.phase, "dealing");
  clock.advance(1000);
  assert.equal(game.phase, "bidding");
  assert.equal(clock.pending(), 2, "deadline timer plus one bot timer");
});

test("destroy during dealing clears the deal timer", () => {
  const { clock, game } = setup({ stayDealing: true });
  game.destroy();
  assert.equal(clock.pending(), 0);
  clock.advance(10000);
  assert.equal(game.phase, "dealing", "nothing fires after destroy");
});

test("start rejects wrong phase and bad player counts", () => {
  const { game } = setup();
  assert.throws(() => game.start([]), /lobby/);
  const g2 = createGame({ config: CONFIG });
  assert.throws(() => g2.start([{ id: "a", name: "A" }]), RangeError);
  g2.destroy();
});

test("missing bids resolve to 0 at the deadline and the purchase is applied at once", () => {
  const { clock, game } = setup();
  game.bid("p1", { auction: 1, amount: 30, locked: false });
  clock.advance(20000);
  assert.equal(game.phase, "reveal");
  assert.equal(game.revealStep, "bids");
  const entry = game.history[0];
  assert.deepEqual(entry.bids, { p1: 30, p2: 0 });
  assert.deepEqual(entry.buyers, ["p1"]);
  assert.deepEqual(entry.sellers, ["p2"]);
  assert.equal(entry.topBid, 30);
  assert.equal(entry.void, false);
  assert.deepEqual(entry.purchase, { p1: 0, p2: 0 });
  assert.equal(entry.flipped, null);
  assert.equal(entry.hits, null);
  assert.equal(entry.payouts, null);
  assert.equal(entry.deltas, null);
  assert.equal(entry.runout, false);
  assert.deepEqual(Object.keys(entry).sort(), ["bids", "buyers", "deltas", "flipped", "hits", "index", "payouts", "purchase", "reference", "runout", "sellers", "topBid", "void"]);
  assert.deepEqual(game.stakes, [{ auction: 1, suit: entry.reference, buyers: ["p1"], sellers: ["p2"] }]);
});

test("all locked resolves early and the stale deadline is harmless", () => {
  const { clock, game, changes } = setup();
  game.bid("p1", { auction: 1, amount: 30, locked: true });
  assert.equal(game.phase, "bidding");
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  assert.equal(game.phase, "reveal");
  assert.equal(game.history.length, 1);
  clock.advance(CONFIG.revealBidsMs);
  assert.equal(game.revealStep, "card");
  assert.ok(game.history[0].flipped);
  clock.advance(CONFIG.revealCardMs);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 2);
  // changes[0..1] are setup()'s own start() ("dealing:null") and the auto-
  // advance into auction 1 ("bidding:null"); then: p1's lock alone isn't
  // allLocked yet, so bid() fires onChange itself ("bidding:null") before
  // p2's lock makes allLocked() true and resolve() takes over ("reveal:bids");
  // then the reveal timers fire flipAndSettle ("reveal:card") and
  // advance/startAuction(2) ("bidding:null").
  assert.deepEqual(changes, ["dealing:null", "bidding:null", "bidding:null", "reveal:bids", "reveal:card", "bidding:null"]);
  // The original 20 s deadline would have fired by now. Auction 2 must be intact.
  clock.advance(14500);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 2);
  assert.equal(game.history.length, 1);
});

test("a lock and the deadline at the same instant settle exactly once, in either order", () => {
  // Order 1: the lock lands just before the deadline fires.
  const first = setup();
  first.game.bid("p1", { auction: 1, amount: 30, locked: true });
  first.clock.advance(19999);
  first.game.bid("p2", { auction: 1, amount: 10, locked: true });
  first.clock.advance(1);
  assert.equal(first.game.history.length, 1);
  assert.deepEqual(first.game.history[0].bids, { p1: 30, p2: 10 });
  // Order 2: the deadline fires first. The fake clock runs timers due at the
  // same time in arming order, and the game armed its deadline at start, so a
  // bid scheduled for exactly 20000 runs after the deadline resolved.
  const second = setup();
  second.game.bid("p1", { auction: 1, amount: 30, locked: true });
  const late = [];
  second.clock.setTimeout(() => late.push(second.game.bid("p2", { auction: 1, amount: 10, locked: true })), 20000);
  second.clock.advance(20000);
  assert.equal(second.game.history.length, 1);
  assert.deepEqual(second.game.history[0].bids, { p1: 30, p2: 0 });
  assert.deepEqual(late, [{ ok: false, error: "not_bidding" }]);
});

test("purchase at resolve, payout at the flip, and the flipped card becomes the reference", () => {
  // Identity shuffle: p1 holds 10 spades, p2 holds 10 hearts, and the deck is
  // those hands in order, so cards 1..10 are spades and 11..20 hearts.
  const { clock, game } = setup();
  assert.equal(game.reference(), "spades");
  game.bid("p1", { auction: 1, amount: 40, locked: true });
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  const entry = game.history[0];
  assert.deepEqual(entry.purchase, { p1: -10, p2: 10 });
  assert.equal(game.players[0].score, -10, "the buyer pays the seller's bid at resolve");
  assert.equal(game.players[1].score, 10);
  assert.deepEqual(game.stakes, [{ auction: 1, suit: "spades", buyers: ["p1"], sellers: ["p2"] }]);
  clock.advance(CONFIG.revealBidsMs);
  assert.equal(entry.flipped, "spades");
  assert.equal(entry.hits, 1);
  assert.deepEqual(entry.payouts, [{ from: "p2", to: "p1", amount: 10 }]);
  assert.deepEqual(entry.deltas, { p1: 0, p2: 0 });
  assert.equal(game.players[0].score, 0);
  assert.equal(game.players[1].score, 0);
  assert.equal(game.reference(), "spades");
  assert.equal(game.flipIndex, 2);
});

test("bid validation", () => {
  const { game } = setup();
  assert.deepEqual(game.bid("p1", { auction: 2, amount: 5, locked: false }), { ok: false, error: "stale_auction" });
  assert.deepEqual(game.bid("zz", { auction: 1, amount: 5, locked: false }), { ok: false, error: "unknown_player" });
  assert.deepEqual(game.bid("p1", { auction: 1, amount: 101, locked: false }), { ok: false, error: "bad_amount" });
  assert.deepEqual(game.bid("p1", { auction: 1, amount: 2.5, locked: false }), { ok: false, error: "bad_amount" });
  assert.deepEqual(game.bid("p1", { auction: 1, amount: -1, locked: false }), { ok: false, error: "bad_amount" });
  assert.deepEqual(game.bid("p1", { auction: 1, amount: 0, locked: false }), { ok: true });
});

test("a disconnected player's stored bid survives and counts as locked", () => {
  const { game } = setup();
  game.bid("p2", { auction: 1, amount: 12, locked: false });
  game.setConnected("p2", false);
  assert.equal(game.phase, "bidding");
  assert.deepEqual(game.bid("p2", { auction: 1, amount: 50, locked: true }), { ok: false, error: "disconnected" });
  game.bid("p1", { auction: 1, amount: 30, locked: true });
  assert.equal(game.phase, "reveal");
  assert.deepEqual(game.history[0].bids, { p1: 30, p2: 12 });
});

test("disconnecting the last unlocked player resolves the auction", () => {
  const { game } = setup();
  game.bid("p1", { auction: 1, amount: 30, locked: true });
  game.setConnected("p2", false);
  assert.equal(game.phase, "reveal");
});

test("bots bid inside the window and are locked", () => {
  const seats = [
    { id: "p1", name: "Ann", isBot: false, connected: true },
    { id: "b1", name: "Bot Ada", isBot: true, connected: true, profile: { key: "keen", shade: 1, sigma: 0 } }
  ];
  const { clock, game } = setup({ seats });
  clock.advance(6000);
  assert.ok(game.auction.bids.b1, "bot has bid");
  assert.equal(game.auction.bids.b1.locked, true);
  assert.ok(game.auction.bids.b1.amount >= 0 && game.auction.bids.b1.amount <= 100);
  assert.equal(game.phase, "bidding");
  game.bid("p1", { auction: 1, amount: 1, locked: true });
  assert.equal(game.phase, "reveal");
});

test("a void auction buys nothing but older stakes still pay on its flip", () => {
  const { clock, game } = setup();
  game.bid("p1", { auction: 1, amount: 40, locked: true });
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  clock.advance(CONFIG.revealBidsMs + CONFIG.revealCardMs);
  assert.equal(game.auction.index, 2);
  game.bid("p1", { auction: 2, amount: 0, locked: true });
  game.bid("p2", { auction: 2, amount: 0, locked: true });
  const entry = game.history[1];
  assert.equal(entry.void, true);
  assert.deepEqual(entry.buyers, []);
  assert.deepEqual(entry.sellers, []);
  assert.deepEqual(entry.purchase, { p1: 0, p2: 0 });
  assert.equal(game.stakes.length, 1, "no stake for a void auction");
  clock.advance(CONFIG.revealBidsMs);
  assert.equal(entry.flipped, "spades");
  assert.equal(entry.hits, 1);
  assert.deepEqual(entry.payouts, [{ from: "p2", to: "p1", amount: 10 }]);
  assert.deepEqual(entry.deltas, { p1: 10, p2: -10 });
  assert.equal(game.players[0].score, 10);
  assert.equal(game.players[1].score, -10);
  assert.equal(game.flipIndex, 3);
});

test("an older stake pays on a flip of its suit while the current reference is another suit", () => {
  const { clock, game } = setup();
  // The state machine only reads the deck, so hand-build one: spades on top,
  // then a heart, then a spade, then the rest.
  game.deck = ["spades", "hearts", "spades", ...Array(17).fill("hearts")];
  assert.equal(game.reference(), "spades");
  game.bid("p1", { auction: 1, amount: 40, locked: true });
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  clock.advance(CONFIG.revealBidsMs);
  assert.equal(game.history[0].flipped, "hearts");
  assert.equal(game.history[0].hits, 0, "a heart pays no spades stake");
  assert.deepEqual(game.history[0].deltas, { p1: -10, p2: 10 });
  clock.advance(CONFIG.revealCardMs);
  assert.equal(game.auction.index, 2);
  assert.equal(game.reference(), "hearts");
  game.bid("p1", { auction: 2, amount: 5, locked: true });
  game.bid("p2", { auction: 2, amount: 30, locked: true });
  assert.deepEqual(game.stakes.map((st) => st.suit), ["spades", "hearts"]);
  clock.advance(CONFIG.revealBidsMs);
  const entry = game.history[1];
  assert.equal(entry.flipped, "spades");
  assert.equal(entry.hits, 1, "the spades stake from auction 1 pays although hearts is the reference");
  assert.deepEqual(entry.payouts, [{ from: "p2", to: "p1", amount: 10 }]);
  // purchase: p2 bought hearts and paid p1's bid of 5; payout: p2 pays p1 10 on the spade.
  assert.deepEqual(entry.purchase, { p1: 5, p2: -5 });
  assert.deepEqual(entry.deltas, { p1: 15, p2: -15 });
  assert.equal(game.players[0].score, -10 + 15);
  assert.equal(game.players[1].score, 10 - 15);
});

function playWholeGame(clock, game) {
  while (game.phase !== "results") {
    if (game.phase === "bidding") {
      for (const p of game.players) if (!p.isBot) game.bid(p.id, { auction: game.auction.index, amount: p.id === "p1" ? 25 : 10, locked: true });
    }
    clock.advance(CONFIG.revealBidsMs);
    clock.advance(CONFIG.revealCardMs);
  }
}

test("the last auction leads to results with hands revealed and no pending timers", () => {
  const { clock, game } = setup();
  playWholeGame(clock, game);
  assert.equal(game.phase, "results");
  assert.equal(game.history.length, 19);
  assert.equal(game.stakes.length, 15, "one stake per auction; the runout has none");
  const runout = game.history.filter((h) => h.runout);
  assert.deepEqual(runout.map((h) => h.index), [16, 17, 18, 19]);
  assert.ok(runout.every((h) => Object.keys(h.bids).length === 0 && h.buyers.length === 0 && h.sellers.length === 0 && h.topBid === null && h.flipped === "hearts"));
  // Cards 11..20 are hearts and p1 bought hearts at auctions 11..15. Card 15
  // (auction 14's flip) pays four stakes at 10; card 16 (auction 15's flip,
  // the first runout card) pays five stakes at 20; so does card 17 (runout 16).
  assert.deepEqual(game.history[13].payouts, [{ from: "p2", to: "p1", amount: 40 }]);
  assert.equal(game.history[14].hits, 5);
  assert.deepEqual(game.history[14].payouts, [{ from: "p2", to: "p1", amount: 100 }]);
  assert.deepEqual(game.history[15].payouts, [{ from: "p2", to: "p1", amount: 100 }]);
  assert.ok(game.history.every((h) => h.deltas !== null && h.payouts !== null && h.hits !== null));
  const totals = { p1: 0, p2: 0 };
  for (const h of game.history) for (const id of Object.keys(totals)) totals[id] += h.deltas[id];
  assert.equal(totals.p1, game.players[0].score, "score is the sum of round deltas");
  assert.equal(totals.p2, game.players[1].score);
  assert.equal(game.cardsRemaining(), 0);
  assert.equal(game.auction, null);
  assert.equal(clock.pending(), 0);
  assert.equal(game.players[0].hand.length, 10);
  const sum = game.players.reduce((a, p) => a + p.score, 0);
  assert.equal(sum, 0);
});

test("runout steps refuse bids, report no time left, and lead to results", () => {
  const { clock, game } = setup();
  while (!(game.auction && game.auction.runout)) {
    if (game.phase === "bidding") for (const p of game.players) game.bid(p.id, { auction: game.auction.index, amount: p.id === "p1" ? 25 : 10, locked: true });
    clock.advance(CONFIG.revealBidsMs);
    clock.advance(CONFIG.revealCardMs);
  }
  assert.equal(game.phase, "reveal");
  assert.equal(game.revealStep, "card");
  assert.equal(game.auction.index, 16);
  assert.equal(game.remainingMs(), 0);
  assert.deepEqual(game.bid("p1", { auction: 16, amount: 10, locked: true }), { ok: false, error: "not_bidding" });
  assert.equal(game.history.length, 16);
  assert.equal(game.history[15].runout, true);
  assert.equal(game.history[15].flipped, "hearts");
  assert.equal(game.stakes.length, 15);
  assert.equal(clock.pending(), 1, "one runout timer");
  clock.advance(CONFIG.revealCardMs * 3);
  assert.equal(game.phase, "reveal");
  assert.equal(game.auction.index, 19);
  clock.advance(CONFIG.revealCardMs);
  assert.equal(game.phase, "results");
  assert.equal(game.auction, null);
  assert.equal(game.cardsRemaining(), 0);
  assert.equal(clock.pending(), 0);
});

test("two consecutive full games in one instance share no state", () => {
  const { clock, game } = setup();
  playWholeGame(clock, game);
  const firstHandSize = game.players[0].hand.length;
  assert.equal(game.returnToLobby(), true);
  assert.equal(game.phase, "lobby");
  assert.deepEqual(game.history, []);
  assert.deepEqual(game.stakes, []);
  assert.deepEqual(game.players, []);
  game.start([
    { id: "p1", name: "Ann", isBot: false, connected: true },
    { id: "p2", name: "Ben", isBot: false, connected: true },
    { id: "p3", name: "Cat", isBot: false, connected: true }
  ]);
  assert.equal(game.matchId, 2);
  assert.equal(game.phase, "dealing");
  clock.advance(CONFIG.dealMs);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 1);
  assert.deepEqual(game.history, []);
  assert.deepEqual(game.stakes, []);
  assert.equal(game.deck.length, 21);
  assert.equal(game.flipIndex, 1);
  assert.equal(game.players.every((p) => p.score === 0), true);
  assert.equal(clock.pending(), 1);
  playWholeGame(clock, game);
  assert.equal(game.phase, "results");
  assert.equal(game.history.length, 20);
  assert.equal(game.history.every((h) => h.index >= 1 && h.index <= 20 && h.deltas !== null), true);
  assert.equal(game.players.length, 3);
  assert.equal(game.players.reduce((a, p) => a + p.score, 0), 0);
  assert.equal(clock.pending(), 0);
  assert.notEqual(game.players[0].hand.length, firstHandSize, "three players deal a different hand size than two");
});

test("returnToLobby is refused outside results", () => {
  const { game } = setup();
  assert.equal(game.returnToLobby(), false);
});

test("destroy clears timers", () => {
  const { clock, game } = setup();
  game.destroy();
  assert.equal(clock.pending(), 0);
});

test("game defaults match the server config defaults", () => {
  const { DEFAULT_CONFIG } = require("../lib/game.js");
  const { readConfig } = require("../lib/config.js");
  assert.deepEqual(DEFAULT_CONFIG, readConfig({}).game);
});
