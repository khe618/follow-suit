const test = require("node:test");
const assert = require("node:assert/strict");
const GameCore = require("../public/game-core.js");
const { SUITS, HAND_SIZES, CARD_PAYOUT, RUNOUT_CARDS, RUNOUT_MULTIPLIER, isRunoutCard, cardValue, handSize, buildPool, shuffle, countSuits, deal, resolveBids, settlePurchase, settleFlip, priorValue, rank } = GameCore;

// Deterministic randomInt: always picks the last index, so shuffle is identity.
const identityRandom = (n) => n - 1;

test("hand-size table matches the spec", () => {
  assert.deepEqual(HAND_SIZES, { 2: 10, 3: 7, 4: 5 });
  assert.equal(handSize(2), 10);
  assert.throws(() => handSize(1), RangeError);
  assert.throws(() => handSize(5), RangeError);
});

test("pool is 10 of each suit", () => {
  assert.deepEqual(countSuits(buildPool()), { spades: 10, hearts: 10, diamonds: 10, clubs: 10 });
});

test("shuffle returns a permutation and does not mutate its input", () => {
  const input = buildPool();
  const copy = input.slice();
  const out = shuffle(input);
  assert.deepEqual(input, copy);
  assert.equal(out.length, 40);
  assert.deepEqual(countSuits(out), countSuits(input));
});

for (const playerCount of [2, 3, 4]) {
  test(`deal(${playerCount}) sizes and multiset invariant`, () => {
    const n = handSize(playerCount);
    const { hands, deck } = deal(playerCount);
    assert.equal(hands.length, playerCount);
    for (const hand of hands) assert.equal(hand.length, n);
    assert.equal(deck.length, playerCount * n);
    const dealtCounts = countSuits(hands.flat());
    assert.deepEqual(countSuits(deck), dealtCounts);
    for (const s of SUITS) assert.ok(dealtCounts[s] <= 10, `${s} exceeds pool`);
  });
}

test("deal with identity random is reproducible", () => {
  const a = deal(3, identityRandom);
  const b = deal(3, identityRandom);
  assert.deepEqual(a, b);
});

test("resolveBids: highest wins, ties are all buyers, all-tie is void", () => {
  assert.deepEqual(resolveBids({ a: 80, b: 50, c: 20 }), { topBid: 80, buyers: ["a"], sellers: ["b", "c"], void: false });
  assert.deepEqual(resolveBids({ a: 60, b: 60, c: 30, d: 10 }), { topBid: 60, buyers: ["a", "b"], sellers: ["c", "d"], void: false });
  assert.deepEqual(resolveBids({ a: 0, b: 0 }), { topBid: 0, buyers: [], sellers: [], void: true });
  assert.deepEqual(resolveBids({ a: 7, b: 7, c: 7 }), { topBid: 7, buyers: [], sellers: [], void: true });
});

test("settlePurchase: each buyer pays each seller that seller's bid", () => {
  assert.equal(CARD_PAYOUT, 10);
  assert.deepEqual(settlePurchase({ a: 80, b: 50, c: 20 }).deltas, { a: -70, b: 50, c: 20 });
  assert.deepEqual(settlePurchase({ a: 60, b: 60, c: 30, d: 10 }).deltas, { a: -40, b: -40, c: 60, d: 20 });
  const cheap = settlePurchase({ a: 5, b: 0, c: 0 });
  assert.deepEqual(cheap.deltas, { a: 0, b: 0, c: 0 });
  assert.deepEqual(cheap.buyers, ["a"]);
  assert.deepEqual(cheap.sellers, ["b", "c"]);
  const v = settlePurchase({ a: 0, b: 0 });
  assert.equal(v.void, true);
  assert.deepEqual(v.buyers, []);
  assert.deepEqual(v.sellers, []);
  assert.deepEqual(v.deltas, { a: 0, b: 0 });
  assert.equal(settlePurchase({ a: 7, b: 7, c: 7 }).void, true);
});

test("settlePurchase is zero-sum for every buyer/seller split", () => {
  const cases = [
    { a: 100, b: 0 }, { a: 33, b: 33, c: 12 }, { a: 1, b: 2, c: 3, d: 4 },
    { a: 50, b: 50, c: 50, d: 49 }, { a: 0, b: 1 }, { a: 9, b: 9 }
  ];
  for (const bids of cases) {
    const { deltas } = settlePurchase(bids);
    const sum = Object.values(deltas).reduce((x, y) => x + y, 0);
    assert.equal(sum, 0, JSON.stringify({ bids, deltas }));
  }
});

test("settleFlip pays every stake on the flipped suit, netted per pair, in player order", () => {
  const ids = ["a", "b", "c", "d"];
  const stakes = [
    { auction: 2, suit: "hearts", buyers: ["a"], sellers: ["b", "c", "d"] },
    { auction: 3, suit: "clubs", buyers: ["b"], sellers: ["a", "c", "d"] },
    { auction: 5, suit: "hearts", buyers: ["c"], sellers: ["a", "b", "d"] }
  ];
  const r = settleFlip(stakes, "hearts", ids);
  assert.equal(r.hits, 2);
  assert.deepEqual(r.payouts, [
    { from: "b", to: "a", amount: 10 }, { from: "b", to: "c", amount: 10 },
    { from: "d", to: "a", amount: 10 }, { from: "d", to: "c", amount: 10 }
  ]);
  assert.deepEqual(r.deltas, { a: 20, b: -20, c: 20, d: -20 });
  const single = settleFlip(stakes.slice(0, 1), "hearts", ["a", "b", "c", "d"]);
  assert.deepEqual(single.deltas, { a: 30, b: -10, c: -10, d: -10 });
  const tie = settleFlip([{ auction: 1, suit: "spades", buyers: ["a", "b"], sellers: ["c", "d"] }], "spades", ids);
  assert.deepEqual(tie.payouts, [
    { from: "c", to: "a", amount: 10 }, { from: "c", to: "b", amount: 10 },
    { from: "d", to: "a", amount: 10 }, { from: "d", to: "b", amount: 10 }
  ]);
  assert.deepEqual(tie.deltas, { a: 20, b: 20, c: -20, d: -20 });
});

test("settleFlip: no stakes on the suit, and opposing stakes that cancel", () => {
  const none = settleFlip([{ auction: 1, suit: "hearts", buyers: ["a"], sellers: ["b"] }], "clubs", ["a", "b"]);
  assert.deepEqual(none, { hits: 0, payouts: [], deltas: { a: 0, b: 0 } });
  assert.deepEqual(settleFlip([], "hearts", ["a", "b", "c"]), { hits: 0, payouts: [], deltas: { a: 0, b: 0, c: 0 } });
  const cancel = settleFlip([
    { auction: 1, suit: "hearts", buyers: ["a"], sellers: ["b"] },
    { auction: 3, suit: "hearts", buyers: ["b"], sellers: ["a"] }
  ], "hearts", ["a", "b"]);
  assert.deepEqual(cancel, { hits: 2, payouts: [], deltas: { a: 0, b: 0 } });
});

test("settleFlip is zero-sum", () => {
  const ids = ["a", "b", "c", "d"];
  const stakes = [
    { auction: 1, suit: "hearts", buyers: ["a", "b"], sellers: ["c", "d"] },
    { auction: 2, suit: "hearts", buyers: ["d"], sellers: ["a", "b", "c"] },
    { auction: 4, suit: "hearts", buyers: ["c"], sellers: ["a", "b", "d"] }
  ];
  const { deltas, payouts } = settleFlip(stakes, "hearts", ids);
  assert.equal(Object.values(deltas).reduce((x, y) => x + y, 0), 0);
  for (const p of payouts) assert.ok(p.amount > 0 && p.from !== p.to);
});

test("priorValue is the expected remaining count of the reference suit with no hand information", () => {
  // Auction 1 of a 4-player game: 19 cards remain, the last 5 of them pay double, one of the suit is out of 39 unseen pool cards.
  assert.equal(priorValue(["hearts"], 19), 55);
  assert.equal(priorValue(["hearts", "hearts", "hearts"], 17), Math.round(10 * 22 * 7 / 37));
  assert.equal(priorValue([], 19), 0);
  assert.equal(priorValue(["hearts"], 0), 0);
  assert.equal(priorValue(["hearts"], 1000), 100, "clamps at MAX_BID");
  for (let k = 1; k <= 20; k++) {
    const v = priorValue(Array(k).fill("spades"), 20 - k);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, String(v));
  }
});

test("runout: the last five cards pay double and a card's value scales with the doubled tail", () => {
  assert.equal(RUNOUT_CARDS, 5);
  assert.equal(RUNOUT_MULTIPLIER, 2);
  assert.equal(isRunoutCard(15, 20), false);
  assert.equal(isRunoutCard(16, 20), true);
  assert.equal(isRunoutCard(20, 20), true);
  assert.equal(isRunoutCard(16, 21), false);
  assert.equal(isRunoutCard(17, 21), true);
  assert.ok(Math.abs(cardValue(19) - 10 * 24 / 19) < 1e-12);
  assert.ok(Math.abs(cardValue(20) - 12.5) < 1e-12);
  assert.equal(cardValue(5), 20);
  assert.equal(cardValue(1), 20);
  assert.equal(cardValue(0), 0);
});

test("settleFlip takes the per-card amount, so a runout card pays double", () => {
  const stakes = [{ auction: 1, suit: "hearts", buyers: ["a"], sellers: ["b", "c"] }];
  assert.deepEqual(settleFlip(stakes, "hearts", ["a", "b", "c"], 20), { hits: 1, payouts: [{ from: "b", to: "a", amount: 20 }, { from: "c", to: "a", amount: 20 }], deltas: { a: 40, b: -20, c: -20 } });
  assert.deepEqual(settleFlip(stakes, "hearts", ["a", "b", "c"]).deltas, { a: 20, b: -10, c: -10 }, "default is CARD_PAYOUT");
});

test("rank uses competition ranking", () => {
  assert.deepEqual(rank({ a: 10, b: 30, c: 10, d: -5 }), [
    { id: "b", score: 30, rank: 1 },
    { id: "a", score: 10, rank: 2 },
    { id: "c", score: 10, rank: 2 },
    { id: "d", score: -5, rank: 4 }
  ]);
});
