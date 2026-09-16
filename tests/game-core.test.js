const test = require("node:test");
const assert = require("node:assert/strict");
const GameCore = require("../public/game-core.js");
const { SUITS, HAND_SIZES, CARD_PAYOUT, RUNOUT_CARDS, RUNOUT_MULTIPLIER, isRunoutCard, cardValue, handSize, shuffle, countSuits, deal, resolveBids, settlePurchase, settleFlip, rank } = GameCore;

// Deterministic randomInt: always picks the last index, so every suit draw
// is clubs and shuffle is the identity.
const identityRandom = (n) => n - 1;

test("hand-size table matches the spec", () => {
  assert.deepEqual(HAND_SIZES, { 2: 10, 3: 7, 4: 5 });
  assert.equal(handSize(2), 10);
  assert.throws(() => handSize(1), RangeError);
  assert.throws(() => handSize(5), RangeError);
});

test("shuffle returns a permutation and does not mutate its input", () => {
  const input = SUITS.flatMap((suit) => Array(10).fill(suit));
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
  });
}

test("deal draws every card independently with equal probability", () => {
  // randomInt is asked for a suit index (maxExclusive 4) per dealt card and
  // for shuffle positions; pinning the suit draws alone fixes the hands.
  const allSpades = (m) => (m === SUITS.length ? 0 : m - 1);
  const { hands } = deal(2, allSpades);
  assert.deepEqual(countSuits(hands.flat()), { spades: 20, hearts: 0, diamonds: 0, clubs: 0 },
    "no pool cap: a deal may be all one suit");

  // A player's hand carries no information about anyone else's, and suit
  // counts are not capped at the old 10 per suit. 4 players * 5 cards is 20
  // draws a deal; over many deals every suit lands about a quarter of them.
  const counts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
  let overTen = 0;
  for (let i = 0; i < 4000; i++) {
    const c = countSuits(deal(4).deck);
    for (const s of SUITS) {
      counts[s] += c[s];
      if (c[s] > 10) overTen += 1;
    }
  }
  const drawn = 4000 * 20;
  for (const s of SUITS) {
    const share = counts[s] / drawn;
    assert.ok(Math.abs(share - 0.25) < 0.02, `${s} share ${share}`);
  }
  assert.ok(overTen > 0, "a suit sometimes exceeds the old 10-card pool");
});

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
