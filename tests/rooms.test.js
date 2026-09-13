const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistry } = require("../lib/rooms.js");
const { createGame } = require("../lib/game.js");
const { createClock } = require("./helpers/clock.js");

const TTL = 10000;
const CONFIG = { dealMs: 7000, bidMs: 20000, revealBidsMs: 3000, revealCardMs: 4000 };

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

test("join creates a seat with a token", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  const a = registry.join(room, { name: "Ann", ws: fakeWs() });
  const b = registry.join(room, { name: "Ben", ws: fakeWs() });
  assert.equal(a.ok, true);
  assert.equal(a.seat.id, "p1");
  assert.match(a.seat.resumeToken, /^[0-9a-f]{32}$/);
  assert.equal(b.seat.id, "p2");
  assert.equal(typeof room.hostId, "undefined", "no host concept");
});

test("join is refused when full or when a game is running", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  for (let i = 0; i < 4; i++) assert.equal(registry.join(room, { name: `P${i}`, ws: fakeWs() }).ok, true);
  assert.deepEqual(registry.join(room, { name: "Extra", ws: fakeWs() }), { ok: false, error: "room_full" });
  const room2 = registry.getOrCreate("wxyz");
  registry.join(room2, { name: "A", ws: fakeWs() });
  registry.join(room2, { name: "B", ws: fakeWs() });
  assert.equal(registry.startGame(room2).ok, true);
  assert.deepEqual(registry.join(room2, { name: "C", ws: fakeWs() }), { ok: false, error: "game_in_progress" });
});

test("bots get unique names, ordered profiles, and only in the lobby", () => {
  const { registry } = setup();
  const room = registry.getOrCreate("abcd");
  registry.join(room, { name: "Ann", ws: fakeWs() });
  const names = new Set();
  const keys = [];
  for (let i = 0; i < 3; i++) {
    const r = registry.addBot(room);
    assert.equal(r.ok, true);
    names.add(r.seat.name);
    keys.push(r.seat.profile.key);
    assert.equal(r.seat.isBot, true);
    assert.equal(r.seat.resumeToken, null);
  }
  assert.equal(names.size, 3);
  assert.deepEqual(keys, ["careful", "fair", "keen"]);
  assert.deepEqual(registry.addBot(room), { ok: false, error: "room_full" });
  assert.equal(registry.removeBot(room, "p2"), true);
  assert.equal(room.seats.size, 3);
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
    clock.advance(CONFIG.revealBidsMs + CONFIG.revealCardMs);
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
    clock.advance(CONFIG.revealBidsMs + CONFIG.revealCardMs);
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
