"use strict";
const { SUITS, cardValue, handSize } = require("../public/game-core.js");

// log(n!) for n up to 64, enough for any deck this game deals.
const LOG_FACT = [0];
for (let i = 1; i <= 64; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k];
}

function total(counts) {
  return SUITS.reduce((acc, s) => acc + (counts[s] || 0), 0);
}

// Spec 4.6 of the v1 design, as amended by the equal-probability deal. From
// one player's view the unseen part of the deck U (the other hands) is
// (P-1)*n independent uniform suit draws, so its composition is multinomial
// rather than a subset of a finite pool; the deck D = H + U is then flipped
// in uniform order.
// Weight each composition U by its multinomial probability times MVH(F; D),
// dropping the factors that are constant across U, then take the expectation
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

  const terms = [];
  for (let a = 0; a <= unknown; a++) {
    for (let b = 0; b <= unknown - a; b++) {
      for (let c = 0; c <= unknown - a - b; c++) {
        const d = unknown - a - b - c;
        const U = [a, b, c, d];
        const D = H.map((h, i) => h + U[i]);
        if (D.some((x, i) => x < F[i])) continue;
        // (1/4)^unknown and unknown! are constant across U and drop out.
        let logq = 0;
        for (let i = 0; i < 4; i++) logq += logChoose(D[i], F[i]) - LOG_FACT[U[i]];
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

// Value of one stake contract on the reference suit, per counterparty: the
// expected count still to come, priced with the doubled runout tail.
function fairValue({ hand, flips, playerCount, reference }) {
  const { remaining, cardsLeft } = posterior({ hand, flips, playerCount });
  return cardValue(cardsLeft) * remaining[reference];
}

module.exports = { nextSuitProbabilities, expectedRemaining, fairValue };
