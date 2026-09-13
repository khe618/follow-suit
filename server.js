"use strict";
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const { createGame } = require("./lib/game.js");
const { createRegistry } = require("./lib/rooms.js");
const { buildState } = require("./lib/snapshot.js");
const { BOT_NAMES } = require("./lib/bots.js");

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PORT = envInt("PORT", 3000);
const CONFIG = {
  bidMs: envInt("BID_MS", 20000),
  revealBidsMs: envInt("REVEAL_BIDS_MS", 2500),
  revealCardMs: envInt("REVEAL_CARD_MS", 3000)
};
const RESUME_TTL_MS = envInt("RESUME_TTL_MS", 10 * 60 * 1000);

// Crash resistance: one bad socket message must not take every room down.
// Each message and timer is also wrapped individually (see below), so this is
// the last line, not the first.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException (continuing):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection (continuing):", reason);
});

const registry = createRegistry({
  resumeTtlMs: RESUME_TTL_MS,
  createGame: ({ onChange }) => createGame({ config: CONFIG, onChange }),
  onChange: broadcast
});

function send(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error("[server] send failed:", err);
  }
}

function broadcast(room) {
  for (const seat of room.seats.values()) {
    if (seat.ws) send(seat.ws, buildState(room, seat.id));
  }
  for (const ws of room.visitors) send(ws, buildState(room, null));
}

function normalizeName(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function isReservedName(name) {
  const lower = name.toLowerCase();
  return BOT_NAMES.some((botName) => botName.toLowerCase() === lower);
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/api/new-room", (_req, res) => {
  const room = registry.reserveCode();
  res.set("Cache-Control", "no-store");
  if (!room) {
    res.status(503).json({ ok: false, error: "no_room_available" });
    return;
  }
  res.json({ ok: true, room });
});

app.get("/how-to-play", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "how-to-play.html"));
});

app.get(/^\/[a-z]{4}$/, (_req, res) => res.type("html").send(INDEX_HTML));

// Unknown browser navigations go home; everything else (assets, API, fetches
// that accept */*) gets the JSON 404 below. Checking the Accept header for
// text/html directly avoids req.accepts() preferring "html" for */*.
app.use((req, res, next) => {
  const wantsHtml = /text\/html/i.test(req.headers.accept || "");
  if (req.method === "GET" && wantsHtml && !req.path.startsWith("/api/")) {
    res.redirect(302, "/");
    return;
  }
  next();
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const code = String(url.searchParams.get("room") || "").toLowerCase();
  if (!registry.isValidCode(code)) {
    ws.close(1008, "room_required");
    return;
  }
  const room = registry.getOrCreate(code);
  room.visitors.add(ws);
  let seat = null;
  send(ws, buildState(room, null));

  function joinedMessage() {
    send(ws, { type: "joined", playerId: seat.id, resumeToken: seat.resumeToken });
  }

  function requireHost() {
    if (seat && room.hostId() === seat.id) return true;
    send(ws, { type: "error", message: "Only the host can do that." });
    return false;
  }

  function handle(msg) {
    switch (msg.type) {
      case "resume": {
        if (seat) return;
        const existing = registry.resume(room, String(msg.resumeToken || ""), ws);
        if (existing) {
          seat = existing;
          joinedMessage();
        } else if (room.game.phase !== "lobby") {
          send(ws, { type: "error", code: "game_in_progress", message: "Game in progress, try again after this game." });
        }
        return;
      }
      case "join": {
        if (seat) return;
        const existing = registry.resume(room, String(msg.resumeToken || ""), ws);
        if (existing) {
          seat = existing;
          joinedMessage();
          return;
        }
        const name = normalizeName(msg.name);
        if (!name) {
          send(ws, { type: "error", message: "Please enter a name." });
          return;
        }
        if (isReservedName(name)) {
          send(ws, { type: "error", message: "That name is reserved for bots." });
          return;
        }
        const result = registry.join(room, { name, ws });
        if (!result.ok) {
          const message = result.error === "game_in_progress" ? "Game in progress, try again after this game." : "That room is full.";
          send(ws, { type: "error", code: result.error, message });
          return;
        }
        seat = result.seat;
        joinedMessage();
        return;
      }
      case "add-bot": {
        if (!requireHost()) return;
        const result = registry.addBot(room);
        if (!result.ok) send(ws, { type: "error", message: result.error === "room_full" ? "The room is full." : "Bots can only be added in the lobby." });
        return;
      }
      case "remove-bot": {
        if (!requireHost()) return;
        if (!registry.removeBot(room, String(msg.playerId || ""))) send(ws, { type: "error", message: "Bots can only be removed in the lobby." });
        return;
      }
      case "start-game": {
        if (!requireHost()) return;
        const result = registry.startGame(room);
        if (!result.ok) send(ws, { type: "error", message: result.error === "need_players" ? "Need at least two players." : "The game has already started." });
        return;
      }
      case "bid": {
        if (!seat) return;
        // Stale or out-of-phase bids are ignored on purpose (spec 4.4): a
        // debounced bid that lands after the deadline is not a user error.
        const result = room.game.bid(seat.id, { auction: Number(msg.auction), amount: Number(msg.amount), locked: Boolean(msg.locked) });
        if (!result.ok && result.error === "bad_amount") send(ws, { type: "error", message: "Bids are whole numbers from 0 to 100." });
        return;
      }
      case "return-to-lobby": {
        if (!requireHost()) return;
        if (!registry.returnToLobby(room)) send(ws, { type: "error", message: "Play again is only available on the results screen." });
        return;
      }
      default:
        return;
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    // A displaced socket must not act on a seat it no longer owns.
    if (seat && seat.ws !== ws) return;
    try {
      handle(msg);
    } catch (err) {
      console.error(`[server] room ${room.code} message ${msg.type} failed:`, err);
    }
    if (registry.get(room.code) === room) broadcast(room);
  });

  ws.on("close", () => {
    try {
      if (seat) {
        if (seat.ws !== ws) return;
        registry.disconnect(room, seat, ws);
        if (registry.get(room.code) === room) broadcast(room);
      } else {
        registry.leaveVisitor(room, ws);
      }
    } catch (err) {
      console.error("[server] close handler failed:", err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Follow Suit server running at http://localhost:${PORT}`);
});
