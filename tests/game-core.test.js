const test = require("node:test");
const assert = require("node:assert/strict");
const GameCore = require("../public/game-core.js");
const { SUITS, HAND_SIZES, handSize, buildPool, shuffle, countSuits, deal, resolveBids, settle, rank } = GameCore;

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
  assert.deepEqual(resolveBids({ a: 80, b: 50, c: 20 }), { price: 80, buyers: ["a"], sellers: ["b", "c"], void: false });
  assert.deepEqual(resolveBids({ a: 60, b: 60, c: 30, d: 10 }), { price: 60, buyers: ["a", "b"], sellers: ["c", "d"], void: false });
  assert.deepEqual(resolveBids({ a: 0, b: 0 }), { price: 0, buyers: [], sellers: [], void: true });
  assert.deepEqual(resolveBids({ a: 7, b: 7, c: 7 }), { price: 7, buyers: [], sellers: [], void: true });
});

test("settle reproduces the spec's worked examples", () => {
  assert.deepEqual(settle({ a: 80, b: 50, c: 20 }, true).deltas, { a: 40, b: -20, c: -20 });
  assert.deepEqual(settle({ a: 80, b: 50, c: 20 }, false).deltas, { a: -160, b: 80, c: 80 });
  assert.deepEqual(settle({ a: 60, b: 60, c: 30, d: 10 }, true).deltas, { a: 80, b: 80, c: -80, d: -80 });
  assert.deepEqual(settle({ a: 60, b: 60, c: 30, d: 10 }, false).deltas, { a: -120, b: -120, c: 120, d: 120 });
  assert.deepEqual(settle({ a: 5, b: 0, c: 0 }, true).deltas, { a: 190, b: -95, c: -95 });
  assert.deepEqual(settle({ a: 5, b: 0, c: 0 }, false).deltas, { a: -10, b: 5, c: 5 });
  const v = settle({ a: 0, b: 0 }, true);
  assert.equal(v.void, true);
  assert.deepEqual(v.buyers, []);
  assert.deepEqual(v.deltas, { a: 0, b: 0 });
});

test("settle is zero-sum for every buyer/seller split", () => {
  const cases = [
    { a: 100, b: 0 }, { a: 33, b: 33, c: 12 }, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    { a: 50, b: 50, c: 50, d: 49 }, { a: 0, b: 1 }
  ];
  for (const bids of cases) for (const matched of [true, false]) {
    const { deltas } = settle(bids, matched);
    const sum = Object.values(deltas).reduce((x, y) => x + y, 0);
    assert.equal(sum, 0, JSON.stringify({ bids, matched, deltas }));
  }
});

test("rank uses competition ranking", () => {
  assert.deepEqual(rank({ a: 10, b: 30, c: 10, d: -5 }), [
    { id: "b", score: 30, rank: 1 },
    { id: "a", score: 10, rank: 2 },
    { id: "c", score: 10, rank: 2 },
    { id: "d", score: -5, rank: 4 }
  ]);
});
