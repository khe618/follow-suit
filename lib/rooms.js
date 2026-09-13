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

  function getOrCreate(code) {
    let room = rooms.get(code);
    if (room) return room;
    room = { code, seats: new Map(), visitors: new Set(), nextSeatNo: 1, botsAdded: 0, deletionTimer: null, game: null };
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
    addBot, removeBot, startGame, returnToLobby, deleteRoom, SEAT_TAKEN_OVER_CODE
  };
}

module.exports = { createRegistry, SEAT_TAKEN_OVER_CODE, CODE_RESERVATION_MS };
