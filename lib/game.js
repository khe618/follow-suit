"use strict";
const crypto = require("node:crypto");
const GameCore = require("../public/game-core.js");
const { computeBotBid, botDelayMs } = require("./bots.js");
const { MIN_PLAYERS, MAX_PLAYERS, MAX_BID, deal, settle, resolveBids, countSuits } = GameCore;

const DEFAULT_CONFIG = { dealMs: 9500, bidMs: 30000, revealBidsMs: 4500, revealCardMs: 4000 };

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
    dealEndsAt: 0,
    history: [],
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
    game.auction = null;
    game.revealStep = null;
    game.flipIndex = 0;
    game.deck = [];
    game.hiddenCount = 0;
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
    game.hiddenCount = dealt.hidden.length;
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
