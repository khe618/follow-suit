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
    env: { ...process.env, PORT: String(PORT), RESUME_TTL_MS: String(TTL_MS), DEAL_MS: "50", BID_MS: "4000", REVEAL_BIDS_MS: "50", REVEAL_CARD_MS: "50" },
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

test("quick-play in a fresh room seats three bots and deals", async () => {
  const room = uniqueRoom();
  const c = connect(room);
  await c.open();
  c.send({ type: "quick-play", name: "Ann" });
  const joined = await c.until((m) => m.type === "joined", "joined");
  const s = await c.until((m) => m.type === "state" && m.phase === "dealing", "dealing");
  assert.equal(s.you, joined.playerId);
  assert.equal(s.players.length, 4);
  assert.equal(s.players.filter((p) => p.isBot).length, 3);
  assert.equal(s.players[0].id, joined.playerId, "the human took the first seat");
  assert.equal(s.hand.length, 5);
  assert.ok(c.messages.indexOf(joined) < c.messages.indexOf(s), "joined arrives before the first dealing state");
  await c.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  c.ws.close();
});

test("quick-play into a room that already has a seat is a plain join", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = connect(room);
  await b.open();
  b.send({ type: "quick-play", name: "Ben" });
  const joined = await b.until((m) => m.type === "joined", "joined");
  const s = await b.until((m) => m.type === "state" && m.you === joined.playerId, "seated");
  assert.equal(s.phase, "lobby");
  assert.equal(s.players.length, 2);
  assert.equal(s.players.some((p) => p.isBot), false);
  a.ws.close();
  b.ws.close();
});

test("quick-play needs a name and is refused mid-game like join", async () => {
  const room = uniqueRoom();
  const c = connect(room);
  await c.open();
  c.send({ type: "quick-play", name: "   " });
  const err = await c.until((m) => m.type === "error", "empty name");
  assert.match(err.message, /name/i);
  c.send({ type: "quick-play", name: "Ann" });
  await c.until((m) => m.type === "state" && m.phase === "dealing", "dealing");
  const d = connect(room);
  await d.open();
  d.send({ type: "quick-play", name: "Dee" });
  const refused = await d.until((m) => m.type === "error", "refused");
  assert.equal(refused.code, "game_in_progress");
  c.ws.close();
  d.ws.close();
});

test("routes: shell, new-room, how-to-play, html redirect, json 404", async () => {
  assert.equal((await getJson("/")).status, 200);
  assert.equal((await getJson("/abcd")).status, 200);
  const nr = await getJson("/api/new-room");
  assert.equal(nr.status, 200);
  assert.match(JSON.parse(nr.body).room, /^[a-z]{4}$/);
  const htp = await getJson("/how-to-play");
  assert.equal(htp.status, 200);
  assert.match(htp.body, /<title>Follow Suit<\/title>/);
  const page = await getJson("/no-such-page", { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "/");
  const asset = await getJson("/no-such.png", { Accept: "image/avif,image/webp,*/*" });
  assert.equal(asset.status, 404);
  assert.equal(JSON.parse(asset.body).error, "not_found");
  const api = await getJson("/api/nothing", { Accept: "application/json" });
  assert.equal(api.status, 404);
});

test("an oversized frame closes the connection with 1009, and the room keeps working", async () => {
  const room = uniqueRoom();
  const big = connect(room);
  await big.open();
  const closed = big.closed();
  big.ws.send("x".repeat(20 * 1024));
  assert.equal(await closed, 1009);
  const a = connect(room);
  await a.open();
  await a.until((m) => m.type === "state", "state after the oversized frame");
  a.ws.close();
});

test("join seats a player and returns a token", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const s = a.lastState();
  assert.equal("hostId" in s, false);
  assert.equal(s.players.length, 1);
  assert.match(a.token, /^[0-9a-f]{32}$/);
  a.ws.close();
});

test("any seated player can add a bot and start the game", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  // Visitor-shaped states have no `players`; guard the predicate and pass a
  // watermark so older messages are never scanned (see LEARNINGS.md).
  const from = b.messages.length;
  b.send({ type: "add-bot" });
  await b.until((m) => m.type === "state" && m.players && m.players.length === 3, "bot added by second joiner", from);
  b.send({ type: "start-game" });
  const s = await a.until((m) => m.type === "state" && m.phase === "dealing", "dealing started by second joiner");
  assert.equal(s.players.length, 3);
  a.ws.close();
  b.ws.close();
});

test("a visitor cannot start the game or add bots", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const v = connect(room);
  await v.open();
  await v.until((m) => m.type === "state", "visitor state");
  v.send({ type: "start-game" });
  const err = await v.until((m) => m.type === "error", "visitor refusal");
  assert.match(err.message, /sit down/i);
  v.send({ type: "add-bot" });
  await v.until((m) => m.type === "error", "visitor refusal 2", v.messages.length);
  assert.equal(a.lastState().players.length, 1);
  assert.equal(a.lastState().phase, "lobby");
  a.ws.close();
  v.ws.close();
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

test("a displaced socket cannot inject a bid under the seat it lost", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  const a2 = connect(room);
  await a2.open();
  const beforeA2 = a2.messages.length;
  a2.send({ type: "resume", resumeToken: a.token });
  const joined = await a2.until((m) => m.type === "joined", "resumed", beforeA2);
  // The old socket may already be closed with 4000 by now; ws throws on send
  // after close, and a closed displaced socket is also a pass here.
  try {
    a.send({ type: "bid", auction: 1, amount: 99, locked: true });
  } catch {
    // closed already; nothing to assert further on this socket
  }
  const beforeState = a2.messages.length;
  // A harmless message forces a fresh state so any bid the old socket managed
  // to sneak in would show up on it.
  a2.send({ type: "bid", auction: 1, amount: 0, locked: false });
  const s = await a2.until((m) => m.type === "state" && m.you === joined.playerId, "state after the race", beforeState);
  assert.ok(!s.myBid || s.myBid.amount !== 99);
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
  assert.equal(s.playerCount, 0);
  c.ws.close();
});

test("a visitor stranded when the room is deleted still gets seated on a later join", async () => {
  const room = uniqueRoom();
  const v = connect(room);
  await v.open();
  await v.until((m) => m.type === "state", "visitor pre-state");
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  a.send({ type: "start-game" });
  await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  a.ws.close();
  b.ws.close();
  await sleep(TTL_MS * 3);
  const before = v.messages.length;
  v.send({ type: "join", name: "Cat" });
  const joined = await v.until((m) => m.type === "joined", "Cat joined", before);
  const s = await v.until((m) => m.type === "state" && m.you === joined.playerId, "Cat seated state", before);
  assert.equal(s.phase, "lobby");
  assert.equal(s.players.length, 1);
  assert.equal(s.players[0].id, joined.playerId);
  v.ws.close();
});

test("bidding round-trips: locked bids resolve, reveal, then auction 2", async () => {
  const room = uniqueRoom();
  const a = await join(room, "Ann");
  const b = await join(room, "Ben");
  const beforeAddBot = a.messages.length;
  a.send({ type: "add-bot" });
  await a.until((m) => m.type === "state" && m.players.length === 3, "bot added", beforeAddBot);
  a.send({ type: "start-game" });
  const start = await a.until((m) => m.type === "state" && m.phase === "bidding", "bidding");
  assert.equal(start.hand.length, 7);
  assert.equal(start.cardsRemaining, 20);
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
