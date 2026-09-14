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
  const MAX_PLAYERS = 4;
  const HAND_SIZES = { 2: 10, 3: 7, 4: 5 };
  const CARD_PAYOUT = 10;
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

  // Hands come off the top of a shuffled pool, then the deck is exactly those
  // hands reshuffled. The rest of the pool is discarded unseen.
  function deal(playerCount, randomInt = defaultRandomInt) {
    const n = handSize(playerCount);
    const pool = shuffle(buildPool(), randomInt);
    const hands = [];
    for (let p = 0; p < playerCount; p++) hands.push(pool.slice(p * n, (p + 1) * n));
    const deck = shuffle(hands.flat(), randomInt);
    return { hands, deck };
  }

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
    SUITS, SUIT_SYMBOLS, POOL_PER_SUIT, MIN_PLAYERS, MAX_PLAYERS, HAND_SIZES, CARD_PAYOUT, MAX_BID,
    handSize, buildPool, shuffle, countSuits, deal, resolveBids, settlePurchase, settleFlip, priorValue, rank
  };
});
