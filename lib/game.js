"use strict";
const crypto = require("node:crypto");
const GameCore = require("../public/game-core.js");
const { computeBotBid, botDelayMs } = require("./bots.js");
const { MIN_PLAYERS, MAX_PLAYERS, MAX_BID, CARD_PAYOUT, RUNOUT_MULTIPLIER, deal, settlePurchase, settleFlip, isRunoutCard, countSuits } = GameCore;

const DEFAULT_CONFIG = { dealMs: 9500, bidMs: 60000, revealBidsMs: 6000, revealCardMs: 6000 };

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
    auction: null,
    dealEndsAt: 0,
    history: [],
    stakes: [],
    timer: null,
    botTimers: [],
    timing: Object.freeze({ dealMs: config.dealMs, bidMs: config.bidMs, revealBidsMs: config.revealBidsMs, revealCardMs: config.revealCardMs })
  };

  function player(id) {
    return game.players.find((p) => p.id === id) || null;
  }
  function reference() {
    return game.flipIndex > 0 ? game.deck[game.flipIndex - 1] : null;
  }
  function playerIds() {
    return game.players.map((p) => p.id);
  }
  function flipped() {
    return game.deck.slice(0, game.flipIndex);
  }
  function cardsRemaining() {
    return game.deck.length - game.flipIndex;
  }
  function remainingMs() {
    if (game.phase === "dealing") return Math.max(0, game.dealEndsAt - now());
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
    game.stakes = [];
    game.auction = null;
    game.revealStep = null;
    game.flipIndex = 0;
    game.deck = [];
    game.dealEndsAt = 0;
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
    game.flipIndex = 1;
    // Dealing is a pure pause so every client can animate the deal before
    // auction 1 opens. No bots bid, no bids are accepted (see bid()).
    game.phase = "dealing";
    game.revealStep = null;
    game.auction = null;
    game.dealEndsAt = now() + config.dealMs;
    armTimer("deal", config.dealMs, () => startAuction(1));
    onChange();
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
      runout: false,
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
    const cardNumber = game.flipIndex + 1;
    const card = game.deck[game.flipIndex];
    const perCard = isRunoutCard(cardNumber, game.deck.length) ? CARD_PAYOUT * RUNOUT_MULTIPLIER : CARD_PAYOUT;
    const result = settleFlip(game.stakes, card, playerIds(), perCard);
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

  // The last RUNOUT_CARDS cards are never a reference: each is flipped in
  // its own step with no bidding, and every stake it hits pays double.
  function runoutStep() {
    const index = game.auction.index + 1;
    game.auction = { index, runout: true, deadlineAt: 0, bids: {} };
    const purchase = {};
    for (const p of game.players) purchase[p.id] = 0;
    game.history.push({
      index, reference: reference(), bids: {}, buyers: [], sellers: [], topBid: null, void: false, runout: true,
      purchase, flipped: null, hits: null, payouts: null, deltas: null
    });
    game.phase = "reveal";
    flipAndPay();
  }

  function advance() {
    if (cardsRemaining() === 0) {
      game.phase = "results";
      game.revealStep = null;
      game.auction = null;
      onChange();
      return;
    }
    // The reference is the last flipped card, number flipIndex.
    if (isRunoutCard(game.flipIndex, game.deck.length)) {
      runoutStep();
      return;
    }
    startAuction(game.auction.index + 1);
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
