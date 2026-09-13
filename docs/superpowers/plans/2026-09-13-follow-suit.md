# Follow Suit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Follow Suit, a standalone multiplayer card-auction website with server-side bots, from an empty repo to a deployable Node service with a vanilla-JS client.

**Architecture:** Express 5 serves static files and a WebSocket endpoint; `lib/rooms.js` owns rooms and seats, `lib/game.js` owns the per-room auction state machine with injected clock and timers, `lib/snapshot.js` builds the per-recipient state message, and `lib/fair-value.js` plus `lib/bots.js` give bots an exact Bayesian estimate to bid around. `public/game-core.js` holds the rules both server and browser share. The client is one page that renders whatever `state` message it last received.

**Tech Stack:** Node 22, Express 5, `ws` 8, `node --test`, vanilla JS/CSS/HTML (no bundler, no framework, no linter).

**Spec:** `docs/superpowers/specs/2026-09-12-follow-suit-design.md`

## Global Constraints

- Node `>=22`. Dependencies: exactly `express` (^5) and `ws` (^8). No dev dependencies.
- CommonJS everywhere (`require`), matching `emoji/`. `public/game-core.js` uses the UMD wrapper so the browser and the server load the same file.
- `lib/fair-value.js` and `lib/bots.js` must never be served to the browser. Only `public/` is static.
- Pool: 10 of each of `spades, hearts, diamonds, clubs`. Hand sizes by player count: `{2: 8, 3: 6, 4: 4, 5: 4, 6: 3}`. Bids are integers 0 to 100. Payout is 100.
- Defaults: `BID_MS` 20000, `REVEAL_BIDS_MS` 2500, `REVEAL_CARD_MS` 3000, `RESUME_TTL_MS` 600000, `PORT` 3000. Read once at startup in `server.js`.
- Seat-takeover close code is `4000`; the client must not auto-reconnect on it.
- All timers in `lib/` are injected (`now`, `setTimeout`, `clearTimeout`) so tests never sleep.
- Every commit message ends with the two attribution lines given in the session's system reminder.
- Tests: `npm test` runs `node --test`. Do not add other test runners.
- Work on `main` in `C:\dev\follow-suit` (fresh repo, no worktree needed).
- Every shell command in this plan is written for the Bash tool, which runs Git Bash on this machine. `PORT=3210 npm start`, `grep`, and `curl` are correct as written; do not translate them to PowerShell.

---

## File map

| File | Responsibility |
| --- | --- |
| `package.json` | name, scripts (`start`, `test`), deps, engines |
| `public/game-core.js` | shared rules: constants, `handSize`, `deal`, `countSuits`, `resolveBids`, `settle`, `rank` |
| `lib/fair-value.js` | `nextSuitProbabilities`, `fairValue` (exact posterior) |
| `lib/bots.js` | bot names, profiles, `computeBotBid`, `botDelayMs` |
| `lib/game.js` | `createGame(deps)` state machine: lobby → bidding → reveal → results |
| `lib/snapshot.js` | `buildState(room, recipientId)` per-recipient state message |
| `lib/rooms.js` | `createRegistry(deps)`: rooms, seats, host, tokens, expiry, deletion |
| `server.js` | env config, Express routes, WebSocket wiring, broadcast |
| `public/index.html` | app shell with the four views |
| `public/styles.css` | all styling |
| `public/client.js` | socket, reconnect, rendering |
| `public/how-to-play.html` | rules page |
| `tests/*.test.js` | one file per module plus `server.test.js` |
| `render.yaml`, `AGENTS.md`, `CLAUDE.md`, `LEARNINGS.md`, `.gitignore` | deploy and repo docs |

---

### Task 1: Scaffold and shared rules (`game-core.js`)

**Files:**
- Create: `package.json`, `.gitignore`, `public/game-core.js`
- Test: `tests/game-core.test.js`

**Interfaces:**
- Produces (from `public/game-core.js`, exported as CommonJS and as `window.GameCore`):
  - `SUITS: string[]` = `["spades","hearts","diamonds","clubs"]`
  - `SUIT_SYMBOLS: {[suit]: string}`, `POOL_PER_SUIT = 10`, `MIN_PLAYERS = 2`, `MAX_PLAYERS = 6`, `HAND_SIZES`, `PAYOUT = 100`, `MAX_BID = 100`
  - `handSize(playerCount): number` (throws `RangeError` outside 2..6)
  - `buildPool(): string[]` (40 suits)
  - `shuffle(cards, randomInt?): string[]` where `randomInt(maxExclusive)` returns an int in `[0, maxExclusive)`
  - `countSuits(cards): {spades, hearts, diamonds, clubs}`
  - `deal(playerCount, randomInt?): { hands: string[][], hidden: string[], deck: string[] }`
  - `resolveBids(bids: {[id]: number}): { price, buyers: string[], sellers: string[], void: boolean }`
  - `settle(bids, matched: boolean): { price, buyers, sellers, void, deltas: {[id]: number} }`
  - `rank(scores: {[id]: number}): Array<{id, score, rank}>` sorted by score desc, competition ranking

- [ ] **Step 1: Create package.json and .gitignore**

`package.json`:

```json
{
  "name": "follow-suit",
  "version": "0.1.0",
  "private": true,
  "description": "Follow Suit: a multiplayer card auction that teaches the winner's curse",
  "main": "server.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^5.1.0",
    "ws": "^8.18.0"
  }
}
```

`.gitignore`:

```
node_modules/
.env
.DS_Store
```

Run: `npm install`
Expected: `node_modules/express` and `node_modules/ws` exist, `package-lock.json` created.

- [ ] **Step 2: Write the failing tests**

`tests/game-core.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const GameCore = require("../public/game-core.js");
const { SUITS, HAND_SIZES, handSize, buildPool, shuffle, countSuits, deal, resolveBids, settle, rank } = GameCore;

// Deterministic randomInt: always picks the last index, so shuffle is identity.
const identityRandom = (n) => n - 1;

test("hand-size table matches the spec", () => {
  assert.deepEqual(HAND_SIZES, { 2: 8, 3: 6, 4: 4, 5: 4, 6: 3 });
  assert.equal(handSize(2), 8);
  assert.throws(() => handSize(1), RangeError);
  assert.throws(() => handSize(7), RangeError);
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

for (const playerCount of [2, 3, 4, 5, 6]) {
  test(`deal(${playerCount}) sizes and multiset invariant`, () => {
    const n = handSize(playerCount);
    const { hands, hidden, deck } = deal(playerCount);
    assert.equal(hands.length, playerCount);
    for (const hand of hands) assert.equal(hand.length, n);
    assert.equal(hidden.length, n);
    assert.equal(deck.length, (playerCount + 1) * n);
    const dealtCounts = countSuits(hands.flat().concat(hidden));
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../public/game-core.js'`.

- [ ] **Step 4: Implement `public/game-core.js`**

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SUITS = ["spades", "hearts", "diamonds", "clubs"];
  const SUIT_SYMBOLS = { spades: "\u2660", hearts: "\u2665", diamonds: "\u2666", clubs: "\u2663" };
  const POOL_PER_SUIT = 10;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 6;
  const HAND_SIZES = { 2: 8, 3: 6, 4: 4, 5: 4, 6: 3 };
  const PAYOUT = 100;
  const MAX_BID = 100;

  function handSize(playerCount) {
    const n = HAND_SIZES[playerCount];
    if (!n) throw new RangeError(`unsupported player count: ${playerCount}`);
    return n;
  }

  function buildPool() {
    const pool = [];
    for (const suit of SUITS) for (let i = 0; i < POOL_PER_SUIT; i++) pool.push(suit);
    return pool;
  }

  function defaultRandomInt(maxExclusive) {
    return Math.floor(Math.random() * maxExclusive);
  }

  // Fisher-Yates on a copy. randomInt(n) must return an integer in [0, n).
  function shuffle(cards, randomInt = defaultRandomInt) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function countSuits(cards) {
    const counts = {};
    for (const suit of SUITS) counts[suit] = 0;
    for (const card of cards) counts[card] += 1;
    return counts;
  }

  // Hands come off the top of a shuffled pool, then n hidden cards, then the
  // deck is those hands plus the hidden cards reshuffled. The rest of the pool
  // is discarded unseen.
  function deal(playerCount, randomInt = defaultRandomInt) {
    const n = handSize(playerCount);
    const pool = shuffle(buildPool(), randomInt);
    const hands = [];
    for (let p = 0; p < playerCount; p++) hands.push(pool.slice(p * n, (p + 1) * n));
    const hidden = pool.slice(playerCount * n, (playerCount + 1) * n);
    const deck = shuffle(hands.flat().concat(hidden), randomInt);
    return { hands, hidden, deck };
  }

  function resolveBids(bids) {
    const ids = Object.keys(bids);
    let price = 0;
    for (const id of ids) price = Math.max(price, bids[id]);
    const top = ids.filter((id) => bids[id] === price);
    const sellers = ids.filter((id) => bids[id] !== price);
    const isVoid = sellers.length === 0;
    return { price, buyers: isVoid ? [] : top, sellers, void: isVoid };
  }

  function settle(bids, matched) {
    const result = resolveBids(bids);
    const deltas = {};
    for (const id of Object.keys(bids)) deltas[id] = 0;
    if (!result.void) {
      const payout = matched ? PAYOUT : 0;
      for (const id of result.buyers) deltas[id] = (payout - result.price) * result.sellers.length;
      for (const id of result.sellers) deltas[id] = (result.price - payout) * result.buyers.length;
    }
    return { price: result.price, buyers: result.buyers, sellers: result.sellers, void: result.void, deltas };
  }

  function rank(scores) {
    const rows = Object.keys(scores)
      .map((id) => ({ id, score: scores[id] }))
      .sort((a, b) => b.score - a.score);
    let current = 0;
    rows.forEach((row, i) => {
      if (i === 0 || row.score !== rows[i - 1].score) current = i + 1;
      row.rank = current;
    });
    return rows;
  }

  return {
    SUITS, SUIT_SYMBOLS, POOL_PER_SUIT, MIN_PLAYERS, MAX_PLAYERS, HAND_SIZES, PAYOUT, MAX_BID,
    handSize, buildPool, shuffle, countSuits, deal, resolveBids, settle, rank
  };
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests in `tests/game-core.test.js` PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore public/game-core.js tests/game-core.test.js
git commit -m "feat: scaffold repo and shared game rules"
```

---

### Task 2: Exact fair value (`lib/fair-value.js`)

**Files:**
- Create: `lib/fair-value.js`
- Test: `tests/fair-value.test.js`

**Interfaces:**
- Consumes: `SUITS`, `POOL_PER_SUIT`, `handSize` from `public/game-core.js`.
- Produces:
  - `nextSuitProbabilities({ hand, flips, playerCount }): {[suit]: number}` where `hand` and `flips` are suit-count objects (as from `countSuits`). Throws `RangeError` if the hand does not sum to `handSize(playerCount)` or no cards remain.
  - `fairValue({ hand, flips, playerCount, reference }): number` in `[0, 100]`, unrounded.

- [ ] **Step 1: Write the failing tests**

`tests/fair-value.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { SUITS, buildPool, shuffle, countSuits, handSize } = require("../public/game-core.js");
const { nextSuitProbabilities, fairValue } = require("../lib/fair-value.js");

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
  const p = nextSuitProbabilities({ hand: { spades: 3, hearts: 2, diamonds: 2, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 2, clubs: 0 }, playerCount: 2 });
  assert.ok(Math.abs(sum(p) - 1) < 1e-12);
});

test("uniform hand with no flips gives the pool prior", () => {
  const p = nextSuitProbabilities({ hand: { spades: 2, hearts: 2, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 });
  for (const s of SUITS) assert.ok(Math.abs(p[s] - 0.25) < 1e-12, `${s}=${p[s]}`);
});

test("with no flips the answer equals the closed form (hand + expected unseen) / deck", () => {
  // Two players, hand 6/1/1/0. The 16 unseen deck cards are a uniform draw
  // from the 32 pool cards left, which hold 4 spades, 9 hearts, 9 diamonds and
  // 10 clubs, so E[deck spades] = 6 + 16 * 4/32 = 8 and P(spades) = 8/24.
  const p = nextSuitProbabilities({ hand: { spades: 6, hearts: 1, diamonds: 1, clubs: 0 }, flips: zero(), playerCount: 2 });
  const expected = {
    spades: (6 + 16 * 4 / 32) / 24,
    hearts: (1 + 16 * 9 / 32) / 24,
    diamonds: (1 + 16 * 9 / 32) / 24,
    clubs: (0 + 16 * 10 / 32) / 24
  };
  for (const s of SUITS) assert.ok(Math.abs(p[s] - expected[s]) < 1e-9, `${s}: ${p[s]} vs ${expected[s]}`);
  assert.ok(Math.abs(p.spades - 1 / 3) < 1e-9);
});

test("flipping a suit lowers it", () => {
  const before = nextSuitProbabilities({ hand: { spades: 2, hearts: 2, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 });
  const after = nextSuitProbabilities({ hand: { spades: 2, hearts: 2, diamonds: 2, clubs: 2 }, flips: { spades: 4, hearts: 0, diamonds: 0, clubs: 0 }, playerCount: 2 });
  assert.ok(after.spades < before.spades);
});

test("fairValue is 100 * probability of the reference suit", () => {
  const args = { hand: { spades: 6, hearts: 1, diamonds: 1, clubs: 0 }, flips: zero(), playerCount: 2 };
  const p = nextSuitProbabilities(args);
  assert.ok(Math.abs(fairValue({ ...args, reference: "spades" }) - 100 * p.spades) < 1e-9);
});

test("rejects a hand of the wrong size", () => {
  assert.throws(() => nextSuitProbabilities({ hand: { spades: 1, hearts: 0, diamonds: 0, clubs: 0 }, flips: zero(), playerCount: 2 }), RangeError);
});

// Monte Carlo of the real procedure, conditioning by rejection on both the
// hand and the flips.
function monteCarlo({ hand, flips, playerCount }, samples, random) {
  const n = handSize(playerCount);
  const k = sum(flips);
  const hits = zero();
  let accepted = 0;
  const randomInt = (m) => Math.floor(random() * m);
  while (accepted < samples) {
    const pool = shuffle(buildPool(), randomInt);
    const hc = countSuits(pool.slice(0, n));
    if (SUITS.some((s) => hc[s] !== hand[s])) continue;
    const deck = shuffle(pool.slice(0, (playerCount + 1) * n), randomInt);
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
    { hand: { spades: 2, hearts: 2, diamonds: 2, clubs: 2 }, flips: zero(), playerCount: 2 },
    { hand: { spades: 1, hearts: 1, diamonds: 1, clubs: 1 }, flips: { spades: 1, hearts: 0, diamonds: 0, clubs: 0 }, playerCount: 4 }
  ];
  const random = seeded(20260913);
  for (const c of cases) {
    const exact = nextSuitProbabilities(c);
    const mc = monteCarlo(c, 100000, random);
    for (const s of SUITS) assert.ok(Math.abs(exact[s] - mc[s]) < 0.005, `${JSON.stringify(c)} ${s}: exact ${exact[s]} mc ${mc[s]}`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/fair-value.test.js`
Expected: FAIL with `Cannot find module '../lib/fair-value.js'`.

- [ ] **Step 3: Implement `lib/fair-value.js`**

```js
"use strict";
const { SUITS, POOL_PER_SUIT, handSize } = require("../public/game-core.js");

// log(n!) for n up to 64, enough for a 40-card pool.
const LOG_FACT = [0];
for (let i = 1; i <= 64; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k];
}

function total(counts) {
  return SUITS.reduce((acc, s) => acc + (counts[s] || 0), 0);
}

// Spec 4.6. From one player's view the unseen part of the deck U is a uniform
// P*n-subset of (pool - hand); the deck D = H + U is flipped in uniform order.
// Weight each composition U by MVH(U; pool-H) * MVH(F; D), dropping the
// normalising binomials that are constant across U, then take the expectation
// of (D_s - F_s) / (|D| - k). Computed in log space and normalised with
// log-sum-exp.
function nextSuitProbabilities({ hand, flips, playerCount }) {
  const n = handSize(playerCount);
  if (total(hand) !== n) throw new RangeError(`hand must hold ${n} cards`);
  const H = SUITS.map((s) => hand[s] || 0);
  const F = SUITS.map((s) => flips[s] || 0);
  const unknown = playerCount * n;
  const deckSize = (playerCount + 1) * n;
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
    for (let i = 0; i < 4; i++) acc[i] += (w * (D[i] - F[i])) / (deckSize - k);
  }
  const out = {};
  SUITS.forEach((s, i) => { out[s] = acc[i] / z; });
  return out;
}

function fairValue({ hand, flips, playerCount, reference }) {
  const p = nextSuitProbabilities({ hand, flips, playerCount });
  return 100 * p[reference];
}

module.exports = { nextSuitProbabilities, fairValue };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/fair-value.test.js`
Expected: all PASS. The Monte Carlo test should take roughly ten seconds.

- [ ] **Step 5: Commit**

```bash
git add lib/fair-value.js tests/fair-value.test.js
git commit -m "feat: exact Bayesian fair value for the next suit"
```

---

### Task 3: Bots (`lib/bots.js`)

**Files:**
- Create: `lib/bots.js`
- Test: `tests/bots.test.js`

**Interfaces:**
- Consumes: `fairValue` from `lib/fair-value.js`.
- Produces:
  - `BOT_NAMES: string[]` = `["Bot Ada","Bot Bo","Bot Cy","Bot Di","Bot Eve"]`
  - `BOT_PROFILES: Array<{key, shade, sigma}>` (careful 0.85/2, fair 0.93/2, keen 1.0/3, wild 1.08/6)
  - `pickBotName(takenNames: string[]): string | null`
  - `botProfile(botIndex: number): {key, shade, sigma}` cycling through `BOT_PROFILES`
  - `computeBotBid({ profile, hand, flips, playerCount, reference }, random?): number` integer in `[0, 100]`
  - `botDelayMs(bidMs, random?): number` in `[min(1500, hi), hi]` where `hi = min(6000, bidMs / 2)`

- [ ] **Step 1: Write the failing tests**

`tests/bots.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bots.test.js`
Expected: FAIL with `Cannot find module '../lib/bots.js'`.

- [ ] **Step 3: Implement `lib/bots.js`**

```js
"use strict";
const { fairValue } = require("./fair-value.js");

const BOT_NAMES = ["Bot Ada", "Bot Bo", "Bot Cy", "Bot Di", "Bot Eve"];
const BOT_PROFILES = [
  { key: "careful", shade: 0.85, sigma: 2 },
  { key: "fair", shade: 0.93, sigma: 2 },
  { key: "keen", shade: 1.0, sigma: 3 },
  { key: "wild", shade: 1.08, sigma: 6 }
];
const BOT_MIN_DELAY_MS = 1500;
const BOT_MAX_DELAY_MS = 6000;

// Standard normal via Box-Muller. With sigma 0 the caller gets exactly
// round(fair * shade), which the tests rely on.
function gaussian(random) {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pickBotName(takenNames) {
  return BOT_NAMES.find((name) => !takenNames.includes(name)) || null;
}

function botProfile(botIndex) {
  return BOT_PROFILES[botIndex % BOT_PROFILES.length];
}

function computeBotBid({ profile, hand, flips, playerCount, reference }, random = Math.random) {
  const fair = fairValue({ hand, flips, playerCount, reference });
  const noise = profile.sigma === 0 ? 0 : gaussian(random) * profile.sigma;
  const raw = Math.round(fair * profile.shade + noise);
  return Math.max(0, Math.min(100, raw));
}

function botDelayMs(bidMs, random = Math.random) {
  const hi = Math.min(BOT_MAX_DELAY_MS, Math.floor(bidMs / 2));
  const lo = Math.min(BOT_MIN_DELAY_MS, hi);
  return lo + Math.floor(random() * (hi - lo + 1));
}

module.exports = { BOT_NAMES, BOT_PROFILES, pickBotName, botProfile, computeBotBid, botDelayMs };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bots.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bots.js tests/bots.test.js
git commit -m "feat: bot profiles and bidding"
```

---

### Task 4: Game state machine (`lib/game.js`)

**Files:**
- Create: `lib/game.js`, `tests/helpers/clock.js`
- Test: `tests/game.test.js`

**Interfaces:**
- Consumes: `deal`, `settle`, `resolveBids`, `countSuits`, `MIN_PLAYERS`, `MAX_PLAYERS`, `MAX_BID` from `public/game-core.js`; `computeBotBid`, `botDelayMs` from `lib/bots.js`.
- Produces `createGame(deps)` where `deps = { now?, setTimeout?, clearTimeout?, randomInt?, random?, config?: { bidMs, revealBidsMs, revealCardMs }, onChange? }` returning a `game` object with:
  - fields: `phase` (`"lobby" | "bidding" | "reveal" | "results"`), `matchId`, `revealStep` (`null | "bids" | "card"`), `players: Array<{id, name, isBot, profile, connected, score, hand: string[]}>`, `deck: string[]`, `flipIndex`, `hiddenCount`, `auction: null | { index, deadlineAt, bids: {[id]: {amount, locked}} }`, `history: Array<{index, reference, bids: {[id]: number}, buyers, price, void, flipped, matched, deltas}>` (`flipped`, `matched`, `deltas` are `null` until the card step)
  - `start(seats: Array<{id, name, isBot, connected, profile}>)` throws unless `phase === "lobby"` and 2..6 seats
  - `bid(playerId, { auction, amount, locked }) → { ok: true } | { ok: false, error }` with errors `not_bidding | stale_auction | unknown_player | disconnected | bad_amount`
  - `setConnected(playerId, connected)`
  - `returnToLobby() → boolean` (only from results)
  - `destroy()` clears every timer
  - `reference() → suit | null`, `flipped() → string[]`, `cardsRemaining() → number`, `remainingMs() → number`
  - `onChange()` is called after every state transition, including on `start`.

- [ ] **Step 1: Write the fake clock helper**

`tests/helpers/clock.js`:

```js
"use strict";
// Deterministic clock + timers for lib/ tests. advance(ms) runs due timers in
// order of their due time, so a callback that arms another timer inside the
// same window also runs.
function createClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: current + ms, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const next = [...timers.values()].filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next.id);
        current = next.due;
        next.fn();
      }
      current = target;
    }
  };
}
module.exports = { createClock };
```

- [ ] **Step 2: Write the failing tests**

`tests/game.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGame } = require("../lib/game.js");
const { createClock } = require("./helpers/clock.js");

const CONFIG = { bidMs: 20000, revealBidsMs: 2500, revealCardMs: 3000 };

function setup({ seats, randomInt } = {}) {
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
  return { clock, game, changes };
}

test("start deals, flips one card and opens auction 1", () => {
  const { game } = setup();
  assert.equal(game.phase, "bidding");
  assert.equal(game.matchId, 1);
  assert.equal(game.flipIndex, 1);
  assert.equal(game.deck.length, 24);
  assert.equal(game.hiddenCount, 8);
  assert.equal(game.players[0].hand.length, 8);
  assert.equal(game.auction.index, 1);
  assert.equal(game.cardsRemaining(), 23);
  assert.ok(game.reference());
  assert.equal(game.remainingMs(), 20000);
});

test("start rejects wrong phase and bad player counts", () => {
  const { game } = setup();
  assert.throws(() => game.start([]), /lobby/);
  const g2 = createGame({ config: CONFIG });
  assert.throws(() => g2.start([{ id: "a", name: "A" }]), RangeError);
  g2.destroy();
});

test("missing bids resolve to 0 at the deadline", () => {
  const { clock, game } = setup();
  game.bid("p1", { auction: 1, amount: 30, locked: false });
  clock.advance(20000);
  assert.equal(game.phase, "reveal");
  assert.equal(game.revealStep, "bids");
  const entry = game.history[0];
  assert.deepEqual(entry.bids, { p1: 30, p2: 0 });
  assert.deepEqual(entry.buyers, ["p1"]);
  assert.equal(entry.price, 30);
  assert.equal(entry.flipped, null);
});

test("all locked resolves early and the stale deadline is harmless", () => {
  const { clock, game } = setup();
  game.bid("p1", { auction: 1, amount: 30, locked: true });
  assert.equal(game.phase, "bidding");
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  assert.equal(game.phase, "reveal");
  assert.equal(game.history.length, 1);
  clock.advance(2500);
  assert.equal(game.revealStep, "card");
  assert.ok(game.history[0].flipped);
  clock.advance(3000);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 2);
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

test("settlement applies score deltas and the flipped card becomes the reference", () => {
  const { clock, game } = setup();
  const oldReference = game.reference();
  game.bid("p1", { auction: 1, amount: 40, locked: true });
  game.bid("p2", { auction: 1, amount: 10, locked: true });
  clock.advance(2500);
  const entry = game.history[0];
  assert.equal(entry.reference, oldReference);
  assert.equal(entry.flipped, game.deck[1]);
  assert.equal(entry.matched, entry.flipped === oldReference);
  const expected = entry.matched ? { p1: 60, p2: -60 } : { p1: -40, p2: 40 };
  assert.deepEqual(entry.deltas, expected);
  assert.equal(game.players[0].score, expected.p1);
  assert.equal(game.players[1].score, expected.p2);
  assert.equal(game.reference(), entry.flipped);
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

test("a void auction records bids, no buyers, zero deltas, and still flips", () => {
  const { clock, game } = setup();
  game.bid("p1", { auction: 1, amount: 0, locked: true });
  game.bid("p2", { auction: 1, amount: 0, locked: true });
  clock.advance(2500);
  const entry = game.history[0];
  assert.equal(entry.void, true);
  assert.deepEqual(entry.buyers, []);
  assert.deepEqual(entry.deltas, { p1: 0, p2: 0 });
  assert.ok(entry.flipped);
  assert.equal(game.flipIndex, 2);
});

function playWholeGame(clock, game) {
  while (game.phase !== "results") {
    if (game.phase === "bidding") {
      for (const p of game.players) if (!p.isBot) game.bid(p.id, { auction: game.auction.index, amount: p.id === "p1" ? 25 : 10, locked: true });
    }
    clock.advance(2500);
    clock.advance(3000);
  }
}

test("the last auction leads to results with hands revealed and no pending timers", () => {
  const { clock, game } = setup();
  playWholeGame(clock, game);
  assert.equal(game.phase, "results");
  assert.equal(game.history.length, 23);
  assert.equal(game.cardsRemaining(), 0);
  assert.equal(game.auction, null);
  assert.equal(clock.pending(), 0);
  assert.equal(game.players[0].hand.length, 8);
  const sum = game.players.reduce((a, p) => a + p.score, 0);
  assert.equal(sum, 0);
});

test("two consecutive full games in one instance share no state", () => {
  const { clock, game } = setup();
  playWholeGame(clock, game);
  const firstDeck = game.deck.slice();
  assert.equal(game.returnToLobby(), true);
  assert.equal(game.phase, "lobby");
  assert.deepEqual(game.history, []);
  assert.deepEqual(game.players, []);
  game.start([
    { id: "p1", name: "Ann", isBot: false, connected: true },
    { id: "p2", name: "Ben", isBot: false, connected: true },
    { id: "p3", name: "Cat", isBot: false, connected: true }
  ]);
  assert.equal(game.matchId, 2);
  assert.equal(game.phase, "bidding");
  assert.equal(game.auction.index, 1);
  assert.deepEqual(game.history, []);
  assert.equal(game.deck.length, 24);
  assert.equal(game.flipIndex, 1);
  assert.equal(game.players.every((p) => p.score === 0), true);
  assert.equal(clock.pending(), 1);
  playWholeGame(clock, game);
  assert.equal(game.phase, "results");
  assert.equal(game.history.length, 23);
  assert.equal(game.history.every((h) => h.index >= 1 && h.index <= 23 && h.deltas !== null), true);
  assert.equal(game.players.length, 3);
  assert.equal(game.players.reduce((a, p) => a + p.score, 0), 0);
  assert.equal(clock.pending(), 0);
  assert.notEqual(game.deck.length, firstDeck.length, "three players deal a different deck size than two");
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/game.test.js`
Expected: FAIL with `Cannot find module '../lib/game.js'`.

- [ ] **Step 4: Implement `lib/game.js`**

```js
"use strict";
const crypto = require("node:crypto");
const GameCore = require("../public/game-core.js");
const { computeBotBid, botDelayMs } = require("./bots.js");
const { MIN_PLAYERS, MAX_PLAYERS, MAX_BID, deal, settle, resolveBids, countSuits } = GameCore;

const DEFAULT_CONFIG = { bidMs: 20000, revealBidsMs: 2500, revealCardMs: 3000 };

function createGame(deps = {}) {
  const now = deps.now || (() => Date.now());
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const randomInt = deps.randomInt || ((n) => crypto.randomInt(n));
  const random = deps.random || Math.random;
  const config = { ...DEFAULT_CONFIG, ...(deps.config || {}) };
  const onChange = deps.onChange || (() => {});

  const game = {
    phase: "lobby",
    matchId: 0,
    revealStep: null,
    players: [],
    deck: [],
    flipIndex: 0,
    hiddenCount: 0,
    auction: null,
    history: [],
    timer: null,
    botTimers: []
  };

  function player(id) {
    return game.players.find((p) => p.id === id) || null;
  }
  function reference() {
    return game.flipIndex > 0 ? game.deck[game.flipIndex - 1] : null;
  }
  function flipped() {
    return game.deck.slice(0, game.flipIndex);
  }
  function cardsRemaining() {
    return game.deck.length - game.flipIndex;
  }
  function remainingMs() {
    if (game.phase !== "bidding" || !game.auction) return 0;
    return Math.max(0, game.auction.deadlineAt - now());
  }

  function clearPhaseTimer() {
    if (game.timer) {
      clearT(game.timer.handle);
      game.timer = null;
    }
  }
  function clearBotTimers() {
    for (const handle of game.botTimers) clearT(handle);
    game.botTimers = [];
  }

  // One pending phase timer per game. The callback is a no-op unless this
  // entry is still the armed one and the match/auction it was armed for is
  // still current, so a stale deadline can never touch a later auction.
  function armTimer(kind, ms, fn) {
    clearPhaseTimer();
    const entry = { handle: null, kind, matchId: game.matchId, auctionIndex: game.auction ? game.auction.index : 0 };
    entry.handle = setT(() => {
      if (game.timer !== entry) return;
      if (game.matchId !== entry.matchId) return;
      if (game.auction && game.auction.index !== entry.auctionIndex) return;
      game.timer = null;
      try {
        fn();
      } catch (err) {
        console.error(`[game] ${kind} timer failed:`, err);
      }
    }, ms);
    game.timer = entry;
  }

  function resetMatch() {
    clearPhaseTimer();
    clearBotTimers();
    game.history = [];
    game.auction = null;
    game.revealStep = null;
    game.flipIndex = 0;
    game.deck = [];
    game.hiddenCount = 0;
    for (const p of game.players) {
      p.score = 0;
      p.hand = [];
    }
  }

  function start(seats) {
    if (game.phase !== "lobby") throw new Error("start requires the lobby phase");
    if (!Array.isArray(seats) || seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) {
      throw new RangeError(`need ${MIN_PLAYERS}..${MAX_PLAYERS} players`);
    }
    resetMatch();
    game.matchId += 1;
    const dealt = deal(seats.length, randomInt);
    game.players = seats.map((seat, i) => ({
      id: seat.id,
      name: seat.name,
      isBot: Boolean(seat.isBot),
      profile: seat.profile || null,
      connected: seat.connected !== false,
      score: 0,
      hand: dealt.hands[i]
    }));
    game.deck = dealt.deck;
    game.hiddenCount = dealt.hidden.length;
    game.flipIndex = 1;
    startAuction(1);
  }

  function startAuction(index) {
    game.phase = "bidding";
    game.revealStep = null;
    game.auction = { index, deadlineAt: now() + config.bidMs, bids: {} };
    scheduleBotBids();
    armTimer("deadline", config.bidMs, resolve);
    onChange();
  }

  function scheduleBotBids() {
    clearBotTimers();
    const auctionIndex = game.auction.index;
    const matchId = game.matchId;
    for (const p of game.players) {
      if (!p.isBot) continue;
      const handle = setT(() => {
        if (game.matchId !== matchId || game.phase !== "bidding" || !game.auction || game.auction.index !== auctionIndex) return;
        try {
          const amount = computeBotBid({
            profile: p.profile,
            hand: countSuits(p.hand),
            flips: countSuits(flipped()),
            playerCount: game.players.length,
            reference: reference()
          }, random);
          bid(p.id, { auction: auctionIndex, amount, locked: true });
        } catch (err) {
          console.error("[game] bot bid failed:", err);
        }
      }, botDelayMs(config.bidMs, random));
      game.botTimers.push(handle);
    }
  }

  function allLocked() {
    return game.players.every((p) => {
      const b = game.auction.bids[p.id];
      if (p.isBot) return Boolean(b);
      if (!p.connected) return true;
      return Boolean(b && b.locked);
    });
  }

  function bid(playerId, { auction, amount, locked }) {
    if (game.phase !== "bidding") return { ok: false, error: "not_bidding" };
    if (auction !== game.auction.index) return { ok: false, error: "stale_auction" };
    const p = player(playerId);
    if (!p) return { ok: false, error: "unknown_player" };
    if (!p.isBot && !p.connected) return { ok: false, error: "disconnected" };
    if (!Number.isInteger(amount) || amount < 0 || amount > MAX_BID) return { ok: false, error: "bad_amount" };
    game.auction.bids[playerId] = { amount, locked: Boolean(locked) };
    if (allLocked()) resolve();
    else onChange();
    return { ok: true };
  }

  // Both transitions below compute the whole result first and only then touch
  // game state, so a throw during the computation leaves the room as it was.
  function resolve() {
    if (game.phase !== "bidding") return;
    const bids = {};
    for (const p of game.players) bids[p.id] = game.auction.bids[p.id] ? game.auction.bids[p.id].amount : 0;
    const r = resolveBids(bids);
    const entry = {
      index: game.auction.index,
      reference: reference(),
      bids,
      buyers: r.buyers,
      price: r.price,
      void: r.void,
      flipped: null,
      matched: null,
      deltas: null
    };
    clearPhaseTimer();
    clearBotTimers();
    game.history.push(entry);
    game.phase = "reveal";
    game.revealStep = "bids";
    armTimer("revealBids", config.revealBidsMs, flipAndSettle);
    onChange();
  }

  function flipAndSettle() {
    const entry = game.history[game.history.length - 1];
    const card = game.deck[game.flipIndex];
    const matched = card === reference();
    const result = settle(entry.bids, matched);
    game.flipIndex += 1;
    entry.flipped = card;
    entry.matched = matched;
    entry.deltas = result.deltas;
    for (const p of game.players) p.score += result.deltas[p.id] || 0;
    game.revealStep = "card";
    armTimer("revealCard", config.revealCardMs, advance);
    onChange();
  }

  function advance() {
    if (cardsRemaining() > 0) {
      startAuction(game.auction.index + 1);
      return;
    }
    game.phase = "results";
    game.revealStep = null;
    game.auction = null;
    onChange();
  }

  function setConnected(playerId, connected) {
    const p = player(playerId);
    if (!p) return;
    p.connected = Boolean(connected);
    if (game.phase === "bidding" && allLocked()) resolve();
    else onChange();
  }

  function returnToLobby() {
    if (game.phase !== "results") return false;
    resetMatch();
    game.players = [];
    game.phase = "lobby";
    onChange();
    return true;
  }

  function destroy() {
    clearPhaseTimer();
    clearBotTimers();
  }

  Object.assign(game, { start, bid, setConnected, returnToLobby, destroy, reference, flipped, cardsRemaining, remainingMs });
  return game;
}

module.exports = { createGame, DEFAULT_CONFIG };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/game.test.js`
Expected: all PASS. If "all locked resolves early and the stale deadline is harmless" fails, check that `armTimer` compares `game.timer !== entry` and that `resolve` clears the phase timer before arming the reveal timer.

- [ ] **Step 6: Commit**

```bash
git add lib/game.js tests/helpers/clock.js tests/game.test.js
git commit -m "feat: auction state machine with guarded timers"
```

---

### Task 5: Per-recipient snapshot (`lib/snapshot.js`)

**Files:**
- Create: `lib/snapshot.js`
- Test: `tests/snapshot.test.js`

**Interfaces:**
- Consumes: a `room` shaped `{ code, seats: Map<id, seat>, game, hostId(): string | null }` where a seat is `{ id, name, isBot, connected }` (Task 6 supplies the real one), and `game` from Task 4.
- Produces `buildState(room, recipientId | null) → object`:
  ```
  { type: "state", room, phase, matchId, revealStep, remainingMs, hostId, you,
    players: [{ id, name, isBot, connected, score, locked?, hand? }],
    reference, flipped: string[], cardsRemaining, hiddenCount, auctionIndex,
    hand: string[] | null, myBid: { amount, locked } | null,
    history: [...game.history entries...], minPlayers, maxPlayers, handSize }
  ```
  - For `recipientId === null` (a visitor on the name screen) the message is only `{ type: "state", room, phase, you: null, playerCount, maxPlayers }`. Visitors never receive cards, bids, scores, or history; there are no spectators.
  - In the lobby, `players` comes from `room.seats` with `score: 0`. Otherwise from `game.players`.
  - `locked` is present only during bidding: `true` for a bot once it has bid, and for a human when they locked or are disconnected (the game treats a disconnected human as locked). `hand` on a player is present only in results.
  - `hand` (top level) is the recipient's hand, or `null` when the recipient has no seat or no match is running.
  - Never present: the deck, another player's hand before results, another player's current bid amount before reveal.

- [ ] **Step 1: Write the failing tests**

`tests/snapshot.test.js`:

```js
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
  const room = { code: "abcd", seats, game, hostId: () => "p1" };
  return { clock, game, room };
}

// Exact allowlists. Anything not listed here is a leak, whatever it is called.
const STATE_KEYS = ["type", "room", "phase", "matchId", "revealStep", "remainingMs", "hostId", "you", "players", "reference", "flipped", "cardsRemaining", "hiddenCount", "auctionIndex", "hand", "myBid", "history", "minPlayers", "maxPlayers", "handSize"].sort();
const VISITOR_KEYS = ["type", "room", "phase", "you", "playerCount", "maxPlayers"].sort();
const PLAYER_KEYS = ["id", "name", "isBot", "connected", "score"];
const HISTORY_KEYS = ["index", "reference", "bids", "buyers", "price", "void", "flipped", "matched", "deltas"].sort();

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

test("lobby snapshot lists seats and hides nothing sensitive", () => {
  const { room } = makeRoom();
  const s = buildState(room, "p1");
  assert.equal(s.type, "state");
  assert.equal(s.room, "abcd");
  assert.equal(s.phase, "lobby");
  assert.equal(s.hostId, "p1");
  assert.equal(s.you, "p1");
  assert.deepEqual(s.players.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.equal(s.players[2].isBot, true);
  assert.equal(s.hand, null);
  assert.equal(s.minPlayers, 2);
  assert.equal(s.maxPlayers, 6);
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
  clock.advance(20000);
  const visitor = buildState(room, null);
  assert.deepEqual(Object.keys(visitor).sort(), VISITOR_KEYS);
  assert.equal(visitor.phase, "reveal");
  assert.equal(visitor.playerCount, 3);
});

test("a disconnected human reads as locked, a bot only once it has bid", () => {
  const { room, game } = makeRoom();
  game.start([...room.seats.values()]);
  game.setConnected("p2", false);
  const s = buildState(room, "p1");
  assert.equal(s.players.find((p) => p.id === "p2").locked, true);
  assert.equal(s.players.find((p) => p.id === "p3").locked, false);
  assert.equal(s.players.find((p) => p.id === "p1").locked, false);
});

test("bidding snapshot shows own hand and bid, others' lock flags only", () => {
  const { room, game } = makeRoom();
  game.start([...room.seats.values()]);
  game.bid("p2", { auction: 1, amount: 33, locked: true });
  const s1 = buildState(room, "p1");
  assert.equal(s1.phase, "bidding");
  assert.equal(s1.auctionIndex, 1);
  assert.equal(s1.remainingMs, 20000);
  assert.equal(s1.hand.length, 6);
  assert.deepEqual(s1.hand, game.players[0].hand);
  assert.equal(s1.myBid, null);
  assert.equal(s1.players.find((p) => p.id === "p2").locked, true);
  assert.equal(s1.players.find((p) => p.id === "p1").locked, false);
  assert.equal(s1.flipped.length, 1);
  assert.equal(s1.reference, game.deck[0]);
  assert.equal(s1.cardsRemaining, 23);
  assert.equal(s1.hiddenCount, 6);
  assert.equal(s1.handSize, 6);
  assertShape(s1);
  const s2 = buildState(room, "p2");
  assert.deepEqual(s2.myBid, { amount: 33, locked: true });
  assert.deepEqual(s2.hand, game.players[1].hand);
});

test("a resumed recipient mid-bidding gets the same public record", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  for (const id of ["p1", "p2"]) game.bid(id, { auction: 1, amount: 20, locked: true });
  clock.advance(6000);
  clock.advance(2500 + 3000);
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
  clock.advance(20000);
  const s = buildState(room, "p1");
  assert.equal(s.phase, "reveal");
  assert.equal(s.revealStep, "bids");
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].flipped, null);
  assert.equal(s.myBid, null);
  assert.equal(s.remainingMs, 0);
  assertShape(s);
});

test("results snapshot reveals every hand", () => {
  const { room, game, clock } = makeRoom();
  game.start([...room.seats.values()]);
  while (game.phase !== "results") {
    if (game.phase === "bidding") for (const id of ["p1", "p2"]) game.bid(id, { auction: game.auction.index, amount: 20, locked: true });
    clock.advance(6000);
    clock.advance(5500);
  }
  const s = buildState(room, "p2");
  assert.equal(s.phase, "results");
  for (const p of s.players) assert.equal(p.hand.length, 6);
  assert.equal(s.history.length, 23);
  assertShape(s);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/snapshot.test.js`
Expected: FAIL with `Cannot find module '../lib/snapshot.js'`.

- [ ] **Step 3: Implement `lib/snapshot.js`**

```js
"use strict";
const { MIN_PLAYERS, MAX_PLAYERS, handSize } = require("../public/game-core.js");

// The only place server state is turned into a message. Everything a client
// sees goes through here, so this file is the secrecy boundary: no deck, no
// other hands before results, no other bid amounts before reveal.
function buildState(room, recipientId) {
  const game = room.game;
  const inMatch = game.phase !== "lobby";
  const bidding = game.phase === "bidding";

  // Visitors on the name screen learn only enough to decide whether to join.
  if (recipientId === null) {
    return {
      type: "state",
      room: room.code,
      phase: game.phase,
      you: null,
      playerCount: inMatch ? game.players.length : room.seats.size,
      maxPlayers: MAX_PLAYERS
    };
  }

  let players;
  if (inMatch) {
    players = game.players.map((p) => {
      const row = { id: p.id, name: p.name, isBot: p.isBot, connected: p.connected, score: p.score };
      if (bidding) {
        const b = game.auction.bids[p.id];
        row.locked = p.isBot ? Boolean(b) : (!p.connected || Boolean(b && b.locked));
      }
      if (game.phase === "results") row.hand = p.hand.slice();
      return row;
    });
  } else {
    players = [...room.seats.values()].map((s) => ({ id: s.id, name: s.name, isBot: s.isBot, connected: s.connected, score: 0 }));
  }

  const me = inMatch ? game.players.find((p) => p.id === recipientId) || null : null;
  const myBidRaw = me && bidding ? game.auction.bids[me.id] : null;
  const playerCount = inMatch ? game.players.length : room.seats.size;
  let size = null;
  try {
    size = handSize(playerCount);
  } catch {
    size = null;
  }

  return {
    type: "state",
    room: room.code,
    phase: game.phase,
    matchId: game.matchId,
    revealStep: game.revealStep,
    remainingMs: game.remainingMs(),
    hostId: room.hostId(),
    you: recipientId,
    players,
    reference: game.reference(),
    flipped: game.flipped(),
    cardsRemaining: game.cardsRemaining(),
    hiddenCount: game.hiddenCount,
    auctionIndex: game.auction ? game.auction.index : null,
    hand: me ? me.hand.slice() : null,
    myBid: myBidRaw ? { amount: myBidRaw.amount, locked: myBidRaw.locked } : null,
    history: game.history.map((h) => ({ ...h, bids: { ...h.bids }, buyers: h.buyers.slice(), deltas: h.deltas ? { ...h.deltas } : null })),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    handSize: size
  };
}

module.exports = { buildState };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/snapshot.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot.js tests/snapshot.test.js
git commit -m "feat: per-recipient state snapshot with secrecy tests"
```

---

### Task 6: Rooms, seats, tokens, expiry (`lib/rooms.js`)

**Files:**
- Create: `lib/rooms.js`
- Test: `tests/rooms.test.js`

**Interfaces:**
- Consumes: `MIN_PLAYERS`, `MAX_PLAYERS` from `public/game-core.js`; `pickBotName`, `botProfile` from `lib/bots.js`; a `createGame({ onChange })` factory supplied by the caller (Task 7 passes `({ onChange }) => createGame({ config, onChange })`).
- Produces `createRegistry({ now?, setTimeout?, clearTimeout?, resumeTtlMs?, randomInt?, createGame, onChange?(room), onDelete?(room) })` returning:
  - `rooms: Map<code, room>`
  - `room = { code, seats: Map<id, seat>, visitors: Set<ws>, nextSeatNo, botsAdded, deletionTimer, game, hostId() }`
  - `seat = { id, name, isBot, connected, resumeToken (null for bots), ws, disconnectedAt, expiryTimer, profile }`
  - `reserveCode() → string | null`, `isValidCode(code) → boolean`, `get(code)`, `getOrCreate(code)`
  - `join(room, { name, ws }) → { ok: true, seat } | { ok: false, error: "game_in_progress" | "room_full" }`
  - `resume(room, token, ws) → seat | null` (adopts unconditionally; closes the displaced socket with `4000`)
  - `disconnect(room, seat, ws) → boolean` (false if `ws` no longer owns the seat)
  - `leaveVisitor(room, ws)`
  - `addBot(room) → { ok, seat | error }`, `removeBot(room, id) → boolean`
  - `startGame(room) → { ok } | { ok: false, error: "not_lobby" | "need_players" }` (drops disconnected human seats first)
  - `returnToLobby(room) → boolean` (sweeps seats disconnected longer than the TTL, arms expiry for the rest)
  - `deleteRoom(room)`, `hostId(room)` (earliest connected human, else `null`), `SEAT_TAKEN_OVER_CODE = 4000`
  - Seat expiry timers run for disconnects in the lobby and results phases; disconnects during bidding or reveal are swept by `returnToLobby`. Every timer callback is wrapped in try/catch.

- [ ] **Step 1: Write the failing tests**

`tests/rooms.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry } = require("../lib/rooms.js");
const { createGame } = require("../lib/game.js");
const { createClock } = require("./helpers/clock.js");

const TTL = 10000;
const CONFIG = { bidMs: 20000, revealBidsMs: 2500, revealCardMs: 3000 };

function fakeWs() {
  return { closed: [], OPEN: 1, readyState: 1, close(code) { this.closed.push(code); } };
}

function setup() {
  const clock = createClock();
  const changes = [];
  const deleted = [];
  const registry = createRegistry({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, resumeTtlMs: TTL,
    randomInt: (n) => n - 1,
    createGame: ({ onChange }) => createGame({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomInt: (n) => n - 1, random: () => 0.5, config: CONFIG, onChange }),
    onChange: (room) => changes.push(room.code),
    onDelete: (room) => deleted.push(room.code)
  });
  return { clock, registry, changes, deleted };
}

test("reserveCode yields 4 lowercase letters and honours reservations", () => {
  const { clock, registry } = setup();
  const a = registry.reserveCode();
  assert.match(a, /^[a-z]{4}$/);
  // With randomInt = n-1 every draw is "zzzz", so the second call must fail while reserved.
  assert.equal(registry.reserveCode(), null);
  clock.advance(60001);
  assert.equal(registry.reserveCode(), a);
  registry.getOrCreate(a);
  assert.equal(registry.reserveCode(), null);
});

test("join creates a seat with a token; hostId is the earliest connected human", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const w2 = fakeWs();
  const a = registry.join(room, { name: "Ann", ws: w1 });
  const b = registry.join(room, { name: "Ben", ws: w2 });
  assert.equal(a.ok, true);
  assert.equal(a.seat.id, "p1");
  assert.match(a.seat.resumeToken, /^[0-9a-f]{32}$/);
  assert.equal(b.seat.id, "p2");
  assert.equal(room.hostId(), "p1");
  registry.disconnect(room, a.seat, w1);
  assert.equal(room.hostId(), "p2");
  registry.disconnect(room, b.seat, w2);
  assert.equal(room.hostId(), null, "no connected human means no host");
});

test("join is refused when full or when a game is running", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  for (let i = 0; i < 6; i++) assert.equal(registry.join(room, { name: `P${i}`, ws: fakeWs() }).ok, true);
  assert.deepEqual(registry.join(room, { name: "Extra", ws: fakeWs() }), { ok: false, error: "room_full" });
  const room2 = registry.getOrCreate("wxyz");
  registry.join(room2, { name: "A", ws: fakeWs() });
  registry.join(room2, { name: "B", ws: fakeWs() });
  assert.equal(registry.startGame(room2).ok, true);
  assert.deepEqual(registry.join(room2, { name: "C", ws: fakeWs() }), { ok: false, error: "game_in_progress" });
});

test("bots get unique names, cycling profiles, and only in the lobby", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  registry.join(room, { name: "Ann", ws: fakeWs() });
  const names = new Set();
  const keys = [];
  for (let i = 0; i < 5; i++) {
    const r = registry.addBot(room);
    assert.equal(r.ok, true);
    names.add(r.seat.name);
    keys.push(r.seat.profile.key);
    assert.equal(r.seat.isBot, true);
    assert.equal(r.seat.resumeToken, null);
  }
  assert.equal(names.size, 5);
  assert.deepEqual(keys, ["careful", "fair", "keen", "wild", "careful"]);
  assert.deepEqual(registry.addBot(room), { ok: false, error: "room_full" });
  assert.equal(registry.removeBot(room, "p2"), true);
  assert.equal(room.seats.size, 5);
  assert.equal(registry.removeBot(room, "p1"), false, "cannot remove a human");
  registry.startGame(room);
  assert.equal(registry.addBot(room).ok, false);
  assert.equal(registry.removeBot(room, "p3"), false);
});

test("resume adopts the seat and displaces the old socket with 4000", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  const old = fakeWs();
  const { seat } = registry.join(room, { name: "Ann", ws: old });
  const fresh = fakeWs();
  const adopted = registry.resume(room, seat.resumeToken, fresh);
  assert.equal(adopted, seat);
  assert.equal(seat.ws, fresh);
  assert.equal(seat.connected, true);
  assert.deepEqual(old.closed, [4000]);
  assert.equal(registry.disconnect(room, seat, old), false, "stale socket cannot disconnect the seat");
  assert.equal(seat.connected, true);
  assert.equal(registry.resume(room, "nope", fakeWs()), null);
});

test("a seat that disconnects in the lobby expires after the TTL unless it resumes", () => {
  const { clock, registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const { seat: a } = registry.join(room, { name: "Ann", ws: w1 });
  registry.join(room, { name: "Ben", ws: fakeWs() });
  registry.disconnect(room, a, w1);
  clock.advance(TTL - 1);
  assert.equal(room.seats.has("p1"), true);
  registry.resume(room, a.resumeToken, fakeWs());
  clock.advance(TTL);
  assert.equal(room.seats.has("p1"), true, "resume cancelled expiry");
  registry.disconnect(room, a, a.ws);
  clock.advance(TTL);
  assert.equal(room.seats.has("p1"), false);
});

test("mid-game a disconnected seat is kept past the TTL (roster freeze)", () => {
  const { clock, registry } = setup();
  const room = registry.getOrCreate("abcd");
  registry.join(room, { name: "Ann", ws: fakeWs() });
  const w2 = fakeWs();
  const { seat: b } = registry.join(room, { name: "Ben", ws: w2 });
  registry.startGame(room);
  registry.disconnect(room, b, w2);
  clock.advance(TTL * 3);
  assert.equal(room.seats.has("p2"), true);
  assert.equal(room.game.players.find((p) => p.id === "p2").connected, false);
  assert.equal(registry.get("abcd"), room, "room survives while one human is connected");
});

test("a room with no connected human for the TTL is deleted, in any phase", () => {
  const { clock, registry, deleted } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const w2 = fakeWs();
  const { seat: a } = registry.join(room, { name: "Ann", ws: w1 });
  const { seat: b } = registry.join(room, { name: "Ben", ws: w2 });
  registry.addBot(room);
  registry.startGame(room);
  registry.disconnect(room, a, w1);
  registry.disconnect(room, b, w2);
  clock.advance(TTL);
  assert.equal(registry.get("abcd"), null);
  assert.deepEqual(deleted, ["abcd"]);
  assert.equal(clock.pending(), 0, "game and room timers cleared");
});

test("reconnecting before the TTL cancels room deletion", () => {
  const { clock, registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const { seat: a } = registry.join(room, { name: "Ann", ws: w1 });
  registry.disconnect(room, a, w1);
  clock.advance(TTL - 1);
  registry.resume(room, a.resumeToken, fakeWs());
  clock.advance(TTL);
  assert.equal(registry.get("abcd"), room);
});

test("startGame drops disconnected seats and needs two players", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const w2 = fakeWs();
  registry.join(room, { name: "Ann", ws: w1 });
  const { seat: b } = registry.join(room, { name: "Ben", ws: w2 });
  registry.disconnect(room, b, w2);
  assert.deepEqual(registry.startGame(room), { ok: false, error: "need_players" });
  assert.equal(room.seats.has("p2"), false);
  registry.addBot(room);
  assert.equal(registry.startGame(room).ok, true);
  assert.equal(room.game.players.length, 2);
  assert.equal(registry.resume(room, b.resumeToken, fakeWs()), null, "dropped seat's token is dead");
});

test("returnToLobby sweeps long-disconnected seats and arms expiry for the rest", () => {
  const { clock, registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const w2 = fakeWs();
  const w3 = fakeWs();
  registry.join(room, { name: "Ann", ws: w1 });
  const { seat: b } = registry.join(room, { name: "Ben", ws: w2 });
  const { seat: c } = registry.join(room, { name: "Cat", ws: w3 });
  registry.startGame(room);
  registry.disconnect(room, b, w2);
  // Play the whole game with only Ann bidding. Each auction runs to its 20 s
  // deadline because Cat never locks, so Ben ends up gone far longer than TTL.
  while (room.game.phase !== "results") {
    if (room.game.phase === "bidding") room.game.bid("p1", { auction: room.game.auction.index, amount: 10, locked: true });
    clock.advance(20000);
    clock.advance(5500);
  }
  // Cat drops on the results screen, moments before the host returns to the lobby.
  registry.disconnect(room, c, w3);
  assert.equal(room.seats.size, 3);
  assert.equal(registry.returnToLobby(room), true);
  assert.equal(room.game.phase, "lobby");
  assert.equal(room.seats.has("p2"), false, "Ben was gone longer than the TTL");
  assert.equal(room.seats.has("p3"), true, "Cat left recently");
  clock.advance(TTL);
  assert.equal(room.seats.has("p3"), false);
});

test("a seat that disconnects on the results screen expires after the TTL; standings stay intact", () => {
  const { clock, registry } = setup();
  const room = registry.getOrCreate("abcd");
  const w1 = fakeWs();
  const w2 = fakeWs();
  registry.join(room, { name: "Ann", ws: w1 });
  const { seat: b } = registry.join(room, { name: "Ben", ws: w2 });
  registry.startGame(room);
  while (room.game.phase !== "results") {
    if (room.game.phase === "bidding") {
      room.game.bid("p1", { auction: room.game.auction.index, amount: 10, locked: true });
      room.game.bid("p2", { auction: room.game.auction.index, amount: 5, locked: true });
    }
    clock.advance(5500);
  }
  registry.disconnect(room, b, w2);
  clock.advance(TTL);
  assert.equal(room.seats.has("p2"), false);
  assert.equal(registry.resume(room, b.resumeToken, fakeWs()), null, "expired token is dead");
  assert.equal(room.game.phase, "results");
  assert.equal(room.game.players.length, 2, "standings keep the departed player");
});

test("a visitor-only room is deleted when its last visitor leaves", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  const ws = fakeWs();
  room.visitors.add(ws);
  registry.leaveVisitor(room, ws);
  assert.equal(registry.get("abcd"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/rooms.test.js`
Expected: FAIL with `Cannot find module '../lib/rooms.js'`.

- [ ] **Step 3: Implement `lib/rooms.js`**

```js
"use strict";
const crypto = require("node:crypto");
const { MIN_PLAYERS, MAX_PLAYERS } = require("../public/game-core.js");
const { pickBotName, botProfile } = require("./bots.js");

const CODE_RESERVATION_MS = 60000;
// Application close code for "another connection took this seat". The client
// must not auto-reconnect on it or two tabs trade the seat forever.
const SEAT_TAKEN_OVER_CODE = 4000;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function createRegistry(deps) {
  const now = deps.now || (() => Date.now());
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const resumeTtlMs = deps.resumeTtlMs || 600000;
  const randomInt = deps.randomInt || ((n) => crypto.randomInt(n));
  const createGame = deps.createGame;
  const onChange = deps.onChange || (() => {});
  const onDelete = deps.onDelete || (() => {});
  const rooms = new Map();
  const reservations = new Map();

  function randomCode() {
    let code = "";
    for (let i = 0; i < 4; i++) code += LETTERS[randomInt(26)];
    return code;
  }

  function isValidCode(code) {
    return /^[a-z]{4}$/.test(code);
  }

  function reserveCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = randomCode();
      if (rooms.has(code)) continue;
      const until = reservations.get(code);
      if (until && until > now()) continue;
      reservations.set(code, now() + CODE_RESERVATION_MS);
      return code;
    }
    return null;
  }

  function get(code) {
    return rooms.get(code) || null;
  }

  function humans(room) {
    return [...room.seats.values()].filter((s) => !s.isBot);
  }

  // The earliest-joined connected human. With nobody connected there is no
  // host; nobody could act on the role anyway.
  function hostId(room) {
    const connected = humans(room).find((s) => s.connected);
    return connected ? connected.id : null;
  }

  function getOrCreate(code) {
    let room = rooms.get(code);
    if (room) return room;
    room = { code, seats: new Map(), visitors: new Set(), nextSeatNo: 1, botsAdded: 0, deletionTimer: null, game: null };
    room.hostId = () => hostId(room);
    room.game = createGame({ onChange: () => onChange(room) });
    rooms.set(code, room);
    reservations.delete(code);
    return room;
  }

  function phase(room) {
    return room.game.phase;
  }

  function newSeatId(room) {
    const id = `p${room.nextSeatNo}`;
    room.nextSeatNo += 1;
    return id;
  }

  function cancelSeatExpiry(seat) {
    if (seat.expiryTimer) {
      clearT(seat.expiryTimer);
      seat.expiryTimer = null;
    }
  }

  function guarded(label, fn) {
    return () => {
      try {
        fn();
      } catch (err) {
        console.error(`[rooms] ${label} failed:`, err);
      }
    };
  }

  function expiryAllowed(room) {
    const p = phase(room);
    return p === "lobby" || p === "results";
  }

  // Lobby and results only: a disconnected seat is dropped after `ms`. If a
  // game is running by then the roster is frozen and the timer does nothing;
  // returnToLobby sweeps such seats instead.
  function scheduleSeatExpiry(room, seat, ms) {
    cancelSeatExpiry(seat);
    seat.expiryTimer = setT(guarded("seat expiry", () => {
      seat.expiryTimer = null;
      if (seat.connected || !room.seats.has(seat.id)) return;
      if (!expiryAllowed(room)) return;
      room.seats.delete(seat.id);
      onChange(room);
    }), ms);
  }

  function cancelDeletion(room) {
    if (room.deletionTimer) {
      clearT(room.deletionTimer);
      room.deletionTimer = null;
    }
  }

  function scheduleDeletion(room) {
    cancelDeletion(room);
    room.deletionTimer = setT(guarded("room deletion", () => {
      room.deletionTimer = null;
      if (humans(room).some((s) => s.connected)) return;
      deleteRoom(room);
    }), resumeTtlMs);
  }

  function deleteRoom(room) {
    cancelDeletion(room);
    for (const seat of room.seats.values()) cancelSeatExpiry(seat);
    room.game.destroy();
    rooms.delete(room.code);
    onDelete(room);
  }

  function join(room, { name, ws }) {
    if (phase(room) !== "lobby") return { ok: false, error: "game_in_progress" };
    if (room.seats.size >= MAX_PLAYERS) return { ok: false, error: "room_full" };
    const seat = {
      id: newSeatId(room),
      name,
      isBot: false,
      connected: true,
      resumeToken: crypto.randomBytes(16).toString("hex"),
      ws,
      disconnectedAt: 0,
      expiryTimer: null,
      profile: null
    };
    room.seats.set(seat.id, seat);
    room.visitors.delete(ws);
    cancelDeletion(room);
    return { ok: true, seat };
  }

  function findByToken(room, token) {
    if (!token) return null;
    for (const seat of room.seats.values()) {
      if (!seat.isBot && seat.resumeToken === token) return seat;
    }
    return null;
  }

  // The token is the identity: the newest socket presenting it owns the seat.
  // Never gate on `connected` -- a navigated-away tab's close event routinely
  // lands after its replacement has already asked to resume.
  function resume(room, token, ws) {
    const seat = findByToken(room, token);
    if (!seat) return null;
    const previous = seat.ws;
    seat.ws = ws;
    seat.connected = true;
    seat.disconnectedAt = 0;
    cancelSeatExpiry(seat);
    room.visitors.delete(ws);
    cancelDeletion(room);
    room.game.setConnected(seat.id, true);
    if (previous && previous !== ws) {
      try {
        previous.close(SEAT_TAKEN_OVER_CODE, "seat_taken_over");
      } catch {
        // already gone, which is the common case
      }
    }
    return seat;
  }

  function disconnect(room, seat, ws) {
    if (seat.ws !== ws) return false;
    seat.ws = null;
    seat.connected = false;
    seat.disconnectedAt = now();
    room.game.setConnected(seat.id, false);
    if (expiryAllowed(room)) scheduleSeatExpiry(room, seat, resumeTtlMs);
    if (!humans(room).some((s) => s.connected)) scheduleDeletion(room);
    return true;
  }

  function leaveVisitor(room, ws) {
    room.visitors.delete(ws);
    if (room.seats.size === 0 && room.visitors.size === 0 && rooms.get(room.code) === room) deleteRoom(room);
  }

  function addBot(room) {
    if (phase(room) !== "lobby") return { ok: false, error: "not_lobby" };
    if (room.seats.size >= MAX_PLAYERS) return { ok: false, error: "room_full" };
    const taken = [...room.seats.values()].map((s) => s.name);
    const name = pickBotName(taken);
    if (!name) return { ok: false, error: "no_bot_names" };
    const seat = {
      id: newSeatId(room),
      name,
      isBot: true,
      connected: true,
      resumeToken: null,
      ws: null,
      disconnectedAt: 0,
      expiryTimer: null,
      profile: botProfile(room.botsAdded)
    };
    room.botsAdded += 1;
    room.seats.set(seat.id, seat);
    return { ok: true, seat };
  }

  function removeBot(room, id) {
    const seat = room.seats.get(id);
    if (!seat || !seat.isBot || phase(room) !== "lobby") return false;
    room.seats.delete(id);
    return true;
  }

  function startGame(room) {
    if (phase(room) !== "lobby") return { ok: false, error: "not_lobby" };
    for (const seat of humans(room)) {
      if (seat.connected) continue;
      cancelSeatExpiry(seat);
      room.seats.delete(seat.id);
    }
    const seats = [...room.seats.values()];
    if (seats.length < MIN_PLAYERS) return { ok: false, error: "need_players" };
    room.game.start(seats.map((s) => ({ id: s.id, name: s.name, isBot: s.isBot, connected: s.connected, profile: s.profile })));
    return { ok: true };
  }

  function returnToLobby(room) {
    if (!room.game.returnToLobby()) return false;
    for (const seat of humans(room)) {
      if (seat.connected) continue;
      const elapsed = now() - seat.disconnectedAt;
      if (elapsed >= resumeTtlMs) {
        cancelSeatExpiry(seat);
        room.seats.delete(seat.id);
      } else {
        scheduleSeatExpiry(room, seat, resumeTtlMs - elapsed);
      }
    }
    return true;
  }

  return {
    rooms, reserveCode, isValidCode, get, getOrCreate, join, resume, disconnect, leaveVisitor,
    addBot, removeBot, startGame, returnToLobby, deleteRoom, hostId, SEAT_TAKEN_OVER_CODE
  };
}

module.exports = { createRegistry, SEAT_TAKEN_OVER_CODE, CODE_RESERVATION_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rooms.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rooms.js tests/rooms.test.js
git commit -m "feat: room registry with seats, resume tokens, expiry, deletion"
```

---

### Task 7: HTTP + WebSocket server (`server.js`)

**Files:**
- Create: `server.js`, a placeholder `public/index.html` (replaced in Task 8), a placeholder `public/how-to-play.html` (replaced in Task 10)
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `createGame` (Task 4), `createRegistry` (Task 6), `buildState` (Task 5).
- Produces the wire protocol from spec section 4.5. WebSocket endpoint: `ws://host/ws?room=abcd` (the room comes from the socket URL, never from a message). `/api/new-room` answers `{ ok: true, room }`. Human names equal to a bot name are refused. Messages in: `join {name, resumeToken?}`, `resume {resumeToken}`, `add-bot`, `remove-bot {playerId}`, `start-game`, `bid {auction, amount, locked}`, `return-to-lobby`. Messages out: `state` (from `buildState`), `joined {playerId, resumeToken}`, `error {message, code?}`.
- Startup log line contains `running at` (the test waits for it).

- [ ] **Step 1: Create the placeholder pages**

`public/index.html` (temporary, Task 8 replaces it):

```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Follow Suit</title></head>
<body><p>Follow Suit app shell placeholder.</p></body></html>
```

`public/how-to-play.html` (temporary, Task 10 replaces it):

```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>How to play Follow Suit</title></head>
<body><p>Rules placeholder.</p></body></html>
```

- [ ] **Step 2: Write the failing integration test**

`tests/server.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");

// The only tests that run the real server. Seat takeover is a race between two
// live sockets and only exists once real connections are involved.

const PORT = 34571;
const TTL_MS = 400;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;

let child;
let roomCounter = 0;
// Four lowercase letters, unique per call, so tests never share a room.
function uniqueRoom() {
  roomCounter += 1;
  let n = roomCounter;
  let code = "";
  for (let i = 0; i < 4; i++) {
    code = "abcdefghijklmnopqrstuvwxyz"[n % 26] + code;
    n = Math.floor(n / 26);
  }
  return code;
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // BID_MS 4000 keeps bot bids inside 1.5 to 2 s, so every wait below has
    // room to spare, and a deadline passes quickly when a test needs one.
    env: { ...process.env, PORT: String(PORT), RESUME_TTL_MS: String(TTL_MS), BID_MS: "4000", REVEAL_BIDS_MS: "50", REVEAL_CARD_MS: "50" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (b) => process.stderr.write(b));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000);
    child.stdout.on("data", (buf) => {
      if (buf.toString().includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
});

test.after(async () => {
  if (!child) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(BASE + url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

function connect(room) {
  const ws = new WebSocket(`${WS_BASE}?room=${room}`);
  const messages = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8"));
    messages.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  const client = {
    ws,
    messages,
    open: () => new Promise((resolve) => ws.once("open", resolve)),
    send: (obj) => ws.send(JSON.stringify(obj)),
    lastState: () => [...messages].reverse().find((m) => m.type === "state"),
    // Waits for a message satisfying `pred`. Pass `from` (a messages.length
    // captured before the action) so an older message cannot satisfy it.
    until(pred, label, from = 0) {
      const found = [...messages.slice(from)].reverse().find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 8000);
        const check = (msg) => {
          if (!pred(msg)) {
            waiters.push(check);
            return;
          }
          clearTimeout(timer);
          resolve(msg);
        };
        waiters.push(check);
      });
    },
    closed: () => new Promise((resolve) => ws.once("close", (code) => resolve(code)))
  };
  return client;
}

async function join(room, name, token) {
  const c = connect(room);
  await c.open();
  c.send({ type: "join", name, resumeToken: token });
  const joined = await c.until((m) => m.type === "joined", `${name} joined`);
  c.playerId = joined.playerId;
  c.token = joined.resumeToken;
  await c.until((m) => m.type === "state" && m.you === joined.playerId, `${name} seated state`);
  return c;
}

test("routes: shell, new-room, how-to-play, html redirect, json 404", async () => {
  assert.equal((await getJson("/")).status, 200);
  assert.equal((await getJson("/abcd")).status, 200);
  const nr = await getJson("/api/new-room");
  assert.equal(nr.status, 200);
  assert.match(JSON.parse(nr.body).room, /^[a-z]{4}$/);
  assert.equal((await getJson("/how-to-play")).status, 200);
  const page = await getJson("/no-such-page", { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "/");
  const asset = await getJson("/no-such.png", { Accept: "image/avif,image/webp,*/*" });
  assert.equal(asset.status, 404);
  assert.equal(JSON.parse(asset.body).error, "not_found");
  const api = await getJson("/api/nothing", { Accept: "application/json" });
  assert.equal(api.status, 404);
});

test("a human cannot take a bot's name", async () => {
  const room = uniqueRoom();
  const c = connect(room);
  await c.open();
  c.send({ type: "join", name: "Bot Ada" });
  const err = await c.until((m) => m.type === "error", "reserved name");
  assert.match(err.message, /reserved/i);
  c.ws.close();
});

test("join seats a player, returns a token, and makes them host", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const s = a.lastState();
  assert.equal(s.hostId, a.playerId);
  assert.equal(s.players.length, 1);
  assert.match(a.token, /^[0-9a-f]{32}$/);
  a.ws.close();
});

test("host passes to the next connected human", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.ws.close();
  const s = await b.until((m) => m.type === "state" && m.hostId === b.playerId, "host handoff");
  assert.equal(s.players.find((p) => p.id === a.playerId).connected, false);
  b.ws.close();
});

test("join is refused while a game is running", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  const c = connect(room);
  await c.open();
  c.send({ type: "join", name: "Cat" });
  const err = await c.until((m) => m.type === "error", "refusal");
  assert.match(err.message, /Game in progress/);
  assert.equal(c.lastState().you, null);
  for (const x of [a, b, c]) x.ws.close();
});

test("resume with the old socket left open takes the seat and closes the old one with 4000", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  const oldClosed = a.closed();
  const a2 = connect(room);
  await a2.open();
  a2.send({ type: "resume", resumeToken: a.token });
  const joined = await a2.until((m) => m.type === "joined", "resumed");
  assert.equal(joined.playerId, a.playerId);
  assert.equal(await oldClosed, 4000);
  const s = await a2.until((m) => m.type === "state" && m.you === a.playerId, "resumed state");
  assert.equal(s.players.filter((p) => !p.isBot).length, 2);
  assert.equal(s.players.find((p) => p.id === a.playerId).connected, true);
  a2.ws.close();
  b.ws.close();
});

test("a seat that disconnects in the lobby expires after the TTL", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  const before = a.messages.length;
  b.ws.close();
  const s = await a.until((m) => m.type === "state" && m.players.length === 1, "seat expired", before);
  assert.equal(s.players[0].id, a.playerId);
  a.ws.close();
});

test("a seat that disconnects mid-game is kept past the TTL and across an auction boundary", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  b.ws.close();
  await sleep(TTL_MS * 2);
  a.send({ type: "bid", auction: 1, amount: 5, locked: false });
  const mid = await a.until((m) => m.type === "state" && m.myBid && m.myBid.amount === 5, "state after bid");
  assert.equal(mid.players.length, 2);
  assert.equal(mid.players.find((p) => p.id === b.playerId).connected, false);
  // The 4 s deadline passes with Ben away; auction 2 must still list him.
  const next = await a.until((m) => m.type === "state" && m.phase === "bidding" && m.auctionIndex === 2, "auction 2");
  assert.equal(next.players.length, 2);
  assert.equal(next.history[0].bids[b.playerId], 0);
  a.ws.close();
});

test("a room with no connected human for the TTL is deleted", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  a.ws.close();
  b.ws.close();
  await sleep(TTL_MS * 3);
  const c = connect(room);
  await c.open();
  const s = await c.until((m) => m.type === "state", "fresh room state");
  assert.equal(s.phase, "lobby");
  assert.equal(s.players.length, 0);
  c.ws.close();
});

test("bidding round-trips: locked bids resolve, reveal, then auction 2", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "add-bot" });
  await a.until((m) => m.type === "state" && m.players.length === 3, "bot added");
  a.send({ type: "start-game" });
  const start = await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  assert.equal(start.hand.length, 6);
  assert.equal(start.cardsRemaining, 23);
  a.send({ type: "bid", auction: 1, amount: 40, locked: true });
  b.send({ type: "bid", auction: 1, amount: 10, locked: true });
  const reveal = await a.until((m) => m.type === "state" && m.phase === "reveal", "reveal");
  assert.equal(reveal.history[0].bids[a.playerId], 40);
  assert.equal(reveal.history[0].bids[b.playerId], 10);
  const next = await a.until((m) => m.type === "state" && m.phase === "bidding" && m.auctionIndex === 2, "auction 2");
  assert.equal(next.history.length, 1);
  assert.ok(next.history[0].flipped);
  assert.equal(next.flipped.length, 2);
  const scoreSum = next.players.reduce((acc, p) => acc + p.score, 0);
  assert.equal(scoreSum, 0);
  a.ws.close();
  b.ws.close();
});

test("non-host actions are refused with an error", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  b.send({ type: "start-game" });
  const err = await b.until((m) => m.type === "error", "host refusal");
  assert.match(err.message, /host/i);
  assert.equal(b.lastState().phase, "lobby");
  a.ws.close();
  b.ws.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/server.test.js`
Expected: FAIL with "server did not start" or `Cannot find module`.

- [ ] **Step 4: Implement `server.js`**

```js
"use strict";
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const { createGame } = require("./lib/game.js");
const { createRegistry } = require("./lib/rooms.js");
const { buildState } = require("./lib/snapshot.js");
const { BOT_NAMES } = require("./lib/bots.js");

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PORT = envInt("PORT", 3000);
const CONFIG = {
  bidMs: envInt("BID_MS", 20000),
  revealBidsMs: envInt("REVEAL_BIDS_MS", 2500),
  revealCardMs: envInt("REVEAL_CARD_MS", 3000)
};
const RESUME_TTL_MS = envInt("RESUME_TTL_MS", 10 * 60 * 1000);

// Crash resistance: one bad socket message must not take every room down.
// Each message and timer is also wrapped individually (see below), so this is
// the last line, not the first.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException (continuing):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection (continuing):", reason);
});

const registry = createRegistry({
  resumeTtlMs: RESUME_TTL_MS,
  createGame: ({ onChange }) => createGame({ config: CONFIG, onChange }),
  onChange: broadcast
});

function send(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error("[server] send failed:", err);
  }
}

function broadcast(room) {
  for (const seat of room.seats.values()) {
    if (seat.ws) send(seat.ws, buildState(room, seat.id));
  }
  for (const ws of room.visitors) send(ws, buildState(room, null));
}

function normalizeName(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function isReservedName(name) {
  const lower = name.toLowerCase();
  return BOT_NAMES.some((botName) => botName.toLowerCase() === lower);
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/api/new-room", (_req, res) => {
  const room = registry.reserveCode();
  res.set("Cache-Control", "no-store");
  if (!room) {
    res.status(503).json({ ok: false, error: "no_room_available" });
    return;
  }
  res.json({ ok: true, room });
});

app.get("/how-to-play", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "how-to-play.html"));
});

app.get(/^\/[a-z]{4}$/, (_req, res) => res.type("html").send(INDEX_HTML));

// Unknown browser navigations go home; everything else (assets, API, fetches
// that accept */*) gets the JSON 404 below. Checking the Accept header for
// text/html directly avoids req.accepts() preferring "html" for */*.
app.use((req, res, next) => {
  const wantsHtml = /text\/html/i.test(req.headers.accept || "");
  if (req.method === "GET" && wantsHtml && !req.path.startsWith("/api/")) {
    res.redirect(302, "/");
    return;
  }
  next();
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const code = String(url.searchParams.get("room") || "").toLowerCase();
  if (!registry.isValidCode(code)) {
    ws.close(1008, "room_required");
    return;
  }
  const room = registry.getOrCreate(code);
  room.visitors.add(ws);
  let seat = null;
  send(ws, buildState(room, null));

  function joinedMessage() {
    send(ws, { type: "joined", playerId: seat.id, resumeToken: seat.resumeToken });
  }

  function requireHost() {
    if (seat && room.hostId() === seat.id) return true;
    send(ws, { type: "error", message: "Only the host can do that." });
    return false;
  }

  function handle(msg) {
    switch (msg.type) {
      case "resume": {
        if (seat) return;
        const existing = registry.resume(room, String(msg.resumeToken || ""), ws);
        if (existing) {
          seat = existing;
          joinedMessage();
        } else if (room.game.phase !== "lobby") {
          send(ws, { type: "error", code: "game_in_progress", message: "Game in progress, try again after this game." });
        }
        return;
      }
      case "join": {
        if (seat) return;
        const existing = registry.resume(room, String(msg.resumeToken || ""), ws);
        if (existing) {
          seat = existing;
          joinedMessage();
          return;
        }
        const name = normalizeName(msg.name);
        if (!name) {
          send(ws, { type: "error", message: "Please enter a name." });
          return;
        }
        if (isReservedName(name)) {
          send(ws, { type: "error", message: "That name is reserved for bots." });
          return;
        }
        const result = registry.join(room, { name, ws });
        if (!result.ok) {
          const message = result.error === "game_in_progress" ? "Game in progress, try again after this game." : "That room is full.";
          send(ws, { type: "error", code: result.error, message });
          return;
        }
        seat = result.seat;
        joinedMessage();
        return;
      }
      case "add-bot": {
        if (!requireHost()) return;
        const result = registry.addBot(room);
        if (!result.ok) send(ws, { type: "error", message: result.error === "room_full" ? "The room is full." : "Bots can only be added in the lobby." });
        return;
      }
      case "remove-bot": {
        if (!requireHost()) return;
        if (!registry.removeBot(room, String(msg.playerId || ""))) send(ws, { type: "error", message: "Bots can only be removed in the lobby." });
        return;
      }
      case "start-game": {
        if (!requireHost()) return;
        const result = registry.startGame(room);
        if (!result.ok) send(ws, { type: "error", message: result.error === "need_players" ? "Need at least two players." : "The game has already started." });
        return;
      }
      case "bid": {
        if (!seat) return;
        // Stale or out-of-phase bids are ignored on purpose (spec 4.4): a
        // debounced bid that lands after the deadline is not a user error.
        const result = room.game.bid(seat.id, { auction: Number(msg.auction), amount: Number(msg.amount), locked: Boolean(msg.locked) });
        if (!result.ok && result.error === "bad_amount") send(ws, { type: "error", message: "Bids are whole numbers from 0 to 100." });
        return;
      }
      case "return-to-lobby": {
        if (!requireHost()) return;
        if (!registry.returnToLobby(room)) send(ws, { type: "error", message: "Play again is only available on the results screen." });
        return;
      }
      default:
        return;
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    // A displaced socket must not act on a seat it no longer owns.
    if (seat && seat.ws !== ws) return;
    try {
      handle(msg);
    } catch (err) {
      console.error(`[server] room ${room.code} message ${msg.type} failed:`, err);
    }
    if (registry.get(room.code) === room) broadcast(room);
  });

  ws.on("close", () => {
    try {
      if (seat) {
        if (seat.ws !== ws) return;
        registry.disconnect(room, seat, ws);
        if (registry.get(room.code) === room) broadcast(room);
      } else {
        registry.leaveVisitor(room, ws);
      }
    } catch (err) {
      console.error("[server] close handler failed:", err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Follow Suit server running at http://localhost:${PORT}`);
});
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every file PASS, including `tests/server.test.js`. If the server test hangs, check the startup log contains `running at` and that `PORT` is respected.

- [ ] **Step 6: Commit**

```bash
git add server.js public/index.html public/how-to-play.html tests/server.test.js
git commit -m "feat: HTTP routes and WebSocket server with integration tests"
```

---

### Task 8: App shell and client logic (`public/index.html`, `public/client.js`)

**Files:**
- Replace: `public/index.html` (placeholder from Task 7)
- Create: `public/client.js`

**Interfaces:**
- Consumes: `window.GameCore` (`SUITS`, `SUIT_SYMBOLS`, `countSuits`, `rank`) from `public/game-core.js`; the wire protocol from Task 7 (`/ws?room=abcd`, `join`, `resume`, `add-bot`, `remove-bot`, `start-game`, `bid`, `return-to-lobby`; `state`, `joined`, `error`).
- Produces: every element id listed in the HTML below is referenced by `client.js`; Task 9 styles them by class and id and must not rename any.

There are no unit tests for the client (no DOM test harness in this repo, by design). Verification is a syntax check now and the Chrome pass in Task 11.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#0f1b17">
  <title>Follow Suit</title>
  <meta name="description" content="Follow Suit: a multiplayer card auction that teaches the winner's curse. Bid on whether the next card follows suit; win the auction and everyone else takes the other side.">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">Follow Suit</a>
    <span id="roomBadge" class="room-badge" hidden></span>
    <span id="connBadge" class="conn-badge" hidden>Reconnecting&hellip;</span>
  </header>

  <main id="app">
    <section id="nameView" class="view" hidden>
      <h1>Follow Suit</h1>
      <p class="tagline">Bid on whether the next card follows suit. Win the auction and everyone else takes the other side of your trade.</p>
      <form id="nameForm" class="stack">
        <label for="nameInput">Your name</label>
        <input id="nameInput" maxlength="16" autocomplete="nickname" required>
        <div id="landingActions" class="stack">
          <button type="button" id="createBtn" class="primary">Create a room</button>
          <div class="join-row">
            <input id="codeInput" placeholder="room code" maxlength="4" autocapitalize="none" autocomplete="off" spellcheck="false">
            <button type="button" id="joinCodeBtn">Join</button>
          </div>
        </div>
        <div id="roomActions" class="stack" hidden>
          <p id="roomPreview" class="muted"></p>
          <button type="submit" class="primary">Join room <span id="joinRoomCode"></span></button>
        </div>
      </form>
      <p class="muted"><a href="/how-to-play">How to play</a></p>
    </section>

    <section id="lobbyView" class="view" hidden>
      <h2>Lobby</h2>
      <p id="lobbyCount" class="muted"></p>
      <ul id="lobbyPlayers" class="player-list"></ul>
      <div class="link-row">
        <input id="roomLink" readonly>
        <button type="button" id="copyLinkBtn">Copy link</button>
      </div>
      <p id="lobbyHandInfo" class="muted"></p>
      <div id="hostControls" class="row" hidden>
        <button type="button" id="addBotBtn">Add bot</button>
        <button type="button" id="startBtn" class="primary">Start</button>
      </div>
      <p id="guestNote" class="muted" hidden>Waiting for the host to start.</p>
      <p class="rules-blurb">Each auction: everyone bids 0 to 100 for the right to be paid 100 per opponent if the next card matches the suit showing. The highest bid wins and pays that price to every other player. Ties all buy. <a href="/how-to-play">Full rules</a>.</p>
    </section>

    <section id="gameView" class="view" hidden>
      <div class="table-top">
        <div id="refCard" class="ref-card"></div>
        <div class="table-info">
          <p id="refLabel" class="ref-label"></p>
          <p id="deckInfo" class="muted"></p>
          <div id="flipCounts" class="flip-counts"></div>
        </div>
      </div>
      <div id="flipStrip" class="flip-strip"></div>

      <h3 class="section-title">Your hand</h3>
      <div id="hand" class="hand"></div>

      <div class="auction-head">
        <span id="auctionLabel" class="auction-label"></span>
        <span id="timer" class="timer"></span>
      </div>

      <div id="bidPanel" class="panel" hidden>
        <div class="bid-controls">
          <input id="bidRange" type="range" min="0" max="100" step="1" value="0">
          <input id="bidInput" type="number" min="0" max="100" step="1" value="0" inputmode="numeric">
          <button type="button" id="lockBtn" class="primary">Lock in bid</button>
        </div>
        <p id="bidHint" class="muted"></p>
      </div>

      <div id="revealPanel" class="panel" hidden>
        <p id="revealSummary" class="reveal-summary"></p>
        <ul id="revealBids" class="bid-list"></ul>
        <div id="revealOutcome" class="reveal-outcome"></div>
      </div>

      <h3 class="section-title">Scores</h3>
      <ul id="scoreboard" class="score-list"></ul>
    </section>

    <section id="resultsView" class="view" hidden>
      <h2>Final standings</h2>
      <ul id="standings" class="standings"></ul>
      <div class="row">
        <button type="button" id="playAgainBtn" class="primary" hidden>Play again</button>
        <p id="resultsGuestNote" class="muted" hidden>Waiting for the host.</p>
      </div>
      <h3 class="section-title">Every auction</h3>
      <p id="historyLegend" class="muted"></p>
      <div class="table-wrap">
        <table class="history">
          <thead><tr><th>#</th><th>Ref</th><th>Bids</th><th>Buyer @ price</th><th>Flip</th><th>Score change</th></tr></thead>
          <tbody id="historyBody"></tbody>
        </table>
      </div>
    </section>

    <section id="takenOverView" class="view" hidden>
      <h2>Seat opened elsewhere</h2>
      <p>This seat is now active in another tab or device. Reload here to take it back.</p>
      <button type="button" id="reloadBtn" class="primary">Reload</button>
    </section>

    <div id="toast" class="toast" hidden></div>
  </main>

  <script src="/game-core.js"></script>
  <script src="/client.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/client.js`**

```js
(function () {
  "use strict";

  const { SUITS, SUIT_SYMBOLS, countSuits, rank } = window.GameCore;
  // Must match SEAT_TAKEN_OVER_CODE in lib/rooms.js. Never auto-reconnect on
  // it: reconnecting would take the seat straight back and two tabs would
  // trade it forever.
  const SEAT_TAKEN_OVER_CODE = 4000;
  const NAME_KEY = "followsuit:name";
  const roomCode = (location.pathname.match(/^\/([a-z]{4})$/) || [])[1] || "";
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  };
  const tokenKey = () => `followsuit:token:${roomCode}`;

  let socket = null;
  let state = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 1000;
  let takenOver = false;
  let deadlineAt = 0; // performance.now() at which the bidding window ends
  let draft = { auction: null, amount: 0, locked: false };
  let resyncDraft = true; // after every (re)connect, trust the server's stored bid over the local draft
  let bidSendTimer = null;
  let toastTimer = null;
  let lastRevealKey = ""; // which auction's card step has already been animated

  // ---------- small helpers ----------
  function show(viewId) {
    for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== viewId;
  }
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function cardEl(suit, size) {
    const node = el("div", `card ${suit} ${size || ""}`.trim(), SUIT_SYMBOLS[suit]);
    node.setAttribute("aria-label", suit);
    return node;
  }
  function bySuit(cards) {
    return cards.slice().sort((a, b) => SUITS.indexOf(a) - SUITS.indexOf(b));
  }
  function playerName(id) {
    const p = state && state.players.find((x) => x.id === id);
    return p ? p.name : id;
  }
  function isHost() {
    return Boolean(state && state.you && state.hostId === state.you);
  }
  function fmtDelta(n) {
    return n > 0 ? `+${n}` : String(n);
  }
  function saveName() {
    store.set(NAME_KEY, $("nameInput").value.trim());
  }

  // ---------- landing / name view ----------
  function initLanding() {
    $("nameInput").value = store.get(NAME_KEY);
    if (roomCode) {
      $("landingActions").hidden = true;
      $("roomActions").hidden = false;
      $("joinRoomCode").textContent = roomCode.toUpperCase();
      $("roomBadge").textContent = roomCode.toUpperCase();
      $("roomBadge").hidden = false;
    }
    $("createBtn").addEventListener("click", async () => {
      saveName();
      try {
        const res = await fetch("/api/new-room", { cache: "no-store" });
        const data = await res.json();
        if (res.ok && data.room) location.href = `/${data.room}`;
        else toast("No room available right now, try again.");
      } catch {
        toast("Could not reach the server.");
      }
    });
    $("joinCodeBtn").addEventListener("click", () => {
      saveName();
      const code = $("codeInput").value.trim().toLowerCase();
      if (/^[a-z]{4}$/.test(code)) location.href = `/${code}`;
      else toast("Room codes are 4 letters.");
    });
    $("nameForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveName();
      if (!roomCode) {
        $("createBtn").click();
        return;
      }
      const name = $("nameInput").value.trim();
      if (!name) {
        toast("Please enter a name.");
        return;
      }
      send({ type: "join", name, resumeToken: store.get(tokenKey()) });
    });
  }

  // ---------- socket ----------
  function connect() {
    if (!roomCode || takenOver) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws?room=${roomCode}`);
    socket.addEventListener("open", () => {
      reconnectDelayMs = 1000;
      resyncDraft = true;
      $("connBadge").hidden = true;
      setBidControlsEnabled(true);
      const token = store.get(tokenKey());
      if (token) send({ type: "resume", resumeToken: token });
    });
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "joined") {
        store.set(tokenKey(), msg.resumeToken);
      } else if (msg.type === "state") {
        state = msg;
        render();
      } else if (msg.type === "error") {
        toast(msg.message);
        if (msg.code === "game_in_progress") store.del(tokenKey());
      }
    });
    socket.addEventListener("close", (event) => {
      socket = null;
      clearTimeout(bidSendTimer);
      setBidControlsEnabled(false);
      if (event.code === SEAT_TAKEN_OVER_CODE) {
        takenOver = true;
        show("takenOverView");
        return;
      }
      $("connBadge").hidden = false;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
        reconnectDelayMs = Math.min(5000, reconnectDelayMs * 1.5);
      }
    });
  }
  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
  function setBidControlsEnabled(enabled) {
    for (const id of ["bidInput", "bidRange", "lockBtn"]) $(id).disabled = !enabled;
  }

  // ---------- rendering ----------
  function render() {
    if (!state) return;
    if (!state.you) {
      show("nameView");
      const n = state.playerCount;
      $("roomPreview").textContent = state.phase === "lobby" ? (n ? `${n} in the lobby` : "Nobody here yet, you will be host") : "Game in progress";
      return;
    }
    if (state.phase === "lobby") {
      show("lobbyView");
      renderLobby();
    } else if (state.phase === "results") {
      show("resultsView");
      renderResults();
    } else {
      show("gameView");
      renderGame();
    }
  }

  function renderLobby() {
    const list = $("lobbyPlayers");
    list.replaceChildren();
    for (const p of state.players) {
      const row = el("li", "player-row" + (p.connected ? "" : " away"));
      row.append(el("span", "player-name", p.name));
      if (p.isBot) row.append(el("span", "badge", "bot"));
      if (p.id === state.hostId) row.append(el("span", "badge host", "host"));
      if (p.id === state.you) row.append(el("span", "badge you", "you"));
      if (!p.connected) row.append(el("span", "badge", "away"));
      if (p.isBot && isHost()) {
        const btn = el("button", "link-btn", "remove");
        btn.type = "button";
        btn.addEventListener("click", () => send({ type: "remove-bot", playerId: p.id }));
        row.append(btn);
      }
      list.append(row);
    }
    $("roomLink").value = `${location.origin}/${roomCode}`;
    $("lobbyCount").textContent = `${state.players.length} of ${state.maxPlayers} seats filled`;
    $("lobbyHandInfo").textContent = state.handSize
      ? `With ${state.players.length} players everyone gets ${state.handSize} cards and the deck holds ${(state.players.length + 1) * state.handSize}.`
      : "Need at least 2 players to start.";
    const host = isHost();
    $("hostControls").hidden = !host;
    $("guestNote").hidden = host;
    $("addBotBtn").disabled = state.players.length >= state.maxPlayers;
    $("startBtn").disabled = state.players.length < state.minPlayers;
  }

  function renderGame() {
    const total = state.flipped.length + state.cardsRemaining;
    const inCardStep = state.phase === "reveal" && state.revealStep === "card";
    $("refCard").replaceChildren(cardEl(state.reference, "big"));
    $("refLabel").textContent = inCardStep
      ? `New reference: ${SUIT_SYMBOLS[state.reference]}`
      : `Will the next card be ${SUIT_SYMBOLS[state.reference]}?`;
    $("deckInfo").textContent = `${state.cardsRemaining} of ${total} cards left, ${state.hiddenCount} were never seen by anyone`;

    const strip = $("flipStrip");
    strip.replaceChildren();
    state.flipped.forEach((suit, i) => {
      const c = cardEl(suit, "mini");
      if (i === state.flipped.length - 1) c.classList.add("current");
      strip.append(c);
    });
    strip.scrollLeft = strip.scrollWidth;

    const counts = countSuits(state.flipped);
    $("flipCounts").replaceChildren(...SUITS.map((suit) => el("span", `chip ${suit}`, `${SUIT_SYMBOLS[suit]} ${counts[suit]}`)));

    const hand = $("hand");
    hand.replaceChildren();
    for (const suit of bySuit(state.hand)) hand.append(cardEl(suit, "small"));

    const auctionNo = state.auctionIndex || state.history.length;
    $("auctionLabel").textContent = `Auction ${auctionNo} of ${total - 1}`;

    const bidding = state.phase === "bidding";
    $("bidPanel").hidden = !bidding;
    $("revealPanel").hidden = bidding;
    $("timer").hidden = !bidding;
    // Animate the card and the score deltas once per auction, not on every
    // state message that happens to arrive during the card step.
    let animate = false;
    if (inCardStep) {
      const key = `${state.matchId}:${state.auctionIndex}`;
      animate = key !== lastRevealKey;
      lastRevealKey = key;
    }
    if (bidding) renderBidPanel();
    else renderRevealPanel(animate);
    renderScoreboard(animate);
  }

  function renderScoreboard(animate) {
    const last = state.history[state.history.length - 1];
    const showDeltas = state.phase === "reveal" && state.revealStep === "card" && last && last.deltas;
    const buyers = state.phase === "reveal" && last ? last.buyers : [];
    const board = $("scoreboard");
    board.replaceChildren();
    for (const p of state.players) {
      const row = el("li", "score-row" + (p.id === state.you ? " you" : "") + (buyers.includes(p.id) ? " buyer" : "") + (p.connected ? "" : " away"));
      row.append(el("span", "player-name", p.name));
      if (state.phase === "bidding") row.append(el("span", "lock" + (p.locked ? " on" : ""), p.locked ? "locked" : "thinking"));
      if (showDeltas) {
        const d = last.deltas[p.id] || 0;
        row.append(el("span", "delta " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero") + (animate ? " pop" : ""), fmtDelta(d)));
      }
      row.append(el("span", "score", String(p.score)));
      board.append(row);
    }
  }

  function renderBidPanel() {
    if (resyncDraft || draft.auction !== state.auctionIndex) {
      resyncDraft = false;
      draft = {
        auction: state.auctionIndex,
        amount: state.myBid ? state.myBid.amount : 0,
        locked: state.myBid ? state.myBid.locked : false
      };
      $("bidInput").value = draft.amount;
      $("bidRange").value = draft.amount;
    }
    deadlineAt = performance.now() + state.remainingMs;
    updateTimer();
    paintLockButton();
  }

  function paintLockButton() {
    const btn = $("lockBtn");
    btn.textContent = draft.locked ? "Locked (tap to change)" : "Lock in bid";
    btn.classList.toggle("locked", draft.locked);
    $("bidHint").textContent = draft.locked
      ? "Waiting for the others. Your bid still counts if time runs out."
      : "Price you pay each opponent. You collect 100 from each if the card follows suit.";
  }

  function updateTimer() {
    const ms = Math.max(0, deadlineAt - performance.now());
    const node = $("timer");
    node.textContent = `${Math.ceil(ms / 1000)}s`;
    node.classList.toggle("urgent", ms < 5000);
  }
  setInterval(() => {
    if (state && state.phase === "bidding") updateTimer();
  }, 200);

  function setDraftAmount(raw) {
    let n = Math.round(Number(raw));
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(100, n));
    draft.amount = n;
    draft.locked = false;
    $("bidRange").value = n;
    if (document.activeElement !== $("bidInput")) $("bidInput").value = n;
    paintLockButton();
    scheduleBidSend(false);
  }

  function scheduleBidSend(immediate) {
    clearTimeout(bidSendTimer);
    const fire = () => send({ type: "bid", auction: draft.auction, amount: draft.amount, locked: draft.locked });
    if (immediate) fire();
    else bidSendTimer = setTimeout(fire, 150);
  }

  function lockBid() {
    draft.locked = !draft.locked;
    paintLockButton();
    scheduleBidSend(true);
  }

  function renderRevealPanel(animate) {
    const last = state.history[state.history.length - 1];
    if (!last) return;
    const list = $("revealBids");
    list.replaceChildren();
    const rows = Object.entries(last.bids).sort((a, b) => b[1] - a[1]);
    for (const [id, amount] of rows) {
      const row = el("li", "bid-row" + (last.buyers.includes(id) ? " buyer" : "") + (id === state.you ? " you" : ""));
      row.append(el("span", "player-name", playerName(id)));
      row.append(el("span", "amount", String(amount)));
      list.append(row);
    }
    $("revealSummary").textContent = last.void
      ? `Everyone bid ${last.price}. No trade this card.`
      : `${last.buyers.map(playerName).join(" and ")} ${last.buyers.length > 1 ? "buy" : "buys"} at ${last.price}`;
    const outcome = $("revealOutcome");
    outcome.replaceChildren();
    if (state.revealStep === "card") {
      outcome.append(cardEl(last.flipped, animate ? "big flip-in" : "big"));
      outcome.append(el("p", "outcome-text " + (last.matched ? "match" : "miss"), last.matched ? "Follows suit!" : "No match"));
    } else {
      outcome.append(el("p", "outcome-text pending", "Flipping the next card"));
    }
  }

  function renderResults() {
    const scores = {};
    for (const p of state.players) scores[p.id] = p.score;
    const standings = $("standings");
    standings.replaceChildren();
    for (const row of rank(scores)) {
      const p = state.players.find((x) => x.id === row.id);
      const li = el("li", "standing" + (row.id === state.you ? " you" : ""));
      li.append(el("span", "rank", `#${row.rank}`));
      li.append(el("span", "player-name", p.name));
      const hand = el("span", "mini-hand");
      for (const suit of bySuit(p.hand || [])) hand.append(cardEl(suit, "mini"));
      li.append(hand);
      li.append(el("span", "score " + (row.score > 0 ? "pos" : row.score < 0 ? "neg" : "zero"), fmtDelta(row.score)));
      standings.append(li);
    }
    $("historyLegend").textContent = `Bids and score changes are listed in this order: ${state.players.map((p) => p.name).join(", ")}.`;
    const tbody = $("historyBody");
    tbody.replaceChildren();
    for (const h of state.history) {
      const tr = el("tr");
      tr.append(el("td", "", String(h.index)));
      tr.append(el("td", `suit ${h.reference}`, SUIT_SYMBOLS[h.reference]));
      tr.append(el("td", "", state.players.map((p) => h.bids[p.id]).join(" / ")));
      tr.append(el("td", "", h.void ? `void @ ${h.price}` : `${h.buyers.map(playerName).join(", ")} @ ${h.price}`));
      tr.append(el("td", `suit ${h.flipped}`, `${SUIT_SYMBOLS[h.flipped]}${h.matched ? " match" : ""}`));
      tr.append(el("td", "", state.players.map((p) => fmtDelta((h.deltas && h.deltas[p.id]) || 0)).join(" / ")));
      tbody.append(tr);
    }
    $("playAgainBtn").hidden = !isHost();
    $("resultsGuestNote").hidden = isHost();
  }

  // ---------- init ----------
  function init() {
    initLanding();
    $("copyLinkBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("roomLink").value);
        toast("Link copied");
      } catch {
        $("roomLink").select();
      }
    });
    $("addBotBtn").addEventListener("click", () => send({ type: "add-bot" }));
    $("startBtn").addEventListener("click", () => send({ type: "start-game" }));
    $("bidInput").addEventListener("input", (event) => setDraftAmount(event.target.value));
    $("bidRange").addEventListener("input", (event) => setDraftAmount(event.target.value));
    $("lockBtn").addEventListener("click", lockBid);
    $("playAgainBtn").addEventListener("click", () => send({ type: "return-to-lobby" }));
    $("reloadBtn").addEventListener("click", () => location.reload());
    show("nameView");
    connect();
  }

  init();
})();
```

- [ ] **Step 3: Syntax-check and smoke the shell**

Run: `node --check public/client.js && node --check public/game-core.js`
Expected: no output (both parse).

Run (in one shell): `PORT=3210 npm start` and in another: `curl -s http://localhost:3210/ | grep -c 'id="gameView"'`
Expected: `1`. Stop the server afterwards (Ctrl+C, or `netstat -ano | grep :3210` then `powershell.exe -Command "Stop-Process -Id <pid> -Force"`).

- [ ] **Step 4: Run the full suite (server test reads the new index.html)**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/client.js
git commit -m "feat: client shell, socket wiring, and all four views"
```

---

### Task 9: Styling and rules page (`public/styles.css`, `public/how-to-play.html`)

**Files:**
- Create: `public/styles.css`
- Replace: `public/how-to-play.html` (placeholder from Task 7)

**Interfaces:**
- Consumes: the ids and classes in Task 8's HTML and `client.js` (`.view`, `.card` with suit classes and sizes `big`/`small`/`mini`, `.current`, `.flip-in`, `.player-row`, `.badge`, `.score-row`, `.buyer`, `.you`, `.away`, `.lock.on`, `.delta.pos/.neg/.zero`, `.bid-row`, `.timer.urgent`, `.toast`, `.conn-badge`, `.room-badge`, `.table-wrap`, `.history`, `.standing`, `.mini-hand`, `.primary`, `.link-btn`, `.locked`).
- Produces: a phone-first layout that also reads well at desktop width. No new ids.

- [ ] **Step 1: Write `public/styles.css`**

```css
:root {
  --felt: #0f1b17;
  --felt-2: #16261f;
  --line: #2a3d34;
  --ink: #f2ecd8;
  --muted: #a9b5ad;
  --gold: #e0b354;
  --gold-2: #f3cf7a;
  --red: #c0392b;
  --black: #1c1c1c;
  --good: #58c27d;
  --bad: #e06c5a;
  --card-face: #fbf7ec;
  --radius: 12px;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; background: var(--felt); color: var(--ink); }
body { min-height: 100dvh; padding-bottom: env(safe-area-inset-bottom); }
a { color: var(--gold-2); }
h1, h2, h3 { margin: 0 0 8px; font-weight: 700; letter-spacing: 0.01em; }
h1 { font-size: 2rem; }
h2 { font-size: 1.4rem; }
h3.section-title { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin-top: 18px; }
p { margin: 6px 0; line-height: 1.4; }
.muted { color: var(--muted); font-size: 0.92rem; }
.tagline { font-size: 1.05rem; }

.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
  background: var(--felt-2);
}
.brand { color: var(--gold); text-decoration: none; font-weight: 800; letter-spacing: 0.04em; }
.room-badge { margin-left: auto; font-family: ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.2em; color: var(--ink); background: var(--line); padding: 4px 10px; border-radius: 999px; }
.conn-badge { color: var(--bad); font-size: 0.85rem; }

#app { max-width: 620px; margin: 0 auto; padding: 16px; }
.view { display: flex; flex-direction: column; gap: 10px; }
.stack { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
label { font-size: 0.9rem; color: var(--muted); }

input[type="text"], input:not([type]), input[type="number"] {
  width: 100%; padding: 12px 14px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--felt-2); color: var(--ink); font-size: 1rem;
}
input[readonly] { color: var(--muted); }
button {
  padding: 12px 18px; border-radius: var(--radius); border: 1px solid var(--line);
  background: var(--felt-2); color: var(--ink); font-size: 1rem; font-weight: 600; cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--gold); border-color: var(--gold); color: #1a1408; }
button.primary.locked { background: var(--good); border-color: var(--good); color: #062b13; }
.link-btn { padding: 4px 8px; font-size: 0.8rem; margin-left: auto; }
.join-row, .link-row { display: flex; gap: 8px; }
.join-row input, .link-row input { flex: 1; min-width: 0; }
#codeInput { text-transform: uppercase; letter-spacing: 0.25em; font-family: ui-monospace, Menlo, Consolas, monospace; }

.player-list, .score-list, .bid-list, .standings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.player-row, .score-row, .bid-row, .standing {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: var(--radius); background: var(--felt-2); border: 1px solid var(--line);
}
.player-name { font-weight: 600; }
.away { opacity: 0.55; }
.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 999px; background: var(--line); color: var(--muted); }
.badge.host { background: var(--gold); color: #1a1408; }
.badge.you { background: var(--good); color: #062b13; }
.rules-blurb { font-size: 0.9rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }

/* cards */
.card {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--card-face); color: var(--black); border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); font-weight: 700; user-select: none;
}
.card.hearts, .card.diamonds { color: var(--red); }
.card.big { width: 96px; height: 134px; font-size: 3.2rem; border-radius: 12px; }
.card.small { width: 44px; height: 62px; font-size: 1.5rem; }
.card.mini { width: 26px; height: 36px; font-size: 1rem; border-radius: 5px; }
.card.current { outline: 3px solid var(--gold); }
@keyframes flipIn { from { transform: rotateY(90deg) scale(0.9); opacity: 0; } to { transform: none; opacity: 1; } }
.card.flip-in { animation: flipIn 380ms ease-out; }

.table-top { display: flex; gap: 14px; align-items: center; }
.table-info { display: flex; flex-direction: column; gap: 4px; }
.ref-label { font-size: 1.1rem; font-weight: 600; margin: 0; }
.flip-counts { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 3px 8px; border-radius: 999px; background: var(--felt-2); border: 1px solid var(--line); font-size: 0.85rem; }
.chip.hearts, .chip.diamonds { color: #ff8a7a; }
.flip-strip { display: flex; gap: 4px; overflow-x: auto; padding: 6px 2px; scrollbar-width: thin; }
.hand { display: flex; flex-wrap: wrap; gap: 6px; }

.auction-head { display: flex; align-items: baseline; justify-content: space-between; margin-top: 12px; }
.auction-label { font-weight: 700; }
.timer { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.3rem; color: var(--gold-2); }
.timer.urgent { color: var(--bad); }

.panel { background: var(--felt-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.bid-controls { display: grid; grid-template-columns: 1fr 84px; grid-template-rows: auto auto; gap: 10px; align-items: center; }
.bid-controls input[type="range"] { grid-column: 1 / 2; width: 100%; accent-color: var(--gold); }
.bid-controls input[type="number"] { grid-column: 2 / 3; text-align: center; font-size: 1.3rem; padding: 8px; }
.bid-controls button { grid-column: 1 / -1; }

.reveal-summary { font-weight: 700; font-size: 1.05rem; margin: 0 0 8px; }
.bid-row .amount { margin-left: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.1rem; }
.bid-row.buyer { border-color: var(--gold); background: rgba(224, 179, 84, 0.12); }
.bid-row.you .player-name::after, .score-row.you .player-name::after, .standing.you .player-name::after { content: " (you)"; color: var(--muted); font-weight: 400; }
.reveal-outcome { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: 12px; min-height: 150px; justify-content: center; }
.outcome-text { font-size: 1.2rem; font-weight: 700; margin: 0; }
.outcome-text.match { color: var(--good); }
.outcome-text.miss { color: var(--bad); }
.outcome-text.pending { color: var(--muted); font-weight: 400; }

.score-row .lock { font-size: 0.8rem; color: var(--muted); }
.score-row .lock.on { color: var(--good); }
.score-row .score, .standing .score { margin-left: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.1rem; }
.score-row.buyer { border-color: var(--gold); }
.delta { font-family: ui-monospace, Menlo, Consolas, monospace; padding: 1px 6px; border-radius: 6px; }
.delta.pos, .score.pos { color: var(--good); }
.delta.neg, .score.neg { color: var(--bad); }
.delta.zero, .score.zero { color: var(--muted); }
@keyframes popIn { from { transform: translateY(8px) scale(0.7); opacity: 0; } to { transform: none; opacity: 1; } }
.delta.pop { animation: popIn 320ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .card.flip-in, .delta.pop { animation: none; }
}

.standing .rank { font-weight: 800; color: var(--gold); width: 2.2em; }
.mini-hand { display: flex; gap: 2px; flex-wrap: wrap; }

.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
table.history { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
table.history th, table.history td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
table.history th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.08em; }
td.suit { font-size: 1.1rem; }
td.suit.hearts, td.suit.diamonds { color: #ff8a7a; }

.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: var(--ink); color: var(--felt); padding: 10px 16px; border-radius: 999px;
  font-weight: 600; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); z-index: 10; max-width: 90vw;
}

@media (min-width: 560px) {
  .card.big { width: 112px; height: 156px; font-size: 3.8rem; }
  .bid-controls { grid-template-columns: 1fr 96px auto; grid-template-rows: auto; }
  .bid-controls button { grid-column: auto; }
}
```

- [ ] **Step 2: Write `public/how-to-play.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>How to play Follow Suit</title>
  <meta name="description" content="Rules for Follow Suit, a multiplayer card auction about asymmetric information and the winner's curse.">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar"><a class="brand" href="/">Follow Suit</a></header>
  <main id="app">
    <section class="view">
      <h1>How to play</h1>
      <p>Follow Suit is a bidding game about one question, asked over and over: will the next card be the same suit as the one showing?</p>

      <h2>Setup</h2>
      <p>The pool holds 40 cards, ten of each suit, and nothing else. Cards have no rank. Each player is dealt a hand and looks at it in private. The same number of cards again is taken from the pool face down as hidden cards that nobody sees. All the hands and the hidden cards are shuffled together into the deck. The rest of the pool is put away unseen.</p>
      <table class="history">
        <thead><tr><th>Players</th><th>Cards each</th><th>Deck</th><th>Auctions</th></tr></thead>
        <tbody>
          <tr><td>2</td><td>8</td><td>24</td><td>23</td></tr>
          <tr><td>3</td><td>6</td><td>24</td><td>23</td></tr>
          <tr><td>4</td><td>4</td><td>20</td><td>19</td></tr>
          <tr><td>5</td><td>4</td><td>24</td><td>23</td></tr>
          <tr><td>6</td><td>3</td><td>21</td><td>20</td></tr>
        </tbody>
      </table>
      <p>Your hand is your private information. If you saw six spades out of eight cards, the deck is heavier in spades than the others think.</p>

      <h2>Each auction</h2>
      <p>The top card of the deck is turned face up. That is the reference card. Everyone then secretly bids a whole number from 0 to 100. Your bid is the price you will pay to each other player for the right to collect 100 from each of them if the next card matches the reference suit.</p>
      <p>When everyone has locked a bid, or the timer runs out, the bids are shown. The highest bid wins. The winner pays that price to every other player, and every other player is on the other side of the trade whether they like it or not. Then the next card is flipped. If it follows suit, each other player pays the winner 100. Either way, that card becomes the new reference and the next auction begins.</p>
      <p>If two or more players tie for the highest bid, all of them buy from everyone else. If everyone ties, nobody trades on that card.</p>
      <p>A bid you did not lock still counts when the timer runs out. If you never bid, your bid is 0.</p>

      <h2>A worked example</h2>
      <p>Three players bid 80, 50 and 20. The player who bid 80 buys and pays 80 to each of the other two. If the card matches, each of them pays 100 back, so the buyer finishes the auction up 40 and the other two are down 20 each. If it does not match, the buyer is down 160 and the others are up 80 each.</p>

      <h2>Scoring</h2>
      <p>Scores start at zero and can go negative. There is nothing to run out of. The game ends when the last card is flipped, and the highest score wins. At the end everyone's starting hand is revealed so you can see who knew what.</p>

      <h2>Why the game is hard</h2>
      <p>Only the highest bidder wins, so the winner is usually the player whose estimate was the most optimistic. That is the winner's curse, and it is the reason a fair bid should sit a little under what you think the bet is worth. But bid too low and you are forced to sell to someone else at their price instead. Every bid is shown after the auction, so the bids themselves tell you something about what the other players saw in their hands.</p>

      <p><a href="/">Back to the game</a></p>
    </section>
  </main>
</body>
</html>
```

- [ ] **Step 3: Verify both files are served**

Run (in one shell): `PORT=3210 npm start`; in another: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3210/styles.css && curl -s http://localhost:3210/how-to-play | grep -c "worked example"`
Expected: `200` then `1`. Stop the server afterwards.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add public/styles.css public/how-to-play.html
git commit -m "feat: styling and how-to-play page"
```

---

### Task 10: Deploy config and repo docs

**Files:**
- Create: `render.yaml`, `AGENTS.md`, `CLAUDE.md`, `LEARNINGS.md`

**Interfaces:** none (documentation and deployment config only).

- [ ] **Step 1: Write `render.yaml`**

```yaml
services:
  - type: web
    name: follow-suit
    runtime: node
    plan: free
    branch: main
    autoDeploy: true
    buildCommand: npm ci
    startCommand: npm start
    healthCheckPath: /
    envVars:
      - key: NODE_VERSION
        value: "22"
```

- [ ] **Step 2: Write `AGENTS.md`**

```markdown
# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this
file, so it is the single source of truth for both Claude Code and Codex.

## What this is

Follow Suit: a multiplayer card auction that teaches the winner's curse. Players
bid for the right to bet that the next card flipped matches the suit of the
current one; the highest bidder buys from everyone else at their bid. Express 5
plus raw WebSockets (`ws`), vanilla JS in the browser, server-side bots. The
design spec is `docs/superpowers/specs/2026-09-12-follow-suit-design.md` and the
rules are stated there in full.

## Running locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # node --test, no watch mode
```

No build step, no bundler, no linter. Edit and reload. `server.js` reads
`public/index.html` once at startup, so restart after editing it.

Environment variables (defaults in `server.js`): `PORT`, `BID_MS`,
`REVEAL_BIDS_MS`, `REVEAL_CARD_MS`, `RESUME_TTL_MS`.

## Architecture

- `public/game-core.js`: rules shared by server and browser (UMD, dependency-free).
  Deal, settlement, ranking, constants.
- `lib/fair-value.js`: exact Bayesian probability of the next suit. Server only;
  never serve it, because estimating fair value is the skill the game teaches.
- `lib/bots.js`: bot names, profiles, and bidding around fair value.
- `lib/game.js`: the per-room state machine (lobby, bidding, reveal, results)
  with injected clock and timers. One pending phase timer per room, guarded by
  match id and auction index.
- `lib/rooms.js`: rooms, seats, resume tokens, host, seat expiry, room deletion.
  Resume adopts a seat unconditionally and closes the displaced socket with 4000.
- `lib/snapshot.js`: the per-recipient `state` message. The secrecy boundary.
- `server.js`: env config, routes, WebSocket wiring, broadcast.
- `public/client.js`: renders whatever `state` last arrived. Server-authoritative.

## Testing

`tests/server.test.js` spawns the real server and drives real sockets; every
other test is pure with the fake clock in `tests/helpers/clock.js`. The
fair-value test runs a Monte Carlo and takes a few seconds.

## Deploy

Render web service via `render.yaml`, auto-deploy from `main`.
```

- [ ] **Step 3: Write `CLAUDE.md` and `LEARNINGS.md`**

`CLAUDE.md`:

```markdown
@./AGENTS.md

## Claude Code specifics

- The Bash tool runs Git Bash (POSIX), not PowerShell.
- For UI changes, run the app and drive it in Chrome before reporting done.
```

`LEARNINGS.md`:

```markdown
# LEARNINGS — follow-suit

Durable findings — past bug fixes, non-obvious behavior, tooling quirks. Add when something surprised us; read when starting work here. Newest entries at the top.

---
```

- [ ] **Step 4: Commit**

```bash
git add render.yaml AGENTS.md CLAUDE.md LEARNINGS.md
git commit -m "docs: agent guidance, learnings stub, and Render config"
```

---

### Task 11: End-to-end verification in Chrome

**Files:** none created. Fix anything found, with a test where the bug is in `lib/`.

This task is the manual pass the spec requires (section 6) and the UI gate from the workspace rules. Use the Chrome tools (`mcp__claude-in-chrome__*`). Keep the server on a port nobody else uses and shut it down at the end.

- [ ] **Step 1: Start the server with short reveal timings**

Run in the background: `PORT=3210 BID_MS=20000 npm start`
Expected: log line `Follow Suit server running at http://localhost:3210`.

- [ ] **Step 2: Landing, room creation, and lobby**

1. Open a new tab at `http://localhost:3210/`. Enter the name `Ann`, click Create a room. The URL becomes `/xxxx`, the name view shows "Join room XXXX", and joining shows the lobby with Ann as host.
2. Copy the room link. Open a second tab at that URL, enter `Ben`, join. Both tabs list Ann (host) and Ben; only Ann's tab shows Add bot and Start.
3. In Ann's tab click Add bot twice. Both tabs show Bot Ada and Bot Bo with bot badges. Start becomes enabled. Click remove on Bot Bo and add it back.

- [ ] **Step 3: The first game, up to the middle**

1. Click Start in Ann's tab. Both tabs show the game view: a large reference card, one card in the flip strip, a hand of 4 cards (4 players), a countdown from 20, and a scoreboard with the two bots showing "locked" within about six seconds.
2. In Ann's tab drag the slider to 30 and click Lock. In Ben's tab type 10 and click Lock. Within a second both tabs show the reveal panel: four bids sorted with the buyer highlighted, then the flipped card animates in with "Follows suit!" or "No match", then score deltas pop onto the scoreboard, then auction 2.
3. Let one auction expire without bidding in either tab. Confirm Ann's and Ben's bids show as 0 in the reveal, and that a bot bought.
4. Resize Ann's tab to about 400px wide for a couple of auctions and confirm nothing overflows horizontally and the bid controls stay usable. Resize back.

- [ ] **Step 4: Resume, takeover, and refusal, still mid-game**

1. Reload Ben's tab during bidding. It returns straight to the game view with the same hand, score, and the full history, the scoreboard shows Ben connected, and the bid control shows whatever Ben had stored for this auction.
2. Open Ben's room URL in a third tab. The third tab takes the seat; the previous Ben tab shows "Seat opened elsewhere". Close the old Ben tab and keep the new one.
3. In a fourth tab open the room URL in a fresh browser profile or after clearing `localStorage` for the site, enter `Cat`, and join. A toast says "Game in progress, try again after this game." Close that tab.

- [ ] **Step 5: Finish the game, then Play again**

1. Play through to results by locking bids each auction (or let the deadline run). The results view shows standings with ranks, every player's hand revealed as mini cards, and the auction table with one row per auction, void rows showing their price. Scores across all players sum to zero.
2. In Ann's results view click Play again. Both tabs return to the lobby with all four seats kept and scores gone. Start again and confirm auction 1 of a fresh deck, then let it run for two auctions.

- [ ] **Step 6: Record and fix**

For every defect found, fix it. If the defect is in `lib/` add a failing test first. Re-run `npm test` after fixes and repeat the affected manual step.

- [ ] **Step 7: Stop the server and commit**

Find the process on port 3210 and stop it:

```bash
netstat -ano | grep :3210
powershell.exe -Command "Stop-Process -Id <pid> -Force"
```

Then:

```bash
git add -A
git commit -m "fix: issues found in the end-to-end Chrome pass"
```

(Skip the commit if nothing changed.)
