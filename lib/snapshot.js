"use strict";
const { MIN_PLAYERS, MAX_PLAYERS, handSize } = require("../public/game-core.js");

// The only place server state is turned into a message. Everything a client
// sees goes through here, so this file is the secrecy boundary: no deck, no
// other hands before results, no other bid amounts before reveal.

function cloneEntry(h) {
  return {
    index: h.index,
    reference: h.reference,
    bids: { ...h.bids },
    buyers: h.buyers.slice(),
    sellers: h.sellers.slice(),
    topBid: h.topBid,
    void: h.void,
    runout: h.runout,
    purchase: { ...h.purchase },
    flipped: h.flipped,
    hits: h.hits,
    payouts: h.payouts ? h.payouts.map((p) => ({ ...p })) : null,
    deltas: h.deltas ? { ...h.deltas } : null
  };
}

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
    timing: game.timing,
    you: recipientId,
    players,
    reference: game.reference(),
    flipped: game.flipped(),
    cardsRemaining: game.cardsRemaining(),
    auctionIndex: game.auction ? game.auction.index : null,
    hand: me ? me.hand.slice() : null,
    myBid: myBidRaw ? { amount: myBidRaw.amount, locked: myBidRaw.locked } : null,
    history: game.history.map(cloneEntry),
    stakes: game.stakes.map((s) => ({ auction: s.auction, suit: s.suit, buyers: s.buyers.slice(), sellers: s.sellers.slice() })),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    handSize: size
  };
}

module.exports = { buildState };
