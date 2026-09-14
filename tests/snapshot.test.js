const test = require("node:test");
const assert = require("node:assert/strict");
const { createGame } = require("../lib/game.js");
const { buildState } = require("../lib/snapshot.js");
const { createClock } = require("./helpers/clock.js");

function makeRoom() {
  const clock = createClock();
  const game = createGame({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomInt: (n) => n - 1, random: () => 0.5 });
  const seats = new Map([
    ["p1", { id: "p1", name: "Ann", isBot: false, connected: true }],
    ["p2", { id: "p2", name: "Ben", isBot: false, connected: true }],
    ["p3", { id: "p3", name: "Bot Ada", isBot: true, connected: true, profile: { key: "keen", shade: 1, sigma: 0 } }]
  ]);
  const room = { code: "abcd", seats, game };
  return { clock, game, room };
}

// Exact allowlists. Anything not listed here is a leak, whatever it is called.
const STATE_KEYS = ["type", "room", "phase", "matchId", "revealStep", "remainingMs", "timing", "you", "players", "reference", "flipped", "cardsRemaining", "auctionIndex", "hand", "myBid", "history", "stakes", "minPlayers", "maxPlayers", "handSize"].sort();
const VISITOR_KEYS = ["type", "room", "phase", "you", "playerCount", "maxPlayers"].sort();
const PLAYER_KEYS = ["id", "name", "isBot", "connected", "score"];
const HISTORY_KEYS = ["index", "reference", "bids", "buyers", "sellers", "topBid", "void", "runout", "purchase", "flipped", "hits", "payouts", "deltas"].sort();

function assertShape(state) {
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS);
  for (const p of state.players) {
    const allowed = [...PLAYER_KEYS];
    if (state.phase === "bidding") allowed.push("locked");
    if (state.phase === "results") allowed.push("hand");
    assert.deepEqual(Object.keys(p).sort(), allowed.sort(), `player ${p.id} keys`);
  }
  for (const h of state.history) assert.deepEqual(Object.keys(h).sort(), HISTORY_KEYS);
  assert.equal(JSON.stringify(state).includes("shade"), false, "bot profile leaked");
}

test("dealing snapshot has own hand, reference, null auction, timing, and no deck", () => {
  const { room, game } = makeRoom();
  game.start([...room.seats.values()]);
  const s = buildState(room, "p1");
  assert.equal(s.phase, "dealing");
  assert.equal(s.revealStep, null);
  assert.equal(s.auctionIndex, null);
  assert.equal(s.hand.length, 7);
  assert.ok(s.reference);
  assert.equal(s.flipped.length, 1);
  assert.equal(s.cardsRemaining, 20);
  assert.equal(s.remainingMs, 9500);
  assert.deepEqual(s.timing, { dealMs: 9500, bidMs: 60000, revealBidsMs: 4500, revealCardMs: 6000 });
  assert.equal(s.myBid, null);
  assert.deepEqual(s.history, []);
  assert.equal(s.players.every((p) => !("hand" in p) && !("locked" in p)), true);
  assertShape(s);
  const text = JSON.stringify(s);
  assert.equal(text.includes('"deck"'), false);
  const other = buildState(room, "p2");
  assert.notDeepEqual(other.hand, s.hand, "each recipient sees only their own hand");
  const visitor = buildState(room, null);
  assert.equal(visitor.phase, "dealing");
  assert.equal(visitor.playerCount, 3);
});

test("lobby snapshot lists seats and hides nothing sensitive", () => {
  const { room } = makeRoom();
  const s = buildState(room, "p1");
  assert.equal(s.type, "state");
  assert.equal(s.room, "abcd");
  assert.equal(s.phase, "lobby");
  assert.equal(s.you, "p1");
  assert.deepEqual(s.players.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.equal(s.players[2].isBot, true);
  assert.equal(s.hand, null);
  assert.deepEqual(s.stakes, []);
  assert.equal(s.minPlayers, 2);
  assert.equal(s.maxPlayers, 4);
  assertShape(s);
  const visitor = buildState(room, null);
  assert.deepEqual(Object.keys(visitor).sort(), VISITOR_KEYS);
  assert.equal(visitor.you, null);
  assert.equal(visitor.playerCount, 3);
  assert.equal(visitor.phase, "lobby");
});

test("visitors get nothing about a running match", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  clock.advance(game.timing.bidMs);
  const visitor = buildState(room, null);
  assert.deepEqual(Object.keys(visitor).sort(), VISITOR_KEYS);
  assert.equal(visitor.phase, "reveal");
  assert.equal(visitor.playerCount, 3);
});

test("a disconnected human reads as locked, a bot only once it has bid", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  game.setConnected("p2", false);
  const s = buildState(room, "p1");
  assert.equal(s.players.find((p) => p.id === "p2").locked, true);
  assert.equal(s.players.find((p) => p.id === "p3").locked, false);
  assert.equal(s.players.find((p) => p.id === "p1").locked, false);
});

test("bidding snapshot shows own hand and bid, others' lock flags only", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  game.bid("p2", { auction: 1, amount: 33, locked: true });
  const s1 = buildState(room, "p1");
  assert.equal(s1.phase, "bidding");
  assert.equal(s1.auctionIndex, 1);
  assert.equal(s1.remainingMs, game.timing.bidMs);
  assert.equal(s1.hand.length, 7);
  assert.deepEqual(s1.hand, game.players[0].hand);
  assert.equal(s1.myBid, null);
  assert.equal(s1.players.find((p) => p.id === "p2").locked, true);
  assert.equal(s1.players.find((p) => p.id === "p1").locked, false);
  assert.equal(s1.flipped.length, 1);
  assert.equal(s1.reference, game.deck[0]);
  assert.equal(s1.cardsRemaining, 20);
  assert.equal(s1.handSize, 7);
  assertShape(s1);
  const s2 = buildState(room, "p2");
  assert.deepEqual(s2.myBid, { amount: 33, locked: true });
  assert.deepEqual(s2.hand, game.players[1].hand);
});

test("a resumed recipient mid-bidding gets the same public record", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  for (const id of ["p1", "p2"]) game.bid(id, { auction: 1, amount: 20, locked: true });
  clock.advance(6000);
  clock.advance(4500 + 6000);
  assert.equal(game.auction.index, 2);
  const a = buildState(room, "p1");
  const b = buildState(room, "p2");
  assert.equal(a.history.length, 1);
  assert.deepEqual(a.history, b.history);
  assert.ok(a.history[0].flipped);
  assert.deepEqual(a.history[0].bids, game.history[0].bids);
});

test("reveal(bids) snapshot exposes the current auction's bids via history only", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  clock.advance(game.timing.bidMs);
  const s = buildState(room, "p1");
  assert.equal(s.phase, "reveal");
  assert.equal(s.revealStep, "bids");
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].flipped, null);
  assert.equal(s.myBid, null);
  assert.equal(s.remainingMs, 0);
  assertShape(s);
});

test("reveal(bids) snapshot carries the purchase in scores, the stake, and copies rather than references", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  game.bid("p1", { auction: 1, amount: 30, locked: true });
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  clock.advance(6000);
  assert.equal(game.phase, "reveal");
  const s = buildState(room, "p1");
  const h = s.history[0];
  for (const p of s.players) assert.equal(p.score, h.purchase[p.id], `${p.id} score is the purchase delta`);
  assert.equal(s.players.reduce((a, p) => a + p.score, 0), 0);
  assert.equal(h.void, false);
  assert.equal(h.flipped, null);
  assert.equal(h.hits, null);
  assert.equal(h.payouts, null);
  assert.equal(h.deltas, null);
  assert.equal(s.stakes.length, 1);
  assert.deepEqual(s.stakes[0], game.stakes[0]);
  s.stakes[0].buyers.push("zzz");
  s.history[0].purchase.p1 = 999;
  s.history[0].sellers.push("zzz");
  assert.equal(game.stakes[0].buyers.includes("zzz"), false, "stake arrays are copied");
  assert.notEqual(game.history[0].purchase.p1, 999, "purchase is copied");
  assert.equal(game.history[0].sellers.includes("zzz"), false, "sellers are copied");
  assertShape(s);
  clock.advance(4500);
  const c = buildState(room, "p2");
  assert.ok(Array.isArray(c.history[0].payouts));
  assert.equal(typeof c.history[0].hits, "number");
  c.history[0].payouts.push({ from: "x", to: "y", amount: 1 });
  assert.equal(game.history[0].payouts.some((p) => p.from === "x"), false, "payouts are copied");
  assertShape(c);
});

test("results snapshot reveals every hand", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  clock.advance(9500);
  while (game.phase !== "results") {
    if (game.phase === "bidding") for (const id of ["p1", "p2"]) game.bid(id, { auction: game.auction.index, amount: 20, locked: true });
    clock.advance(6000);
    clock.advance(10500);
  }
  const s = buildState(room, "p2");
  assert.equal(s.phase, "results");
  for (const p of s.players) assert.equal(p.hand.length, 7);
  assert.equal(s.history.length, 20);
  assertShape(s);
});
