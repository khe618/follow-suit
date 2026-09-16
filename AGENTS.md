# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this
file, so it is the single source of truth for both Claude Code and Codex.

## What this is

Follow Suit: a multiplayer card auction that teaches the winner's curse. Each
round players bid for the suit of the card on top; the highest bidder buys it
from every other player, paying each seller that seller's own bid, and every
later flip of that suit pays the owner 10 per seller. The last five cards are
never auctioned and pay double. Every card is dealt as an independent uniform
draw over the four suits, and the deck is exactly the dealt hands reshuffled.
Express 5 plus raw WebSockets (`ws`), vanilla
JS in the browser, server-side bots. The rules are
in `docs/superpowers/specs/2026-09-13-suit-stakes-design.md` (which amends
`2026-09-12-follow-suit-design.md`), as further amended by
`docs/superpowers/specs/2026-09-15-equal-probability-deal-design.md` (the
equal-probability deal, the dock opening at 0, the four-colour deck); the client (poker-table layout, dealing
phase, animations, sound effects, tutorial) is in
`docs/superpowers/specs/2026-09-13-game-feel-design.md`, as amended by
`docs/superpowers/specs/2026-09-13-table-ui-overhaul-design.md` (fitted seat
pods, owned-card stacks, the log sheet, the results recap, the bonus round).

## Running locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # node --test, no watch mode
```

No build step, no bundler, no linter. Edit and reload. `server.js` reads
`public/index.html` once at startup, so restart after editing it. `/how-to-play`
serves the same shell (the tutorial opens as a dialog over it).

Environment variables (defaults in `server.js`): `PORT`, `DEAL_MS`, `BID_MS`,
`REVEAL_BIDS_MS`, `REVEAL_CARD_MS`, `RESUME_TTL_MS`, `HEARTBEAT_MS`.

## Architecture

- `public/game-core.js`: rules shared by server and browser (UMD, dependency-free).
  Deal, settlement, ranking, constants. There is no card pool and no per-suit
  cap: `deal` draws every card independently and uniformly, so a suit may run
  to any count and one player's hand says nothing about another's.
- `public/seat-layout.js`, `public/transitions.js`, `public/sequencer.js`: pure
  UMD helpers for the browser, unit-tested in Node. Seat geometry (including
  `fitRadii`, which fits the seat ring to the felt actually on screen), the
  snapshot-to-animation planner (plus leg baselines and payment streams),
  and the generation-based cancellable sequencer.
- `lib/fair-value.js`: exact Bayesian probability of the next suit — multinomial
  over the unseen hands, hypergeometric over the flips. Server only; never serve
  it, and do not reintroduce a client-side estimate (the dock's bid opens at 0
  for the same reason), because estimating fair value is the skill the game
  teaches.
- `lib/bots.js`: random bot names, profiles, and bidding around fair value.
- `lib/game.js`: the per-room state machine (lobby, dealing, bidding, reveal,
  results) with injected clock and timers. One pending phase timer per room,
  guarded by match id and auction index. `dealing` is a pure pause so clients
  can animate the deal.
- `lib/rooms.js`: rooms, seats, resume tokens, seat expiry, room deletion. There
  is no host: any seated player may add or remove bots, deal, or play again.
  Resume adopts a seat unconditionally and closes the displaced socket with 4000.
- `lib/snapshot.js`: the per-recipient `state` message. The secrecy boundary.
- `server.js`: env config, routes, WebSocket wiring, broadcast, `quick-play`.
- `public/js/`: ES modules, no bundler. `app.js` routes in-document between the
  landing, join screen, and table; `net.js` owns the socket; `table.js` renders
  the state layer and dispatches timelines; `lobby.js` holds the lobby-only
  parts of the table (empty seats, Deal, Invite); `landing.js` is the landing
  and join screens; `timelines.js` and `anim.js` own the sprite layer;
  `audio.js` synthesizes the sound effects; `tutorial.js` is the how-to-play
  dialog. The design is in
  `docs/superpowers/specs/2026-09-13-game-feel-design.md` and
  `docs/superpowers/specs/2026-09-13-table-ui-overhaul-design.md`.

  Two rules the client depends on. The last five cards are the **bonus
  round**, and it begins at the *final auction* (`cardsRemaining <=
  RUNOUT_CARDS`), not at the first no-auction flip. Nothing about doubling
  may be derived from a history entry's `runout` flag: the first doubled card
  is the payoff flip of that final auction, whose entry has `runout: false`.
  Derive it from card position instead.

## Testing

`tests/server.test.js` spawns the real server and drives real sockets; every
other test is pure with the fake clock in `tests/helpers/clock.js`. The
fair-value test runs a Monte Carlo and takes a few seconds.

## Deploy

Render web service via `render.yaml`, auto-deploy from `main`.
