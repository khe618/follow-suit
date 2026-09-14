# Suit Stakes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the next-card match bet with suit stakes: the highest bidder buys the reference suit from every other player at each seller's own bid, and every later flip of that suit pays the owner 10 per seller.

**Architecture:** Rules live in the shared UMD `public/game-core.js` (settlement, prior), the exact posterior in `lib/fair-value.js`, the state machine in `lib/game.js` (which now applies the purchase leg at resolve and the payout leg at the flip, and keeps a public `stakes` list), and the per-recipient message in `lib/snapshot.js`. The browser renders `players[].score` directly; `public/transitions.js` derives each reveal leg's baseline and chip streams; `public/js/timelines.js` animates them; `public/js/tutorial.js` teaches the new rule.

**Tech Stack:** Node 22, Express 5, `ws`, vanilla ES modules, `node --test`. No bundler, no linter. Playwright (from `C:/dev/traderprep/node_modules`) for headless verification only.

**Spec:** `docs/superpowers/specs/2026-09-13-suit-stakes-design.md`

## Global Constraints

- `CARD_PAYOUT = 10`; `MAX_BID = 100`; bids are integers `0..100`, a price per counterparty.
- All-way tie is **void**: empty `buyers` and `sellers`, all-zero purchase, no stake; the flip still pays older stakes.
- History entry shape, exactly: `{ index, reference, bids, buyers, sellers, topBid, void, purchase, flipped, hits, payouts, deltas }`; `flipped`, `hits`, `payouts`, `deltas` are `null` until the card step. No `price`, no `matched`.
- A stake is `{ auction, suit, buyers, sellers }`. `stakes` is public in every seated snapshot, `[]` in the lobby.
- `revealCardMs` default is `6000`; `revealBidsMs` stays `4500`.
- The server never serves `lib/fair-value.js` or `lib/bots.js`.
- Repo conventions: `"use strict"` CommonJS under `lib/` and `tests/`; UMD wrappers in `public/*.js`; ES modules in `public/js/`; `server.js` reads `public/index.html` once at startup, so restart after editing it.
- Run tests from `C:/dev/follow-suit` with `npm test` (no watch mode). The fair-value Monte Carlo test takes a few seconds.
- Commit after every task with a one-line message in the existing `feat:`/`test:` style, no trailers.
- Work happens on the `suit-stakes` branch in the worktree at `C:/dev/follow-suit-worktrees/suit-stakes` (created before Task 1; `npm ci` has been run there).
- Every shell command in this plan is written for the Bash tool (Git Bash), so `&&`, `VAR=value cmd`, and `/dev/null` are correct as written. Do not translate them to PowerShell.

---

### Task 1: Settlement in `game-core.js`

**Files:**
- Modify: `public/game-core.js` (constants at lines 16-17, `resolveBids`/`settle` at lines 65-85, exports at lines 99-102)
- Test: `tests/game-core.test.js` (replace the `resolveBids` and both `settle` tests at lines 46-83)

**Interfaces:**
- Produces: `CARD_PAYOUT` (10); `resolveBids(bids) → { topBid, buyers, sellers, void }`; `settlePurchase(bids) → { topBid, buyers, sellers, void, deltas }`; `settleFlip(stakes, suit, playerIds) → { hits, payouts: [{ from, to, amount }], deltas }`; `priorValue(flipped, cardsRemaining) → integer 0..100`. `PAYOUT` and `settle` are removed.

- [ ] **Step 1: Replace the settlement tests**

In `tests/game-core.test.js`, change the destructure on line 5 to:

```js
const { SUITS, HAND_SIZES, CARD_PAYOUT, handSize, buildPool, shuffle, countSuits, deal, resolveBids, settlePurchase, settleFlip, priorValue, rank } = GameCore;
```

Delete the three tests `resolveBids: highest wins...`, `settle reproduces the spec's worked examples`, and `settle is zero-sum for every buyer/seller split` (lines 46-83) and put these in their place:

```js
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
  // Auction 1 of a 4-player game: 19 cards remain, one of the suit is out of 39 unseen pool cards.
  assert.equal(priorValue(["hearts"], 19), 44);
  assert.equal(priorValue(["hearts", "hearts", "hearts"], 17), Math.round(10 * 17 * 7 / 37));
  assert.equal(priorValue([], 19), 0);
  assert.equal(priorValue(["hearts"], 0), 0);
  for (let k = 1; k <= 20; k++) {
    const v = priorValue(Array(k).fill("spades"), 20 - k);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, String(v));
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/game-core.test.js`
Expected: FAIL (`settlePurchase is not a function`, `CARD_PAYOUT` undefined).

- [ ] **Step 3: Implement the settlement functions**

In `public/game-core.js` replace `const PAYOUT = 100;` with `const CARD_PAYOUT = 10;`. Replace `resolveBids` and `settle` (lines 65-85) with:

```js
  function resolveBids(bids) {
    const ids = Object.keys(bids);
    let topBid = 0;
    for (const id of ids) topBid = Math.max(topBid, bids[id]);
    const top = ids.filter((id) => bids[id] === topBid);
    const sellers = ids.filter((id) => bids[id] !== topBid);
    const isVoid = sellers.length === 0;
    return { topBid, buyers: isVoid ? [] : top, sellers, void: isVoid };
  }

  // Purchase leg: each buyer pays each seller that seller's own bid. The
  // buyer's bid only decides who buys (second price, pairwise).
  function settlePurchase(bids) {
    const result = resolveBids(bids);
    const deltas = {};
    for (const id of Object.keys(bids)) deltas[id] = 0;
    for (const b of result.buyers) {
      for (const s of result.sellers) {
        deltas[b] -= bids[s];
        deltas[s] += bids[s];
      }
    }
    return { ...result, deltas };
  }

  // Payout leg for one flip: every stake on the flipped suit pays
  // CARD_PAYOUT from each of its sellers to each of its buyers. Opposing
  // obligations between the same two players are netted, so the stream list
  // holds at most one entry per unordered pair, ordered by playerIds.
  function settleFlip(stakes, suit, playerIds) {
    const deltas = {};
    for (const id of playerIds) deltas[id] = 0;
    const gross = {};
    const owe = (from, to, amount) => {
      gross[from] = gross[from] || {};
      gross[from][to] = (gross[from][to] || 0) + amount;
    };
    let hits = 0;
    for (const stake of stakes) {
      if (stake.suit !== suit) continue;
      hits += 1;
      for (const s of stake.sellers) for (const b of stake.buyers) owe(s, b, CARD_PAYOUT);
    }
    const payouts = [];
    for (const from of playerIds) {
      for (const to of playerIds) {
        if (from === to) continue;
        const net = ((gross[from] && gross[from][to]) || 0) - ((gross[to] && gross[to][from]) || 0);
        if (net > 0) payouts.push({ from, to, amount: net });
      }
    }
    for (const p of payouts) {
      deltas[p.from] -= p.amount;
      deltas[p.to] += p.amount;
    }
    return { hits, payouts, deltas };
  }

  // Expected remaining count of the reference suit (the last flipped card)
  // with no hand information: every remaining deck card is a uniformly
  // random unseen pool card. Public arithmetic, used for the dock default.
  function priorValue(flipped, cardsRemaining) {
    const k = flipped.length;
    if (k === 0 || cardsRemaining <= 0) return 0;
    const suit = flipped[k - 1];
    const seen = countSuits(flipped)[suit];
    const unseen = SUITS.length * POOL_PER_SUIT - k;
    const raw = Math.round((CARD_PAYOUT * cardsRemaining * (POOL_PER_SUIT - seen)) / unseen);
    return Math.max(0, Math.min(MAX_BID, raw));
  }
```

Update the export block to:

```js
  return {
    SUITS, SUIT_SYMBOLS, POOL_PER_SUIT, MIN_PLAYERS, MAX_PLAYERS, HAND_SIZES, CARD_PAYOUT, MAX_BID,
    handSize, buildPool, shuffle, countSuits, deal, resolveBids, settlePurchase, settleFlip, priorValue, rank
  };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/game-core.test.js`
Expected: PASS, all tests. The full suite is broken from here until Task 4 lands: `lib/game.js` still imports `settle`, so `tests/game.test.js`, `tests/snapshot.test.js`, and `tests/server.test.js` fail with `settle is not a function`. That is expected; do not patch `lib/game.js` in this task.

- [ ] **Step 5: Commit**

```bash
git add public/game-core.js tests/game-core.test.js
git commit -m "feat: suit-stake settlement in game-core (settlePurchase, settleFlip, priorValue)"
```

---

### Task 2: Expected remaining count in `fair-value.js`

**Files:**
- Modify: `lib/fair-value.js` (the accumulation loop at lines 48-60 and `fairValue` at lines 63-66)
- Test: `tests/fair-value.test.js` (add tests after line 59; change the `fairValue` test at lines 55-59)

**Interfaces:**
- Produces: `expectedRemaining({ hand, flips, playerCount }) → { spades, hearts, diamonds, clubs }` (expected cards of each suit still in the deck); `fairValue({ hand, flips, playerCount, reference })` now returns `CARD_PAYOUT * expectedRemaining[reference]`. `nextSuitProbabilities` is unchanged in behaviour.

- [ ] **Step 1: Write the failing tests**

In `tests/fair-value.test.js` change line 4 to:

```js
const { nextSuitProbabilities, expectedRemaining, fairValue } = require("../lib/fair-value.js");
```

Replace the `fairValue is 100 * probability of the reference suit` test with:

```js
test("expectedRemaining sums to the cards left in the deck", () => {
  const e = expectedRemaining({ hand: { spades: 4, hearts: 3, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 2, clubs: 0 }, playerCount: 2 });
  assert.ok(Math.abs(sum(e) - 17) < 1e-9, String(sum(e)));
});

test("expectedRemaining with no flips equals hand + expected unseen", () => {
  // Two players, hand 6/2/2/0: the other hand is 10 cards from the 30 pool
  // cards left (4 spades, 8 hearts, 8 diamonds, 10 clubs).
  const e = expectedRemaining({ hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 });
  const expected = { spades: 6 + 10 * 4 / 30, hearts: 2 + 10 * 8 / 30, diamonds: 2 + 10 * 8 / 30, clubs: 0 + 10 * 10 / 30 };
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

test("fairValue is CARD_PAYOUT times the expected remaining count of the reference suit", () => {
  const args = { hand: { spades: 6, hearts: 2, diamonds: 2, clubs: 0 }, flips: zero(), playerCount: 2 };
  const e = expectedRemaining(args);
  assert.ok(Math.abs(fairValue({ ...args, reference: "spades" }) - 10 * e.spades) < 1e-9);
  assert.ok(Math.abs(fairValue({ ...args, reference: "spades" }) - 10 * (6 + 10 * 4 / 30)) < 1e-9);
});

test("nextSuitProbabilities is expectedRemaining divided by the cards left", () => {
  const args = { hand: { spades: 4, hearts: 3, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 1, diamonds: 0, clubs: 0 }, playerCount: 2 };
  const p = nextSuitProbabilities(args);
  const e = expectedRemaining(args);
  for (const s of SUITS) assert.ok(Math.abs(p[s] - e[s] / 18) < 1e-12, s);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/fair-value.test.js`
Expected: FAIL (`expectedRemaining is not a function`).

- [ ] **Step 3: Implement `expectedRemaining`**

In `lib/fair-value.js` change line 2 to import the payout constant:

```js
const { SUITS, POOL_PER_SUIT, CARD_PAYOUT, handSize } = require("../public/game-core.js");
```

Rename the existing `nextSuitProbabilities` body into a private `posterior` that returns expected remaining counts, then derive both public functions. Replace everything from the `// Spec 4.6.` comment through the end of `fairValue` with:

```js
// Spec 4.6 of the v1 design. From one player's view the unseen part of the
// deck U (the other hands) is a uniform (P-1)*n-subset of (pool - hand); the
// deck D = H + U is flipped in uniform order.
// Weight each composition U by MVH(U; pool-H) * MVH(F; D), dropping the
// normalising binomials that are constant across U, then take the expectation
// of (D_s - F_s): the number of suit s still in the deck. Computed in log
// space and normalised with log-sum-exp.
function posterior({ hand, flips, playerCount }) {
  const n = handSize(playerCount);
  if (total(hand) !== n) throw new RangeError(`hand must hold ${n} cards`);
  const H = SUITS.map((s) => hand[s] || 0);
  const F = SUITS.map((s) => flips[s] || 0);
  const unknown = (playerCount - 1) * n;
  const deckSize = playerCount * n;
  const k = F.reduce((a, b) => a + b, 0);
  if (k >= deckSize) throw new RangeError("no cards remain");
  const avail = H.map((h) => POOL_PER_SUIT - h);

  const terms = [];
  for (let a = 0; a <= Math.min(unknown, avail[0]); a++) {
    for (let b = 0; b <= Math.min(unknown - a, avail[1]); b++) {
      for (let c = 0; c <= Math.min(unknown - a - b, avail[2]); c++) {
        const d = unknown - a - b - c;
        if (d > avail[3]) continue;
        const U = [a, b, c, d];
        const D = H.map((h, i) => h + U[i]);
        if (D.some((x, i) => x < F[i])) continue;
        let logq = 0;
        for (let i = 0; i < 4; i++) logq += logChoose(avail[i], U[i]) + logChoose(D[i], F[i]);
        terms.push({ logq, D });
      }
    }
  }

  let maxLog = -Infinity;
  for (const t of terms) if (t.logq > maxLog) maxLog = t.logq;
  let z = 0;
  const acc = [0, 0, 0, 0];
  for (const { logq, D } of terms) {
    const w = Math.exp(logq - maxLog);
    z += w;
    for (let i = 0; i < 4; i++) acc[i] += w * (D[i] - F[i]);
  }
  const remaining = {};
  SUITS.forEach((s, i) => { remaining[s] = acc[i] / z; });
  return { remaining, cardsLeft: deckSize - k };
}

// Expected number of each suit still in the deck.
function expectedRemaining(args) {
  return posterior(args).remaining;
}

// Probability the next card is each suit.
function nextSuitProbabilities(args) {
  const { remaining, cardsLeft } = posterior(args);
  const out = {};
  for (const s of SUITS) out[s] = remaining[s] / cardsLeft;
  return out;
}

// Value of one stake contract on the reference suit, per counterparty.
function fairValue({ hand, flips, playerCount, reference }) {
  return CARD_PAYOUT * expectedRemaining({ hand, flips, playerCount })[reference];
}

module.exports = { nextSuitProbabilities, expectedRemaining, fairValue };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/fair-value.test.js`
Expected: PASS, including the existing Monte Carlo test (it takes a few seconds).

- [ ] **Step 5: Commit**

```bash
git add lib/fair-value.js tests/fair-value.test.js
git commit -m "feat: expectedRemaining posterior; fair value is 10 per expected card"
```

---

### Task 3: Bot profiles re-centred

**Files:**
- Modify: `lib/bots.js:10-15`
- Test: `tests/bots.test.js` (extend `profiles cycle` at lines 21-26)

**Interfaces:**
- Produces: `BOT_PROFILES` = careful 0.95/2, fair 1.00/2, keen 1.05/3, wild 1.12/6. `computeBotBid` unchanged in shape.

- [ ] **Step 1: Extend the profile test**

Replace the `profiles cycle` test with:

```js
test("profiles cycle and are centred on fair value", () => {
  assert.equal(BOT_PROFILES.length, 4);
  assert.equal(botProfile(0).key, "careful");
  assert.equal(botProfile(3).key, "wild");
  assert.equal(botProfile(4).key, "careful");
  assert.deepEqual(BOT_PROFILES.map((p) => [p.key, p.shade, p.sigma]), [
    ["careful", 0.95, 2], ["fair", 1.0, 2], ["keen", 1.05, 3], ["wild", 1.12, 6]
  ]);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test tests/bots.test.js`
Expected: FAIL on the deepEqual.

- [ ] **Step 3: Re-tune the profiles**

In `lib/bots.js` replace the `BOT_PROFILES` array with:

```js
// Under sell-at-your-own-bid a bid below fair sells cheap on every loss, so
// the profiles sit around 1.0. Wild still buys too often and overpays.
const BOT_PROFILES = [
  { key: "careful", shade: 0.95, sigma: 2 },
  { key: "fair", shade: 1.0, sigma: 2 },
  { key: "keen", shade: 1.05, sigma: 3 },
  { key: "wild", shade: 1.12, sigma: 6 }
];
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/bots.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bots.js tests/bots.test.js
git commit -m "feat: bot profiles centred on fair value for sell-at-own-bid"
```

---

### Task 4: Stakes in the game state machine

**Files:**
- Modify: `lib/game.js` (import line 5, `DEFAULT_CONFIG` line 7, state object lines 19-31, `resetMatch` lines 82-95, `resolve` lines 186-207, `flipAndSettle` lines 209-221)
- Modify: `lib/config.js:16` (`revealCardMs` default 6000)
- Test: `tests/game.test.js` (tests at lines 94-105, 156-171, 216-227, 239-250, 252-283), `tests/config.test.js:8,17`

**Interfaces:**
- Consumes: `settlePurchase`, `settleFlip` from Task 1.
- Produces: `game.stakes` (array of `{ auction, suit, buyers, sellers }`), history entries in the spec shape, `game.players[].score` updated at resolve (purchase) and at the flip (payout). `DEFAULT_CONFIG.revealCardMs === 6000`.

- [ ] **Step 1: Update the config tests**

In `tests/config.test.js` change both `revealCardMs: 5000` / `assert.equal(c.game.revealCardMs, 5000)` occurrences to `6000`.

- [ ] **Step 2: Rewrite the settlement tests in `tests/game.test.js`**

Replace `missing bids resolve to 0 at the deadline` (lines 94-105) with:

```js
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
  assert.deepEqual(Object.keys(entry).sort(), ["bids", "buyers", "deltas", "flipped", "hits", "index", "payouts", "purchase", "reference", "sellers", "topBid", "void"]);
  assert.deepEqual(game.stakes, [{ auction: 1, suit: entry.reference, buyers: ["p1"], sellers: ["p2"] }]);
});
```

Replace `settlement applies score deltas and the flipped card becomes the reference` (lines 156-171) with:

```js
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
```

Replace `a void auction records bids, no buyers, zero deltas, and still flips` (lines 216-227) with:

```js
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
```

Add after the void test:

```js
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
```

In `the last auction leads to results with hands revealed and no pending timers` (lines 239-250) add after `assert.equal(game.history.length, 19);`:

```js
  assert.equal(game.stakes.length, 19, "one stake per non-void auction");
  assert.ok(game.history.every((h) => h.deltas !== null && h.payouts !== null && h.hits !== null));
  const totals = { p1: 0, p2: 0 };
  for (const h of game.history) for (const id of Object.keys(totals)) totals[id] += h.deltas[id];
  assert.equal(totals.p1, game.players[0].score, "score is the sum of round deltas");
  assert.equal(totals.p2, game.players[1].score);
```

In `two consecutive full games in one instance share no state` add `assert.deepEqual(game.stakes, []);` right after `assert.deepEqual(game.history, []);` in both places (after `returnToLobby` and after the second `start`).

- [ ] **Step 3: Run to see them fail**

Run: `node --test tests/game.test.js tests/config.test.js`
Expected: FAIL (`lib/game.js` still destructures `settle`, which no longer exists, so every game test throws; the config test fails on the default 5000).

- [ ] **Step 4: Implement**

`lib/config.js` line 16: `revealCardMs: envInt(env, "REVEAL_CARD_MS", 6000)`.

`lib/game.js`:

Line 5:
```js
const { MIN_PLAYERS, MAX_PLAYERS, MAX_BID, deal, settlePurchase, settleFlip, countSuits } = GameCore;
```

Line 7:
```js
const DEFAULT_CONFIG = { dealMs: 9500, bidMs: 30000, revealBidsMs: 4500, revealCardMs: 6000 };
```

In the `game` object add `stakes: [],` after `history: [],`. In `resetMatch` add `game.stakes = [];` after `game.history = [];`. Add next to `reference()`:

```js
  function playerIds() {
    return game.players.map((p) => p.id);
  }
```

Replace `resolve` and `flipAndSettle` with:

```js
  // Both transitions below compute the whole result first and only then touch
  // game state, so a throw during the computation leaves the room as it was.
  // The purchase leg is applied here, the payout leg at the flip: each leg
  // lands on the scores where it happens.
  function resolve() {
    if (game.phase !== "bidding") return;
    const bids = {};
    for (const p of game.players) bids[p.id] = game.auction.bids[p.id] ? game.auction.bids[p.id].amount : 0;
    const r = settlePurchase(bids);
    const entry = {
      index: game.auction.index,
      reference: reference(),
      bids,
      buyers: r.buyers,
      sellers: r.sellers,
      topBid: r.topBid,
      void: r.void,
      purchase: r.deltas,
      flipped: null,
      hits: null,
      payouts: null,
      deltas: null
    };
    clearPhaseTimer();
    clearBotTimers();
    for (const p of game.players) p.score += r.deltas[p.id] || 0;
    game.history.push(entry);
    if (!r.void) game.stakes.push({ auction: entry.index, suit: entry.reference, buyers: r.buyers.slice(), sellers: r.sellers.slice() });
    game.phase = "reveal";
    game.revealStep = "bids";
    armTimer("revealBids", config.revealBidsMs, flipAndPay);
    onChange();
  }

  function flipAndPay() {
    const entry = game.history[game.history.length - 1];
    const card = game.deck[game.flipIndex];
    const result = settleFlip(game.stakes, card, playerIds());
    game.flipIndex += 1;
    entry.flipped = card;
    entry.hits = result.hits;
    entry.payouts = result.payouts;
    const deltas = {};
    for (const p of game.players) deltas[p.id] = (entry.purchase[p.id] || 0) + (result.deltas[p.id] || 0);
    entry.deltas = deltas;
    for (const p of game.players) p.score += result.deltas[p.id] || 0;
    game.revealStep = "card";
    armTimer("revealCard", config.revealCardMs, advance);
    onChange();
  }
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/game.test.js tests/config.test.js`
Expected: PASS. (`tests/snapshot.test.js` will now fail on timing and key lists; Task 5 fixes it.)

- [ ] **Step 6: Commit**

```bash
git add lib/game.js lib/config.js tests/game.test.js tests/config.test.js
git commit -m "feat: stakes in the state machine; purchase at resolve, payout at the flip"
```

---

### Task 5: Stakes and the new entry shape in the snapshot

**Files:**
- Modify: `lib/snapshot.js:65` (history copy) and the return object
- Test: `tests/snapshot.test.js` (key lists at lines 19-22, timings at lines 49, 137, 168; add a reveal test)

**Interfaces:**
- Consumes: `game.stakes`, history entries from Task 4.
- Produces: `state.stakes` (copied), history entries copied field by field with `null` card-step fields before the flip.

- [ ] **Step 1: Update the snapshot tests**

In `tests/snapshot.test.js`:

Line 19, add `"stakes"` to `STATE_KEYS`:
```js
const STATE_KEYS = ["type", "room", "phase", "matchId", "revealStep", "remainingMs", "timing", "you", "players", "reference", "flipped", "cardsRemaining", "auctionIndex", "hand", "myBid", "history", "stakes", "minPlayers", "maxPlayers", "handSize"].sort();
```

Line 22:
```js
const HISTORY_KEYS = ["index", "reference", "bids", "buyers", "sellers", "topBid", "void", "purchase", "flipped", "hits", "payouts", "deltas"].sort();
```

Line 49: `revealCardMs: 4500` → `6000` (the object becomes `{ dealMs: 9500, bidMs: 30000, revealBidsMs: 4500, revealCardMs: 6000 }`).

Line 137 (`a resumed recipient mid-bidding`): `clock.advance(4500 + 4000);` → `clock.advance(4500 + 6000);`.

Line 168 (`results snapshot` loop): `clock.advance(9500);` → `clock.advance(10500);`.

In the lobby test (`lobby snapshot lists seats and hides nothing sensitive`, line 63) add `assert.deepEqual(s.stakes, []);` after the existing assertions on `s`.

Add after the `reveal(bids) snapshot exposes...` test:

```js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/snapshot.test.js`
Expected: FAIL (key lists, `stakes` missing).

- [ ] **Step 3: Implement**

In `lib/snapshot.js` add above `buildState`:

```js
function cloneEntry(h) {
  return {
    index: h.index,
    reference: h.reference,
    bids: { ...h.bids },
    buyers: h.buyers.slice(),
    sellers: h.sellers.slice(),
    topBid: h.topBid,
    void: h.void,
    purchase: { ...h.purchase },
    flipped: h.flipped,
    hits: h.hits,
    payouts: h.payouts ? h.payouts.map((p) => ({ ...p })) : null,
    deltas: h.deltas ? { ...h.deltas } : null
  };
}
```

Replace the `history:` line in the returned object with:

```js
    history: game.history.map(cloneEntry),
    stakes: game.stakes.map((s) => ({ auction: s.auction, suit: s.suit, buyers: s.buyers.slice(), sellers: s.sellers.slice() })),
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/snapshot.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole server-side suite**

Run: `npm test`
Expected: PASS, every file. `tests/transitions.test.js` still passes at this point because `public/transitions.js` and its tests are untouched until Task 6; they test the old protocol, which Task 6 replaces.

- [ ] **Step 6: Commit**

```bash
git add lib/snapshot.js tests/snapshot.test.js
git commit -m "feat: stakes and the new history shape in the snapshot"
```

---

### Task 6: `transitions.js`: leg baselines and streams

**Files:**
- Modify: `public/transitions.js` (constants line 15-16, functions from `sellersOf` at line 45 to the export at line 97)
- Test: `tests/transitions.test.js` (replace the three settlement tests from line 63 to the end; change the import on line 3)

**Interfaces:**
- Produces: `legBaseline(state) → { [id]: number }`; `paymentStreams(entry, step) → [{ from, to, amount }]` (`step` is `"bids"` or `"card"`); `CARD_TIMELINE_MS = 4800`. `displayScores` and `payoutBaseline` are removed.

- [ ] **Step 1: Rewrite the tests**

Line 3:
```js
const { plan, legBaseline, paymentStreams, transitionKey, DEAL_TIMELINE_MS, CARD_TIMELINE_MS } = require("../public/transitions.js");
const { readConfig } = require("../lib/config.js");
```

Replace everything from `const entry = (over) => ...` (line 63) to the end of the file with:

```js
const entry = (over) => ({
  index: 1, reference: "hearts", bids: { a: 80, b: 50, c: 20 }, buyers: ["a"], sellers: ["b", "c"], topBid: 80, void: false,
  purchase: { a: -70, b: 50, c: 20 }, flipped: null, hits: null, payouts: null, deltas: null, ...over
});
const withScores = (scores) => players.map((p) => ({ ...p, score: scores[p.id] }));

test("legBaseline undoes the purchase at bids, the payout at card, nothing elsewhere", () => {
  const raw = { a: 10, b: 20, c: 30 };
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "bidding" })), raw);
  // Server scores after the purchase: 10-70, 20+50, 30+20.
  const bids = snap({ players: withScores({ a: -60, b: 70, c: 50 }), phase: "reveal", revealStep: "bids", history: [entry()] });
  assert.deepEqual(legBaseline(bids), raw);
  // Card step after a heart: payout +20/-10/-10 on top of the purchase.
  const card = snap({
    players: withScores({ a: -40, b: 60, c: 40 }), phase: "reveal", revealStep: "card",
    history: [entry({ flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }], deltas: { a: -50, b: 40, c: 10 } })]
  });
  assert.deepEqual(legBaseline(card), { a: -60, b: 70, c: 50 });
  // Adding the payout streams lands exactly on the server scores.
  const landed = legBaseline(card);
  for (const s of paymentStreams(card.history[0], "card")) {
    landed[s.from] -= s.amount;
    landed[s.to] += s.amount;
  }
  assert.deepEqual(landed, { a: -40, b: 60, c: 40 });
  // Void at bids: identity. Void at card with an older stake paying: undone.
  const voidEntry = entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], sellers: [], topBid: 0, void: true, purchase: { a: 0, b: 0, c: 0 } });
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "reveal", revealStep: "bids", history: [voidEntry] })), raw);
  const voidCard = snap({
    players: withScores({ a: 30, b: 10, c: 20 }), phase: "reveal", revealStep: "card",
    history: [{ ...voidEntry, flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }], deltas: { a: 20, b: -10, c: -10 } }]
  });
  assert.deepEqual(legBaseline(voidCard), raw);
  // Results and lobby: identity, even with history present.
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "results", history: [entry()] })), raw);
});

test("paymentStreams: sellers' bids at the purchase, netted payouts at the card", () => {
  assert.deepEqual(paymentStreams(entry(), "bids"), [{ from: "a", to: "b", amount: 50 }, { from: "a", to: "c", amount: 20 }]);
  const tie = entry({ bids: { a: 60, b: 60, c: 30, d: 10 }, buyers: ["a", "b"], sellers: ["c", "d"], topBid: 60, purchase: { a: -40, b: -40, c: 60, d: 20 } });
  assert.deepEqual(paymentStreams(tie, "bids"), [
    { from: "a", to: "c", amount: 30 }, { from: "a", to: "d", amount: 10 },
    { from: "b", to: "c", amount: 30 }, { from: "b", to: "d", amount: 10 }
  ]);
  assert.deepEqual(paymentStreams(entry({ bids: { a: 5, b: 0, c: 0 }, topBid: 5, purchase: { a: 0, b: 0, c: 0 } }), "bids"), [], "zero bids send no chips");
  assert.deepEqual(paymentStreams(entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], sellers: [], topBid: 0, void: true }), "bids"), []);
  const payouts = [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }];
  const card = entry({ flipped: "hearts", hits: 1, payouts, deltas: { a: -50, b: 40, c: 10 } });
  assert.deepEqual(paymentStreams(card, "card"), payouts);
  assert.notEqual(paymentStreams(card, "card")[0], payouts[0], "streams are copies");
  assert.deepEqual(paymentStreams(entry({ flipped: "clubs", hits: 0, payouts: [], deltas: { a: -70, b: 50, c: 20 } }), "card"), []);
  assert.deepEqual(paymentStreams(entry(), "card"), [], "before the flip there are no payouts");
});

test("the reveal-card timeline fits inside the configured step", () => {
  assert.ok(CARD_TIMELINE_MS <= readConfig({}).game.revealCardMs, `${CARD_TIMELINE_MS} > revealCardMs`);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/transitions.test.js`
Expected: FAIL (`legBaseline is not a function`).

- [ ] **Step 3: Implement**

In `public/transitions.js` replace `const PAYOUT = 100;` with:

```js
  // Worst case of the reveal-card timeline in timelines.js: turn, compare
  // beat, slide, payout streams, badge pop/hold/fade, tag fade. Keep in step
  // with timelines.js; a Node test checks it against the config default.
  const CARD_TIMELINE_MS = 4800;
```

Replace everything from `function sellersOf` through the `paymentStreams` function with:

```js
  // Scores at the start of the leg the current reveal step animates: before
  // the purchase chips at reveal/bids, before the payout chips at
  // reveal/card. Derived from the snapshot alone, never from the DOM. The
  // server has already applied each leg when its snapshot is built.
  function legBaseline(state) {
    const out = {};
    for (const p of state.players) out[p.id] = p.score;
    if (state.phase !== "reveal") return out;
    const last = state.history[state.history.length - 1];
    if (!last) return out;
    if (state.revealStep === "bids") {
      for (const id of Object.keys(out)) out[id] -= (last.purchase && last.purchase[id]) || 0;
    } else if (state.revealStep === "card" && last.deltas) {
      for (const id of Object.keys(out)) out[id] -= (last.deltas[id] || 0) - ((last.purchase && last.purchase[id]) || 0);
    }
    return out;
  }

  // Chip streams for one leg. At the bids reveal every buyer pays every
  // seller that seller's bid; at the card reveal the server's netted payouts
  // fly as they are. Zero-amount streams are omitted.
  function paymentStreams(entry, step) {
    if (step === "bids") {
      if (entry.void) return [];
      const out = [];
      for (const b of entry.buyers) for (const s of entry.sellers) if (entry.bids[s] > 0) out.push({ from: b, to: s, amount: entry.bids[s] });
      return out;
    }
    return entry.payouts ? entry.payouts.map((p) => ({ ...p })) : [];
  }
```

Export line:
```js
  return { DEAL_TIMELINE_MS, CARD_TIMELINE_MS, transitionKey, plan, legBaseline, paymentStreams };
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 5: Commit**

```bash
git add public/transitions.js tests/transitions.test.js
git commit -m "feat: legBaseline and seller-priced streams in transitions"
```

---

### Task 7: Table state layer: stake row, badge, dock hint, log, results

**Files:**
- Modify: `public/js/table.js` (imports lines 5-10, `els` lines 22-30, `resetTransient` lines 63-79, `buildSeat` lines 134-169, `renderSeats` lines 180-220, `renderCentre` lines 242-256, `renderLog` payouts cell around line 313, `renderDock` line 384, `setDraftAmount` line 453, `renderResults` history cells lines 495-502)
- Modify: `public/index.html` (dock `.bid-row` at lines 88-92; history `<thead>` at line 109)
- Modify: `public/styles.css` (after `.seat-score.neg` line 159; after `.bid-row input[type="range"]` line 241; `.rail-flash.bad` line 297; `.price-badge` line 178)

**Interfaces:**
- Consumes: `priorValue` and `SUIT_SYMBOLS` from `window.GameCore`; `state.stakes`, `entry.topBid`, `entry.hits`, `entry.void`.
- Produces: per seat a `.seat-stakes` row of `.stake-chip.<suit>` spans (text `♥` or `♥×2`); `#bidHint`; `els.bidHint`. Timelines (Task 8) find a buyer's new chip with `seatEl.querySelector(".stake-chip." + suit)`.

- [ ] **Step 1: Markup and styles**

`public/index.html`: change the meta description on line 9 to:

```html
  <meta name="description" content="Follow Suit: a multiplayer card auction. Bid for the suit on top; every later flip of it pays the owner.">
```

Inside `<div class="bid-row">`, after the `+1` button, add:

```html
          <span id="bidHint" class="bid-hint" aria-hidden="true"></span>
```

Change the history header row to:

```html
              <thead><tr><th>#</th><th>Ref</th><th>Bids</th><th>Buyer</th><th>Flip</th><th>Score change</th></tr></thead>
```

`public/styles.css`: after `.seat-score.neg { color: var(--bad); }` add:

```css
.seat-stakes { display: flex; gap: 3px; min-height: 16px; justify-content: center; }
.stake-chip { padding: 0 6px; border-radius: 999px; background: rgba(0, 0, 0, 0.55); border: 1px solid var(--gold); color: var(--ink); font-size: 0.72rem; line-height: 15px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.stake-chip.hearts, .stake-chip.diamonds { color: #ff8a7a; }
```

After the `.bid-row input[type="range"]` rule add:

```css
.bid-hint { color: var(--muted); font-size: 0.8rem; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
```

After `.rail-flash.bad { ... }` add:

```css
.rail-flash.pay { box-shadow: inset 0 0 0 14px var(--gold), 0 0 40px 6px var(--gold); }
```

- [ ] **Step 2: `table.js` imports, elements, transient reset**

Replace lines 5-11 (from the `window.GameCore` destructure through the `MEDALS` line) as one block with:

```js
const { SUITS, SUIT_SYMBOLS, countSuits, rank, MAX_PLAYERS, priorValue } = window.GameCore;
const { seatPositions } = window.SeatLayout;
const $ = (id) => document.getElementById(id);
const RING_LENGTH = 282.7;
const MEDALS = ["🥇", "🥈", "🥉"];
```

(so the `displayScores` destructure and `DEFAULT_BID` are gone and nothing is declared twice.)

In `els` add `bidHint: $("bidHint"),` after `bidUpBtn: $("bidUpBtn"),`.

In `resetTransient`, inside the `for (const el of seatEls.values())` loop, add after the `.delta-badge` removal:

```js
      for (const c of el.querySelectorAll(".stake-chip")) c.style.visibility = "";
```

- [ ] **Step 3: Seats**

In `buildSeat`, after `score.append(num);` add:

```js
    const stakes = document.createElement("div");
    stakes.className = "seat-stakes";
```

and change the append line to `el.append(tag, avatar, stack, name, score, stakes, status, remove);`.

Add a helper next to `setScore`:

```js
  // Stakes a player owns, per suit, from the public stake list.
  function ownedStakes(id) {
    const out = {};
    for (const s of SUITS) out[s] = 0;
    for (const st of state.stakes || []) if (st.buyers.includes(id)) out[st.suit] += 1;
    return out;
  }
  function renderStakeRow(el, id) {
    const owned = ownedStakes(id);
    const row = el.querySelector(".seat-stakes");
    row.replaceChildren(...SUITS.filter((s) => owned[s] > 0).map((s) => {
      const chip = document.createElement("span");
      chip.className = `stake-chip ${s}`;
      chip.textContent = owned[s] > 1 ? `${SUIT_SYMBOLS[s]}×${owned[s]}` : SUIT_SYMBOLS[s];
      return chip;
    }));
    return SUITS.filter((s) => owned[s] > 0).map((s) => (owned[s] > 1 ? `${s} ×${owned[s]}` : s)).join(", ");
  }
```

In `renderSeats` replace `const scores = displayScores(state);` with:

```js
    const scores = {};
    for (const p of state.players) scores[p.id] = p.score;
```

After `setScore(el, scores[p.id]);` add `const holds = renderStakeRow(el, p.id);` and change the aria-label line to:

```js
      el.setAttribute("aria-label", `${p.name}, ${scores[p.id]} points${statusText ? ", " + statusText : ""}${holds ? ", holds " + holds : ""}${p.isBot ? ", bot" : ""}`);
```

- [ ] **Step 4: Centre badge**

In `renderCentre` replace the `if (showPrice) { ... }` block with:

```js
    if (showPrice) {
      els.priceBadge.textContent = last.void ? "no trade" : `${SUIT_SYMBOLS[last.reference]} ${last.topBid}`;
      els.priceBadge.setAttribute("aria-label", last.void ? "no trade" : `winning bid ${last.topBid} on ${last.reference}`);
      els.priceBadge.classList.toggle("void", last.void);
    }
```

- [ ] **Step 5: Log payouts cell**

In `renderLog`, the payouts branch currently reads:

```js
        } else if (entry && entry.deltas) {
          const d = entry.deltas[p.id] || 0;
          cell.textContent = entry.void ? "–" : fmtDelta(d);
          if (entry.void) cell.classList.add("void");
          else if (d > 0) cell.classList.add("pos");
          else if (d < 0) cell.classList.add("neg");
          if (entry.buyers.includes(p.id)) cell.classList.add("buyer");
        } else {
```

Change it to (a void round can still pay on older stakes):

```js
        } else if (entry && entry.deltas) {
          const d = entry.deltas[p.id] || 0;
          cell.textContent = fmtDelta(d);
          if (d > 0) cell.classList.add("pos");
          else if (d < 0) cell.classList.add("neg");
          else if (entry.void) cell.classList.add("void");
          if (entry.buyers.includes(p.id)) cell.classList.add("buyer");
        } else {
```

- [ ] **Step 6: Dock default and hint**

Add next to `setDraftAmount`:

```js
  // The public prior for the reference suit: what a silent player bids.
  function defaultBid() {
    return priorValue(state.flipped || [], state.cardsRemaining || 0);
  }
  function paintHint() {
    els.bidHint.textContent = `${(draft.amount / 10).toFixed(1)} cards`;
  }
```

In `renderDock` change `amount: state.myBid ? state.myBid.amount : DEFAULT_BID,` to `amount: state.myBid ? state.myBid.amount : defaultBid(),` and add `paintHint();` right after `els.bidRange.value = draft.amount;`. In `setDraftAmount` change `if (!Number.isFinite(n)) n = DEFAULT_BID;` to `if (!Number.isFinite(n)) n = defaultBid();` and add `paintHint();` after `paintLock();`.

- [ ] **Step 7: Results history**

In `renderResults` replace the `cells` array with:

```js
      const cells = [
        ["", String(h.index)],
        [`suit ${h.reference}`, SUIT_SYMBOLS[h.reference]],
        ["", state.players.map((p) => h.bids[p.id]).join(" / ")],
        ["", h.void ? "void" : h.buyers.map(nameOf).join(", ")],
        [`suit ${h.flipped}`, `${SUIT_SYMBOLS[h.flipped]}${h.hits ? ` · ${h.hits} stake${h.hits === 1 ? "" : "s"}` : ""}`],
        ["", state.players.map((p) => fmtDelta((h.deltas && h.deltas[p.id]) || 0)).join(" / ")]
      ];
```

- [ ] **Step 8: Syntax check and smoke run**

Run: `node --check public/js/table.js && npm test`
Expected: syntax OK, tests pass. Then start `PORT=3011 node server.js` in the background, open `http://localhost:3011/` in a browser or headless Chromium, quick play, and confirm the dock hint shows `4.4 cards` at auction 1 and no console errors appear. (Timelines still reference `displayScores`; the reveal animations are fixed in Task 8, so expect a `[table] timeline failed` console error at the first reveal until then. That error is the one thing allowed at this step.) Stop the server.

- [ ] **Step 9: Commit**

```bash
git add public/js/table.js public/index.html public/styles.css
git commit -m "feat: stake row on seats, winning-bid badge, cards hint and prior default in the dock"
```

---

### Task 8: Reveal timelines

**Files:**
- Modify: `public/js/timelines.js` (import line 3; `revealBidsTimeline` lines 244-268; `revealCardTimeline` lines 270-331)

**Interfaces:**
- Consumes: `legBaseline`, `paymentStreams` from Task 6; `.stake-chip` elements from Task 7; `t.audio`, `t.announce`, `t.seatEl`, `t.showScore` from the table handle.

- [ ] **Step 1: Import**

Line 3 becomes:

```js
const { paymentStreams, legBaseline } = window.Transitions;
```

- [ ] **Step 2: Reveal bids**

Replace `revealBidsTimeline` with:

```js
export async function revealBidsTimeline(ctx, t, state) {
  const { els, audio } = t;
  const last = state.history[state.history.length - 1];
  const players = t.orderedPlayers(state);
  const ids = state.players.map((p) => p.id);
  // The server has applied the purchase: chips fly from the pre-purchase
  // baseline onto the snapshot scores.
  const fromScores = legBaseline(state);
  const toScores = rawScores(state);
  const tags = new Map(players.map((p) => [p.id, t.seatEl(p.id).querySelector(".bid-tag")]));
  for (const tag of tags.values()) tag.style.visibility = "hidden";
  els.priceBadge.style.visibility = "hidden";
  // The state layer already drew the buyer's new stake chip; hold it back
  // until the purchase lands.
  const newChips = last.void ? [] : last.buyers.map((id) => t.seatEl(id).querySelector(`.stake-chip.${last.reference}`)).filter(Boolean);
  for (const chip of newChips) chip.style.visibility = "hidden";
  for (const id of ids) t.showScore(id, fromScores[id]);

  const order = players.slice().sort((a, b) => last.bids[a.id] - last.bids[b.id]);
  for (const p of order) {
    audio.play("tag");
    pop(ctx, tags.get(p.id)).catch(() => {});
    await ctx.wait(120);
  }
  audio.play(last.void ? "tap" : "rise");
  await pop(ctx, els.priceBadge);
  const nameOf = (id) => state.players.find((p) => p.id === id).name;
  t.announce(last.void ? "No trade" : `${last.buyers.map(nameOf).join(" and ")} ${last.buyers.length > 1 ? "buy" : "buys"} ${last.reference}`);
  if (last.void) return;
  // Let the bids sink in before the chips move.
  await ctx.wait(BIDS_PAUSE_MS);
  await payStreams(ctx, t, paymentStreams(last, "bids"), fromScores, toScores);
  // Awaited: the sequencer cancels every tracked animation the moment the
  // timeline returns, so an un-awaited pop would never be seen.
  if (newChips.length) audio.play("tag");
  await ctx.until(Promise.all(newChips.map((chip) => pop(ctx, chip).catch(() => {}))));
}
```

- [ ] **Step 3: Reveal card**

In `revealCardTimeline` replace the baseline lines:

```js
  const fromScores = payoutBaseline(state);
  for (const id of ids) t.showScore(id, fromScores[id]);
```

with:

```js
  // Baseline from the snapshot itself, never from what the DOM showed: the
  // bids snapshot may have been skipped or its animation interrupted.
  const fromScores = legBaseline(state);
  const toScores = rawScores(state);
  const payoutDelta = (id) => ((last.deltas && last.deltas[id]) || 0) - ((last.purchase && last.purchase[id]) || 0);
  const hit = (last.hits || 0) > 0;
  const streams = paymentStreams(last, "card");
  for (const id of ids) t.showScore(id, fromScores[id]);
```

Replace the flash/sound/announce block:

```js
  els.flash.className = `rail-flash ${last.matched ? "good" : "bad"}`;
  audio.play(last.matched ? "match" : "miss");
  t.announce(`${suitName(last.flipped)}, ${last.matched ? "match" : "miss"}`);
  ctx.animate(els.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
```

with:

```js
  const myPayout = payoutDelta(state.you);
  audio.play(myPayout > 0 ? "match" : myPayout < 0 ? "miss" : "tap");
  if (hit) {
    els.flash.className = "rail-flash pay";
    ctx.animate(els.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
  }
  const collectors = state.players.filter((p) => payoutDelta(p.id) > 0).map((p) => `${p.name} collects ${payoutDelta(p.id)}`);
  const mine = (last.deltas && last.deltas[state.you]) || 0;
  const you = mine === 0 ? "You break even" : `You ${mine > 0 ? "plus" : "minus"} ${Math.abs(mine)}`;
  t.announce(`${suitName(last.flipped)}. ${!hit ? "No stakes" : streams.length === 0 ? "Payments cancel" : collectors.join(", ")}. ${you}`);
```

The live region is rewritten by every `announce`, so the round's personal result is folded into this one sentence. Delete the two later lines that declared `mine` and announced it (`const mine = ...` and `t.announce(mine === 0 ? ...)` after the badge loop); keep the badge loop itself.

Replace the payout leg:

```js
  // Payout leg (match only), then the net delta on every seat: ...
  const to = displayScores(state);
  const streams = paymentStreams(last, ids, "card");
  if (streams.length) await payStreams(ctx, t, streams, fromScores, to);
  else for (const id of ids) t.showScore(id, to[id]);
```

with:

```js
  // Payout leg: every stake on the flipped suit, netted per pair. Then the
  // net round delta on every seat: a badge that pops in, holds still long
  // enough to read, and fades.
  if (streams.length) await payStreams(ctx, t, streams, fromScores, toScores);
  else for (const id of ids) t.showScore(id, toScores[id]);
```

The badge loop and the fade of tags and buyer glow stay as they are (they use `last.deltas`, the net of both legs). Only the second `mine` announcement goes, as described above.

- [ ] **Step 4: Syntax check, tests, and a headless run**

Run: `node --check public/js/timelines.js && npm test`
Expected: OK and all tests pass.

Start `PORT=3011 DEAL_MS=1500 BID_MS=4000 REVEAL_BIDS_MS=3000 node server.js` in the background and run the verification script from Task 10 Step 2 (write it now if you are executing tasks in order; it only reads the page). Expected: it reports `console.error` nothing, stake chips appear on the buyer's seat after the first reveal, and delta badges appear with a lifetime around 1.8 s. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/js/timelines.js
git commit -m "feat: purchase streams at sellers' bids, stake payouts with a gold flash"
```

---

### Task 9: Tutorial for the new rule

**Files:**
- Modify: `public/js/tutorial.js` (imports line 5; `miniTable` seat markup line 21; `SLIDES` lines 147-297; the dialog markup and controls in `createTutorial` lines 300-330 and 337-393; the `matched` state and control handlers lines 323, 420-427)
- Modify: `public/styles.css` (after the `.tut-controls` rules, line 327)

**Interfaces:**
- Consumes: `settlePurchase`, `settleFlip`, `CARD_PAYOUT`, `SUIT_SYMBOLS` from `window.GameCore`; `.stake-chip` / `.seat-stakes` styles from Task 7; `.rail-flash.pay`.

- [ ] **Step 1: Styles for the stepper**

After the `.tut-controls .chip-btn[aria-pressed="true"]` rule add:

```css
.tut-stepper { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 0.9rem; }
.tut-stepper output { min-width: 1.6em; text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--ink); font-weight: 700; }
```

- [ ] **Step 2: Imports, mini table, helpers**

Line 5:
```js
const { settlePurchase, settleFlip, SUIT_SYMBOLS, SUITS, POOL_PER_SUIT, CARD_PAYOUT } = window.GameCore;
```

In `miniTable`, change the seat `innerHTML` to include a stake row after the score:

```js
    seat.innerHTML = `<div class="bid-tag" hidden></div><div class="avatar" style="--seat-color: var(--seat-${i + 1})">${name[0]}</div><div class="seat-stack"></div><div class="seat-name">${name}</div><div class="seat-score"><span class="score-num">0</span></div><div class="seat-stakes"></div>`;
```

and add to the returned object: `stakes: (i) => seatEls[i].querySelector(".seat-stakes"),`.

Add after `showTag`:

```js
// A suit chip lands on a seat's stake row, the way the live table shows a
// bought suit.
async function landStake(ctx, m, i, suit) {
  const chip = document.createElement("span");
  chip.className = `stake-chip ${suit}`;
  chip.textContent = SUIT_SYMBOLS[suit];
  m.stakes(i).replaceChildren(chip);
  await ctx.animate(chip, [{ transform: "scale(0.3)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.7 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "ease-out" });
}

function flashPay(ctx, m) {
  m.flash.className = "rail-flash pay";
  ctx.animate(m.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
}

// One later heart: the card turns over and 10 flies from each seller to the
// owner (seat 0). `quick` skips the comparison beat for replays.
async function heartPays(ctx, m, quick) {
  if (quick) {
    await turnReference(ctx, m, "hearts", 350);
    flashPay(ctx, m);
  } else {
    await turnReference(ctx, m, "hearts", 550, () => flashPay(ctx, m));
  }
  await Promise.all([chips(ctx, m, 1, 0, quick ? 3 : 5), chips(ctx, m, 2, 0, quick ? 3 : 5)]);
}
```

- [ ] **Step 3: Slides 1, 4, 5**

Slide 1 (index 0) becomes:

```js
  {
    caption: "Each round you bid for the suit on top. Own it, and every later flip of that suit pays you 10 from each player who sold it to you. Most chips when the deck runs out wins.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await ctx.wait(400);
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      await heartPays(ctx, m, false);
      await ctx.wait(300);
      await heartPays(ctx, m, true);
      await ctx.wait(1200);
    }
  },
```

Slide 4 (index 3) becomes:

```js
  {
    caption: "Everyone bids 0 to 100 in secret. The highest bid wins the suit and pays each other player the price that player bid. If two tie at the top, both buy.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await ctx.wait(300);
      await showTag(ctx, m, 2, 20, false);
      await ctx.wait(250);
      await showTag(ctx, m, 1, 50, false);
      await ctx.wait(250);
      await showTag(ctx, m, 0, 80, true);
      m.price.hidden = false;
      m.price.textContent = `${SUIT_SYMBOLS.hearts} 80`;
      await ctx.animate(m.price, [{ transform: "translateX(-50%) scale(0.3)", opacity: 0 }, { transform: "translateX(-50%) scale(1)", opacity: 1 }], { duration: 220 });
      await ctx.wait(1200);
    }
  },
```

Slide 5 (index 4) becomes (`opts.hearts` is the stepper value, 1..9, the total number of later hearts including the one shown):

```js
  {
    caption: "You pay each player their bid. Every later heart pays you 10 from each of them, so a bid of 47 says you expect about 4.7 more.",
    controls: true,
    async run(ctx, m, opts) {
      const n = opts.hearts;
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      for (const [i, v] of [[0, 80], [1, 50], [2, 20]]) {
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(v);
      }
      m.seatEls[0].classList.add("buyer");
      m.price.hidden = false;
      m.price.textContent = `${SUIT_SYMBOLS.hearts} 80`;
      let scores = [0, 0, 0];
      const paint = () => scores.forEach((v, i) => m.score(i, v));
      paint();
      await ctx.wait(400);
      await Promise.all([chips(ctx, m, 0, 1), chips(ctx, m, 0, 2)]);
      scores = [-70, 50, 20];
      paint();
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      for (let i = 0; i < n; i++) {
        await heartPays(ctx, m, i > 0);
        scores = [scores[0] + 20, scores[1] - 10, scores[2] - 10];
        paint();
        await ctx.wait(i > 0 ? 150 : 400);
      }
      // End on the same net-delta badges live play shows.
      const badges = scores.map((d, i) => {
        const badge = document.createElement("div");
        badge.className = "delta-badge " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        badge.textContent = fmt(d);
        m.seatEls[i].append(badge);
        ctx.animate(badge, [{ transform: "translate(-50%, 0) scale(0.6)", opacity: 0 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1 }], { duration: 150, easing: "ease-out" }).catch(() => {});
        return badge;
      });
      try {
        await ctx.wait(1600);
      } finally {
        for (const b of badges) b.remove();
      }
    }
  },
```

Slide 6 (index 5) caption becomes `"Move the bids. Notice who wins the suit and who wins the money."`.

- [ ] **Step 4: Dialog controls and state**

In `createTutorial`, replace the `.tut-controls` markup inside `dialog.innerHTML`:

```html
      <div class="tut-controls" hidden>
        <label class="tut-stepper">hearts to come
          <button type="button" class="step-btn" data-step="-1" aria-label="One fewer heart">−</button>
          <output>4</output>
          <button type="button" class="step-btn" data-step="1" aria-label="One more heart">+</button>
        </label>
      </div>
```

Replace `let matched = true;` with `let hearts = 4;`. Replace the controls handler block (`for (const btn of controls.querySelectorAll("button")) { ... }`) with:

```js
  const stepperOut = controls.querySelector("output");
  for (const btn of controls.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      hearts = Math.max(1, Math.min(9, hearts + Number(btn.dataset.step)));
      stepperOut.value = String(hearts);
      show(index);
    });
  }
```

In `show`, change `slide.run(ctx, m, { matched })` to `slide.run(ctx, m, { hearts })`.

- [ ] **Step 5: The calculator**

Replace `renderCalculator` with:

```js
  // Last slide: the mini table stays on screen and reflects the sliders live
  // (buyer glow, bid tags, winning-bid badge, stake chip, scores), with the
  // calculator below. Net = purchase + N later hearts, N from the stepper.
  function renderCalculator(m) {
    const wrap = document.createElement("div");
    wrap.className = "calc";
    m.refSlot.replaceChildren(cardEl("hearts", "big"));
    const rows = NAMES.map((name, i) => {
      const row = document.createElement("div");
      row.className = "calc-row";
      row.innerHTML = `<span class="calc-name">${name}</span><input type="range" min="0" max="100" value="${[80, 50, 20][i]}" aria-label="${name} bid"><span class="calc-bid mono"></span><span class="calc-delta mono"></span>`;
      wrap.append(row);
      return row;
    });
    const stepper = document.createElement("label");
    stepper.className = "tut-stepper";
    stepper.innerHTML = `hearts to come <button type="button" class="step-btn" data-step="-1" aria-label="One fewer heart">−</button><output>4</output><button type="button" class="step-btn" data-step="1" aria-label="One more heart">+</button>`;
    const note = document.createElement("p");
    note.className = "calc-note mono";
    wrap.append(stepper, note);
    let later = 4;
    const update = () => {
      const bids = {};
      rows.forEach((row, i) => {
        bids[NAMES[i]] = Number(row.querySelector("input").value);
        row.querySelector(".calc-bid").textContent = String(bids[NAMES[i]]);
      });
      const r = settlePurchase(bids);
      const stakes = r.void ? [] : [{ auction: 1, suit: "hearts", buyers: r.buyers, sellers: r.sellers }];
      const flip = settleFlip(stakes, "hearts", NAMES);
      rows.forEach((row, i) => {
        const name = NAMES[i];
        const d = r.deltas[name] + later * flip.deltas[name];
        const cell = row.querySelector(".calc-delta");
        cell.textContent = fmt(d);
        cell.className = "calc-delta mono " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        const buyer = r.buyers.includes(name);
        row.classList.toggle("buyer", buyer);
        m.seatEls[i].classList.toggle("buyer", buyer);
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(bids[name]);
        m.stakes(i).replaceChildren();
        if (buyer) {
          const chip = document.createElement("span");
          chip.className = "stake-chip hearts";
          chip.textContent = SUIT_SYMBOLS.hearts;
          m.stakes(i).append(chip);
        }
        m.score(i, d);
      });
      m.price.hidden = false;
      m.price.textContent = r.void ? "no trade" : `${SUIT_SYMBOLS.hearts} ${r.topBid}`;
      m.price.classList.toggle("void", r.void);
      note.textContent = r.void ? "no trade" : `${r.buyers.join(" & ")} ${r.buyers.length > 1 ? "buy" : "buys"} hearts; ${later} more heart${later === 1 ? "" : "s"} pay${later === 1 ? "s" : ""} ${CARD_PAYOUT} each`;
    };
    for (const row of rows) row.querySelector("input").addEventListener("input", update);
    const out = stepper.querySelector("output");
    for (const btn of stepper.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        later = Math.max(0, Math.min(9, later + Number(btn.dataset.step)));
        out.value = String(later);
        update();
      });
    }
    update();
    return wrap;
  }
```

- [ ] **Step 6: Check the worked example by hand in the browser**

Run: `node --check public/js/tutorial.js`, then start `PORT=3011 node server.js`, open `http://localhost:3011/how-to-play`, and walk all six slides. On slide 6 with the default sliders 80/50/20 and 4 hearts, the deltas must read `+10 / +10 / −20` (You: −70 + 80; A: +50 − 40; B: +20 − 40). Move A to 80 to see a tie: You and A both buy, B's delta is `+40 − 80 = −40`... (B sells at 20 to each buyer, +40, and pays 10 to each of two buyers per heart, −80). Set all three to 0: `no trade`. Stop the server.

If a visible browser is not available, run the headless script from Task 10 with `PAGE=/how-to-play` and read `calc-slide6.png`.

- [ ] **Step 7: Commit**

```bash
git add public/js/tutorial.js public/styles.css
git commit -m "feat: tutorial teaches suit stakes, hearts-to-come stepper in the calculator"
```

---

### Task 10: Docs, headless verification, full suite

**Files:**
- Modify: `AGENTS.md:8-11`
- Create (scratch, not committed): `C:/Users/khe61/AppData/Local/Temp/claude/C--dev-follow-suit/ab108ac2-6a5e-4455-9062-2cca4716b4f0/scratchpad/stakes-check.mjs`

- [ ] **Step 1: Full-game socket test**

Append to `tests/server.test.js` (the spawned server runs `DEAL_MS=50`, `BID_MS=4000`, `REVEAL_BIDS_MS=50`, `REVEAL_CARD_MS=50`, so two humans who lock at once finish 19 auctions in a few seconds):

```js
test("a full two-player game reaches results with scores equal to the sum of round deltas", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  let s = await a.until((m) => m.type === "state" && m.phase === "bidding" && m.auctionIndex === 1, "auction 1");
  while (s.phase !== "results") {
    const k = s.auctionIndex;
    const before = a.messages.length;
    a.send({ type: "bid", auction: k, amount: 30, locked: true });
    b.send({ type: "bid", auction: k, amount: 10, locked: true });
    s = await a.until((m) => m.type === "state" && (m.phase === "results" || (m.phase === "bidding" && m.auctionIndex === k + 1)), `after auction ${k}`, before);
  }
  assert.equal(s.history.length, 19);
  assert.equal(s.stakes.length, 19);
  for (const p of s.players) {
    const total = s.history.reduce((acc, h) => acc + (h.deltas[p.id] || 0), 0);
    assert.equal(p.score, total, `${p.id} score reconciles with history`);
  }
  assert.equal(s.players.reduce((acc, p) => acc + p.score, 0), 0);
  assert.ok(s.history.every((h) => h.buyers.length === 1 && h.buyers[0] === a.playerId), "Ann outbids Ben every round");
  a.ws.close();
  b.ws.close();
});
```

Run: `node --test tests/server.test.js`
Expected: PASS, the new test in a few seconds.

```bash
git add tests/server.test.js
git commit -m "test: a full socket game reconciles scores with history deltas"
```

- [ ] **Step 1b: AGENTS.md**

Replace the first paragraph under `## What this is` with:

```markdown
Follow Suit: a multiplayer card auction that teaches the winner's curse. Each
round players bid for the suit of the card on top; the highest bidder buys it
from every other player, paying each seller that seller's own bid, and every
later flip of that suit pays the owner 10 per seller. Express 5 plus raw
WebSockets (`ws`), vanilla JS in the browser, server-side bots. The rules are
in `docs/superpowers/specs/2026-09-13-suit-stakes-design.md` (which amends
`2026-09-12-follow-suit-design.md`); the client (poker-table layout, dealing
phase, animations, sound effects, tutorial) is in
`docs/superpowers/specs/2026-09-13-game-feel-design.md`.
```

- [ ] **Step 2: Headless verification script**

Write the scratch file below and run it against a server started with `PORT=3011 DEAL_MS=1500 BID_MS=4000 REVEAL_BIDS_MS=3000 node server.js` from the worktree. The tab in the Claude-in-Chrome extension stays `hidden` and freezes animations (see `LEARNINGS.md`), so headless Chromium is the verification path.

```js
// Headless check of the suit-stakes client: quick play, watch two reveals,
// assert the stake chip, the streams' amounts, the badge, and no errors.
import { chromium } from "file:///C:/dev/traderprep/node_modules/playwright/index.mjs";

const out = "C:/Users/khe61/AppData/Local/Temp/claude/C--dev-follow-suit/ab108ac2-6a5e-4455-9062-2cca4716b4f0/scratchpad";
const page0 = process.env.PAGE || "/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://localhost:3011${page0}`);
if (page0 !== "/") {
  await page.waitForTimeout(1500);
  for (let i = 0; i < 5; i++) { await page.click(".tut-next"); await page.waitForTimeout(600); }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/calc-slide6.png` });
  console.log(JSON.stringify({ errors, deltas: await page.$$eval(".calc-delta", (els) => els.map((e) => e.textContent)) }));
  await browser.close();
  process.exit(0);
}
await page.fill("#nameInput", "Kenny");
await page.evaluate(() => {
  window.__log = { badges: [], chips: [], hints: [] };
  const seen = new WeakSet();
  const mo = new MutationObserver(() => {
    for (const b of document.querySelectorAll(".delta-badge")) if (!seen.has(b)) { seen.add(b); window.__log.badges.push(b.textContent); }
    for (const c of document.querySelectorAll(".seat-stakes .stake-chip")) if (!seen.has(c)) { seen.add(c); window.__log.chips.push(c.className + ":" + c.textContent); }
    const h = document.getElementById("bidHint");
    if (h && h.textContent && window.__log.hints[window.__log.hints.length - 1] !== h.textContent) window.__log.hints.push(h.textContent);
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
});
await page.click("text=Quick play");
await page.waitForSelector("#dock:not([hidden])", { timeout: 20000 });
console.log("hint at auction 1:", await page.textContent("#bidHint"));
await page.waitForSelector(".price-badge:not([hidden])", { timeout: 20000 });
await page.waitForTimeout(2600);
await page.screenshot({ path: `${out}/stakes-purchase.png` });
await page.waitForSelector(".delta-badge", { timeout: 20000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/stakes-payout.png` });
await page.waitForTimeout(16000);
await page.click("#logPayoutsBtn");
await page.screenshot({ path: `${out}/stakes-log.png` });
const rows = await page.$$eval("#logBody tr", (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent).join(" | ")));
const seats = await page.$$eval(".seat", (els) => els.map((e) => e.getAttribute("aria-label")));
console.log(JSON.stringify({ errors, log: await page.evaluate(() => window.__log), rows, seats }, null, 1));
await browser.close();
```

Run: `node stakes-check.mjs` from the scratchpad. Expected: `errors` is `[]`; the auction-1 hint is `4.4 cards` (or whatever `priorValue` gives for that deck; it must equal the number in the dock ÷ 10); `chips` lists at least one `stake-chip <suit>`; `badges` lists signed deltas; the Payouts log rows sum per player to the seat score in `seats`. Read the three screenshots: the purchase shot should show the winning-bid badge with a suit glyph and a stake chip under the buyer's score; the payout shot a gold flash or none and the badges under each score.

- [ ] **Step 3: Full suite and cleanup**

Run: `npm test`
Expected: PASS, every file. Stop the test server (find the PID with `netstat -ano | grep :3011` and `powershell.exe -Command "Stop-Process -Id <pid> -Force"`).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: describe suit stakes in AGENTS.md"
```

---

## Self-review notes

- Spec coverage: 2.2/2.3/2.4 → Tasks 1, 4; 2.5/3.5 → Task 5; 3.1 → Task 1; 3.2/3.6 → Task 4; 3.3 → Task 2; 3.4 → Task 3; 4.1 → Task 6; 4.2/4.3/4.5 → Task 7; 4.4 → Task 8; 4.6/4.7 → Task 9; 4.8 → Task 10; 5 → each task's tests, the full-game socket test in Task 10, and Task 10's headless run.
- Codex review of this plan (2026-09-13) fixed: a duplicate-declaration instruction in Task 7, an un-awaited stake-chip pop in Task 8 that the sequencer would have cancelled, an overwritten announcement in Task 8, the missing different-reference stake test in Task 4, the missing socket game in Task 10, the interim-failure notes in Tasks 1, 4, and 5, and the stale meta description.
- `paymentStreams` takes `(entry, step)`, not `(entry, ids, step)` as the spec wrote: the entry now carries `sellers`, so `ids` had no use.
- Names used across tasks: `settlePurchase`, `settleFlip`, `priorValue`, `CARD_PAYOUT`, `expectedRemaining`, `legBaseline`, `paymentStreams`, `CARD_TIMELINE_MS`, `.seat-stakes`, `.stake-chip`, `#bidHint`, `.rail-flash.pay`, `topBid`, `hits`, `payouts`, `purchase`.
