(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SUITS = ["spades", "hearts", "diamonds", "clubs"];
  const SUIT_SYMBOLS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
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
