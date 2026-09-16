"use strict";
const { SUITS, handSize } = require("../../public/game-core.js");

// A deterministic randomInt for the equal-probability deal: player 1 gets a
// hand of nothing but spades, player 2 nothing but hearts, and so on, and the
// shuffle that follows is the identity, so the deck is the hands in seat
// order. deal() asks for playerCount * n suit indices first and only then for
// shuffle positions, so counting the calls is enough to tell them apart.
function dealtInSuitOrder(playerCount) {
  const n = handSize(playerCount);
  const draws = [];
  for (let p = 0; p < playerCount; p++) for (let i = 0; i < n; i++) draws.push(p % SUITS.length);
  let i = 0;
  return (maxExclusive) => (i < draws.length ? draws[i++] : maxExclusive - 1);
}

module.exports = { dealtInSuitOrder };
