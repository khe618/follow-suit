const test = require("node:test");
const assert = require("node:assert/strict");
const { SUITS, countSuits, deal } = require("../public/game-core.js");
const { nextSuitProbabilities, expectedRemaining, fairValue } = require("../lib/fair-value.js");

const zero = () => ({ spades: 0, hearts: 0, diamonds: 0, clubs: 0 });
const sum = (p) => SUITS.reduce((a, s) => a + p[s], 0);

// mulberry32: a small seeded PRNG so the Monte Carlo below is reproducible.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("probabilities sum to 1", () => {
  const p = nextSuitProbabilities({ hand: { spades: 4, hearts: 3, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 2, clubs: 0 }, playerCount: 2 });
  assert.ok(Math.abs(sum(p) - 1) < 1e-12);
});

test("suits held in equal numbers are equally likely with no flips", () => {
  const p = nextSuitProbabilities({ hand: { spades: 3, hearts: 3, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 });
  assert.ok(Math.abs(p.spades - p.hearts) < 1e-12);
  assert.ok(Math.abs(p.diamonds - p.clubs) < 1e-12);
  assert.ok(p.spades > p.diamonds);
});

test("with no flips the answer equals the closed form (hand + expected unseen) / deck", () => {
  // Two players, hand 6/2/2/0. The 10 unseen deck cards (the other hand) are
  // independent uniform draws, so each suit expects 10/4 of them regardless
  // of what this hand holds: E[deck spades] = 6 + 2.5 and P(spades) = that / 20.
  const p = nextSuitProbabilities({ hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 });
  const expected = {
    spades: (6 + 2.5) / 20,
    hearts: (2 + 2.5) / 20,
    diamonds: (2 + 2.5) / 20,
    clubs: (0 + 2.5) / 20
  };
  for (const s of SUITS) assert.ok(Math.abs(p[s] - expected[s]) < 1e-9, `${s}: ${p[s]} vs ${expected[s]}`);
  assert.ok(Math.abs(p.spades - 0.425) < 1e-9);
});

test("a hand says nothing about the other hands, only about the deck it joins", () => {
  // Same deck size, same flips, different holding: under the equal-probability
  // deal the unseen part is 2.5 of each suit either way, so the whole
  // difference between the two answers is the hand itself.
  const a = expectedRemaining({ hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 });
  const b = expectedRemaining({ hand: { spades: 1, hearts: 3, diamonds: 3, clubs: 3 }, flips: zero(), playerCount: 2 });
  assert.ok(Math.abs((a.spades - b.spades) - 5) < 1e-9, `${a.spades} vs ${b.spades}`);
});

test("flipping a suit lowers it", () => {
  const before = nextSuitProbabilities({ hand: { spades: 3, hearts: 3, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 });
  const after = nextSuitProbabilities({ hand: { spades: 3, hearts: 3, diamonds: 2, clubs: 2 }, flips: { spades: 4, hearts: 0, diamonds: 0, clubs: 0 }, playerCount: 2 });
  assert.ok(after.spades < before.spades);
});

test("expectedRemaining sums to the cards left in the deck", () => {
  const e = expectedRemaining({ hand: { spades: 4, hearts: 3, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 2, clubs: 0 }, playerCount: 2 });
  assert.ok(Math.abs(sum(e) - 17) < 1e-9, String(sum(e)));
});

test("expectedRemaining with no flips equals hand + expected unseen", () => {
  // Two players, hand 6/2/2/0: the other hand is 10 independent uniform
  // draws, so 2.5 of each suit.
  const e = expectedRemaining({ hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 });
  const expected = { spades: 8.5, hearts: 4.5, diamonds: 4.5, clubs: 2.5 };
  for (const s of SUITS) assert.ok(Math.abs(e[s] - expected[s]) < 1e-9, `${s}: ${e[s]} vs ${expected[s]}`);
});

test("flipping a card of a suit lowers that suit by less than one card and raises no other suit", () => {
  const args = { hand: { spades: 3, hearts: 3, diamonds: 2, clubs: 2 }, playerCount: 2 };
  const before = expectedRemaining({ ...args, flips: zero() });
  const after = expectedRemaining({ ...args, flips: { spades: 1, hearts: 0, diamonds: 0, clubs: 0 } });
  assert.ok(after.spades < before.spades);
  assert.ok(after.spades > before.spades - 1);
  for (const s of ["hearts", "diamonds", "clubs"]) assert.ok(after[s] <= before[s] + 1e-12, s);
});

test("fairValue is cardValue(cards left) times the expected remaining count of the reference suit", () => {
  const args = { hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 };
  const e = expectedRemaining(args);
  // 20 cards left, the last 5 double: each expected card is worth 10 * 25 / 20 = 12.5.
  assert.ok(Math.abs(fairValue({ ...args, reference: "spades" }) - 12.5 * e.spades) < 1e-9);
  assert.ok(Math.abs(fairValue({ ...args, reference: "spades" }) - 12.5 * 8.5) < 1e-9);
  const late = { hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: { spades: 5, hearts: 5, diamonds: 3, clubs: 2 }, playerCount: 2 };
  // 5 cards left, all of them double.
  assert.ok(Math.abs(fairValue({ ...late, reference: "clubs" }) - 20 * expectedRemaining(late).clubs) < 1e-9);
});

test("nextSuitProbabilities is expectedRemaining divided by the cards left", () => {
  const args = { hand: { spades: 4, hearts: 3, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 1, diamonds: 0, clubs: 0 }, playerCount: 2 };
  const p = nextSuitProbabilities(args);
  const e = expectedRemaining(args);
  for (const s of SUITS) assert.ok(Math.abs(p[s] - e[s] / 18) < 1e-12, s);
});

test("rejects a hand of the wrong size", () => {
  assert.throws(() => nextSuitProbabilities({ hand: { spades: 1, hearts: 0, diamonds: 0, clubs: 0 }, flips: zero(), playerCount: 2 }), RangeError);
});

// Monte Carlo of the real procedure, conditioning by rejection on both the
// hand and the flips.
function monteCarlo({ hand, flips, playerCount }, samples, random) {
  const k = sum(flips);
  const hits = zero();
  let accepted = 0;
  const randomInt = (m) => Math.floor(random() * m);
  while (accepted < samples) {
    // Flip the deck deal() returned, not a fresh shuffle of the same cards:
    // this way the test would notice a deck that stopped being shuffled, or
    // shuffled with a bias, instead of quietly re-deriving it.
    const { hands, deck } = deal(playerCount, randomInt);
    const hc = countSuits(hands[0]);
    if (SUITS.some((s) => hc[s] !== hand[s])) continue;
    const fc = countSuits(deck.slice(0, k));
    if (SUITS.some((s) => fc[s] !== flips[s])) continue;
    hits[deck[k]] += 1;
    accepted += 1;
  }
  const out = zero();
  for (const s of SUITS) out[s] = hits[s] / accepted;
  return out;
}

// The cases use hands that occur a few percent of the time and at most one
// flip, so rejection sampling accepts a few percent of draws and 100k accepted
// samples take seconds, not minutes. Standard error is about 0.0014 per suit,
// and the seed is fixed, so the outcome is deterministic. The rare
// six-of-a-suit hand is covered by the closed-form test above.
test("agrees with a seeded Monte Carlo of the dealing procedure", { timeout: 180000 }, () => {
  const cases = [
    { hand: { spades: 3, hearts: 3, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 },
    { hand: { spades: 2, hearts: 1, diamonds: 1, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 0, clubs: 0 }, playerCount: 4 }
  ];
  const random = seeded(20260913);
  for (const c of cases) {
    const exact = nextSuitProbabilities(c);
    const mc = monteCarlo(c, 100000, random);
    for (const s of SUITS) assert.ok(Math.abs(exact[s] - mc[s]) < 0.005, `${JSON.stringify(c)} ${s}: exact ${exact[s]} mc ${mc[s]}`);
  }
});
