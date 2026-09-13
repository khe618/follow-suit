# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this
file, so it is the single source of truth for both Claude Code and Codex.

## What this is

Follow Suit: a multiplayer card auction that teaches the winner's curse. Players
bid for the right to bet that the next card flipped matches the suit of the
current one; the highest bidder buys from everyone else at their bid. Express 5
plus raw WebSockets (`ws`), vanilla JS in the browser, server-side bots. The
design spec is `docs/superpowers/specs/2026-09-12-follow-suit-design.md` and the
rules are stated there in full.

## Running locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # node --test, no watch mode
```

No build step, no bundler, no linter. Edit and reload. `server.js` reads
`public/index.html` once at startup, so restart after editing it.

Environment variables (defaults in `server.js`): `PORT`, `BID_MS`,
`REVEAL_BIDS_MS`, `REVEAL_CARD_MS`, `RESUME_TTL_MS`.

## Architecture

- `public/game-core.js`: rules shared by server and browser (UMD, dependency-free).
  Deal, settlement, ranking, constants.
- `lib/fair-value.js`: exact Bayesian probability of the next suit. Server only;
  never serve it, because estimating fair value is the skill the game teaches.
- `lib/bots.js`: bot names, profiles, and bidding around fair value.
- `lib/game.js`: the per-room state machine (lobby, bidding, reveal, results)
  with injected clock and timers. One pending phase timer per room, guarded by
  match id and auction index.
- `lib/rooms.js`: rooms, seats, resume tokens, host, seat expiry, room deletion.
  Resume adopts a seat unconditionally and closes the displaced socket with 4000.
- `lib/snapshot.js`: the per-recipient `state` message. The secrecy boundary.
- `server.js`: env config, routes, WebSocket wiring, broadcast.
- `public/client.js`: renders whatever `state` last arrived. Server-authoritative.

## Testing

`tests/server.test.js` spawns the real server and drives real sockets; every
other test is pure with the fake clock in `tests/helpers/clock.js`. The
fair-value test runs a Monte Carlo and takes a few seconds.

## Deploy

Render web service via `render.yaml`, auto-deploy from `main`.
