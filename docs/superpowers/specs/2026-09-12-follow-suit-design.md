# Follow Suit — design spec

Date: 2026-09-12
Status: draft for review

## 1. What this is

Follow Suit is a browser-based multiplayer card game that teaches three trading ideas by making players feel them: asymmetric information, the winner's curse, and price discovery. Players bid for the right to bet that the next card flipped will match the suit of the current one. The highest bidder buys that bet from every other player at their own bid, so every auction forces the field into a trade at one price.

It is a standalone website in its own repository at `C:\dev\follow-suit`, built like `emoji/`: Express 5 plus raw WebSockets on the server, vanilla JS in the browser, no build step. It ships with server-side bot players so one person can play a full game alone.

Out of scope for v1: accounts, persistence of results, a fair-value debrief, offline solo mode, spectators, native apps, position sizing.

## 2. Game rules

### 2.1 Materials

- A **pool** of 40 cards: 10 each of spades, hearts, diamonds, clubs. Cards have no rank. A card is only its suit.
- Two to six players. Bots count as players.
- Scores are points, starting at 0. Scores may go negative. There is no bankroll, no bid cap other than the 0 to 100 range, and no elimination.

### 2.2 Hand size and deck in play

Each player is dealt `n` cards from the pool, where `n` depends on the player count so that games are roughly the same length:

| Players | Hand size `n` | Deck in play `(P+1)·n` | Auctions |
| --- | --- | --- | --- |
| 2 | 8 | 24 | 23 |
| 3 | 6 | 24 | 23 |
| 4 | 4 | 20 | 19 |
| 5 | 4 | 24 | 23 |
| 6 | 3 | 21 | 20 |

The pool is larger than the deck in play on purpose. If the deck were the whole pool, everyone would know its composition and private hands would carry no information.

### 2.3 Dealing

1. Shuffle the pool. Deal `n` cards to each player. Each player privately sees their own cards.
2. Take `n` more cards from the pool as the **hidden cards**. Nobody sees them.
3. Collect all hands plus the hidden cards, shuffle them together, and place them face down as the **deck**. The rest of the pool is set aside unseen and never used.
4. Flip the top card of the deck face up. It is the first **reference card**.

Because cards have no rank, what a player learns from their hand is a suit count. The client shows the hand as cards anyway, because that is what people expect to look at.

### 2.4 An auction

One auction happens for every card in the deck after the first. Auction `k` concerns deck card `k+1`, and the reference card is deck card `k`.

1. **Bidding.** Every player submits a sealed integer bid from 0 to 100. A bid is the price you will pay, per counterparty, for the right to be paid 100 per counterparty if the next card's suit matches the reference card's suit. Bidding ends when every player has locked a bid or when the timer expires, whichever is first. A player with no submitted bid at the deadline bids 0.
2. **Reveal bids.** All bids are shown with names. The highest bid `x` wins. Every player with a bid equal to `x` is a **buyer**. Everyone else is a **seller**.
3. **Flip.** The next card is flipped and becomes the new reference card.
4. **Settle.** Each buyer pays `x` to each seller. If the flipped card matches the old reference suit, each seller pays 100 to each buyer.

Settlement per player, with `B` buyers, `S` sellers, price `x`, and `m = 1` on a match else `0`:

- buyer: `−x·|S| + 100·m·|S|`
- seller: `+x·|B| − 100·m·|B|`

Total is zero across the table.

Worked examples, which the settlement tests assert exactly:

| Players | Bids | Buyers | Price | Match | Mismatch |
| --- | --- | --- | --- | --- | --- |
| 3 | 80, 50, 20 | 1 | 80 | +40, −20, −20 | −160, +80, +80 |
| 4 | 60, 60, 30, 10 | 2 (tie) | 60 | +80, +80, −80, −80 | −120, −120, +120, +120 |
| 3 | 5, 0, 0 | 1 | 5 | +190, −95, −95 | −10, +5, +5 |
| 2 | 0, 0 | all tie | 0 | void: 0, 0 | void: 0, 0 |

If every player ties for the highest bid there are no sellers, so no trade happens. The auction is recorded as **void**: the history entry keeps the bids and price, has an empty buyer list, all-zero deltas, and still records the flipped card and whether it matched. The game continues with the flip.

### 2.5 Game end

The game ends after the last deck card is flipped and settled. Final standings use competition ranking by score: equal scores share a rank and the next rank is skipped (1, 1, 3). Every player's initial hand is revealed at the end.

### 2.6 What is public during play

- The reference card, every card flipped so far in order, and per-suit counts of flipped cards.
- The number of cards remaining in the deck and the number of hidden cards.
- Each player's score and, during bidding, whether each player has locked.
- After each auction: every bid, the buyers, the price, the flipped card, and each player's score change.

Private: each player's own hand. Never shown: the set-aside remainder of the pool.

## 3. Product surface

### 3.1 Routes

| Route | Serves |
| --- | --- |
| `/` | Landing: enter a name, create a room, or join by 4-letter code |
| `/abcd` (any 4 lowercase letters) | The app shell for that room |
| `/api/new-room` | JSON `{ room }` with an unused 4-letter code |
| `/how-to-play` | Static rules page |
| anything else | HTML requests redirect to `/`; other requests get a JSON 404 |

### 3.2 Views

The client is one page with four views: **name**, **lobby**, **game**, **results**.

**Name.** Name input, remembered in `localStorage`. Creating a room calls `/api/new-room` and navigates to `/abcd`. Joining by code navigates to `/abcd`. On a room URL, the name view shows the room code and a single Join button.

**Lobby.** Player list with bot badges, a copyable room link, and the rules in one paragraph with a link to `/how-to-play`. The host sees Add bot, Remove bot, and Start. Start is enabled at two or more seats. The host is the earliest-joined connected human. If the host disconnects, the next earliest connected human becomes host.

**Game.** Laid out for a phone first:

- Top: the reference card, large. Beside it the deck count and a strip of every flipped card so far in order, plus per-suit flipped counts.
- Middle: the player's own hand as cards, grouped by suit.
- Scoreboard: every player with score and a lock indicator during bidding.
- Bid control: a number input and a slider, both clamped to 0 to 100, with a Lock button and the countdown. Changing the value after locking unlocks it. The last submitted value is what counts at the deadline, locked or not.
- Reveal panel: after bidding closes, the bids appear sorted with buyers highlighted, then the card flips, then score deltas animate onto the scoreboard, then the next auction begins.

**Results.** Final standings, each player's revealed initial hand, and a scrollable table of every auction: reference, bids, buyers, price, flipped card, and deltas. Host sees Play again, which returns the room to the lobby with seats kept and scores reset.

A `join` is accepted only while the room is in the lobby phase, or when it carries a resume token that matches a seat in that room in any phase. In bidding, reveal, or results, a `join` without a matching token is refused with "Game in progress, try again after this game." An invalid or expired token in the lobby is treated as a fresh join; in any other phase it is refused the same way.

### 3.3 Bots

The host adds bots in the lobby, up to the six-seat cap, so a room can hold up to five bots. Bots live entirely on the server and hold no socket. Each bot has a unique name from a fixed list of five and a bidding profile assigned in order of addition, cycling back to the first profile for the fifth bot:

| Profile | Shade | Noise σ |
| --- | --- | --- |
| Careful | 0.85 | 2 |
| Fair | 0.93 | 2 |
| Keen | 1.00 | 3 |
| Wild | 1.08 | 6 |

Bot bid = `clamp(round(fair · shade + N(0, σ)), 0, 100)`, where `fair` is 100 times the bot's posterior probability of a match, computed from its own hand and the public flips (section 4.6). Bots do not read other players' bids in v1. A bot submits its bid, locked, at a random moment between 1.5 s and `min(6 s, BID_MS / 2)` into the bidding window, so a short configured window still gets every bot's bid before the deadline. Bots are removed when their room is deleted.

The profiles are deliberately spread around fair value so a table of bots shows a realistic winner's curse: Wild wins more auctions and loses points doing it.

## 4. Architecture

### 4.1 Stack and repository layout

Node 22, Express 5, `ws` 8. No bundler, no framework, no linter. Tests use `node --test`.

```
follow-suit/
├── server.js                  # HTTP + WebSocket wiring, static files, routes
├── lib/
│   ├── rooms.js               # room registry, seats, host, resume tokens, expiry
│   ├── game.js                # game state machine and timers for one room
│   ├── fair-value.js          # exact posterior P(next suit) — server only
│   └── bots.js                # bot seats and bidding
├── public/
│   ├── game-core.js           # shared rules: constants, hand sizes, deal, settle
│   ├── index.html             # app shell
│   ├── client.js              # views, WebSocket client, rendering
│   ├── styles.css
│   └── how-to-play.html
├── tests/
├── docs/superpowers/specs/
├── package.json
├── render.yaml
├── AGENTS.md, CLAUDE.md, LEARNINGS.md, IDEAS.md
```

`public/game-core.js` is loaded by the browser as a plain script and `require`d by the server, so it must be dependency-free and work under both loaders (same pattern as `emoji/public/game-core.js`). It holds everything both sides must agree on: suit list, pool composition, the hand-size table, `deal(playerCount, rng)`, and `settle(bids, matched)`.

`lib/fair-value.js` and `lib/bots.js` are never served to the browser. A player who opens devtools should not find a fair-value calculator. Estimating fair value is the skill the game teaches.

### 4.2 Authority

Multiplayer is fully server-authoritative. The client sends intents (`bid`, `start-game`) and renders whatever state arrives. It computes nothing about the game except the countdown display.

### 4.3 Rooms and seats (`lib/rooms.js`)

- Room codes are 4 random lowercase letters. `/api/new-room` picks a code that is neither an existing room nor a reserved code, and reserves it for 60 seconds. A room object is created on the first `join` for its code. Reservations only matter for the window between issuing a code and the creator's first join; two callers can never be handed the same code inside that window.
- A seat is a player in a room: `{ id, name, isBot, connected, resumeToken, ws, expiresAt }`. Seat ids are `p1`, `p2`, ... per room and are never reused within a room.
- Joining creates a seat and returns a resume token. The client stores it in `localStorage` keyed by room code.
- **Roster freeze.** From `start-game` until the room returns to the lobby, the set of seats does not change. A human who disconnects mid-game keeps their seat, hand, score, and history entries for the whole game no matter how long they are gone.
- **Seat expiry** applies only in the lobby and results phases: a disconnected human seat is removed `RESUME_TTL_MS` (default 10 minutes) after its disconnect, or immediately on returning to the lobby if it is already past due. A seat that expired during results is dropped when the host presses Play again.
- **Room deletion.** A room is deleted, with its bots and every timer cleared, when it has had no connected human for `RESUME_TTL_MS`, in any phase. This is the one way a game in progress ends early.
- **Resume adopts the seat unconditionally.** The newest connection presenting a seat's resume token takes the seat. The displaced socket is closed with code 4000 and the client must not auto-reconnect on that code. The `message` and `close` handlers bail when `client.ws !== ws` so a displaced socket cannot bid for, or mark disconnected, a seat it no longer owns. This is the fix `emoji/LEARNINGS.md` (2026-08-31) records; the `connected` flag is a lagging indicator, never a lock.

### 4.4 Game state machine (`lib/game.js`)

One instance per room. Phases:

```
lobby → bidding → reveal(bids) → reveal(card) → bidding → ... → results
                                                  └──────────────┘ (host: Play again → lobby)
```

State held per room:

```
phase: 'lobby' | 'bidding' | 'reveal' | 'results'
matchId                                 // increments on every start-game
revealStep: 'bids' | 'card'            // only in reveal
players: [{ id, name, isBot, connected, score, hand }]   // hand server-only until results
deck: ['hearts', ...]                   // server-only
flipIndex                               // number of cards flipped so far
auction: { index, deadlineAt, bids: { [playerId]: { amount, locked } } }
history: [{ index, reference, bids, buyers, price, flipped, matched, deltas, void }]
timer: { handle, matchId, auctionIndex, kind }   // at most one pending timer per room
```

Transitions:

- `start-game` (host, ≥2 seats, phase lobby): **full match reset** as one step: increment `matchId`, cancel any pending timer, clear `history`, `auction`, `flipIndex`, `revealStep`, and every score and hand; then `deal`, flip card 1, and start auction 1.
- **Start auction:** set `deadlineAt = now + BID_MS` (default 20 s), clear bids, schedule bot bids, arm the deadline timer, broadcast.
- **Bid** (phase bidding, `auction.index` matches, amount integer 0 to 100, from a connected seat that owns its socket): store `{ amount, locked }`. Then check the all-locked condition: every bot has bid, every connected human has `locked`, and every disconnected human counts as locked with whatever amount they stored before disconnecting, or 0 if none. If it holds, resolve now.
- **Deadline or all locked → resolve:** cancel the deadline timer if it has not fired. Missing bids become 0. Compute buyers and price, push a history entry without the flip yet, enter `reveal/bids`, broadcast, arm the bids timer. After `REVEAL_BIDS_MS` (default 2.5 s): flip the next card, `settle`, complete the history entry, apply deltas, enter `reveal/card`, broadcast, arm the card timer. After `REVEAL_CARD_MS` (default 3 s): if cards remain, start the next auction; else enter `results` with hands revealed.
- `return-to-lobby` (host, phase results): phase lobby, drop expired seats, and clear scores, hands, history, and auction state. `start-game` performs the same reset again, so stale state cannot survive either path.

**Timer discipline.** There is at most one pending game timer per room. Every timer callback carries the `matchId` and `auctionIndex` it was armed for and returns without effect if either no longer matches the room's current values. Resolution is idempotent: the deadline firing after an all-locked resolution, or a final lock arriving in the same tick as the deadline, settles the auction exactly once. All timers are cleared on room deletion.

Disconnecting does not erase a stored bid. A player who resumes before resolution sees their stored amount and lock state in the bid control. A bid for any auction index other than the current one, or arriving in any phase but bidding, is ignored. The deck is shuffled with `crypto.randomInt`.

### 4.5 Wire protocol

JSON messages over one WebSocket per client.

Client → server:

| type | fields | notes |
| --- | --- | --- |
| `join` | `room, name, resumeToken?` | new seat, or adopt if token matches |
| `resume` | `room, resumeToken` | adopt seat without a name |
| `add-bot` | | host, lobby only |
| `remove-bot` | `playerId` | host, lobby only |
| `start-game` | | host |
| `bid` | `auction, amount, locked` | sent on every change, debounced 150 ms client-side |
| `return-to-lobby` | | host, results only |

Server → client:

| type | fields |
| --- | --- |
| `joined` | `playerId, resumeToken` |
| `state` | full per-client snapshot, described below |
| `error` | `message` |

`state` is rebuilt per recipient on every broadcast and contains: room code, phase, `matchId`, `revealStep`, `remainingMs` for the current deadline, host id, players (id, name, isBot, connected, score, `locked` during bidding), reference card, flipped cards in order, cards remaining, hidden-card count, the recipient's own hand, the recipient's own current bid and lock state, the current auction index, the full public history so far, and all hands when the phase is results. The history includes the in-progress auction's entry only once its bids are revealed. A client that reloads mid-game therefore sees exactly the same public record as one that stayed connected.

Never included for a recipient, in any phase before results: the deck, other players' hands, other players' bid amounts for the current auction before reveal, or any bot's fair-value input.

The client counts the timer down locally from `remainingMs` at receipt rather than comparing clocks. The countdown is display only. The server enforces the deadline with its own timer and rejects bids by phase and auction index, never by comparing client and server clocks.

### 4.6 Fair value (`lib/fair-value.js`)

From one player's point of view, after seeing their hand `H` (a per-suit count summing to `n`), the rest of the deck `U` is a uniformly random `P·n`-subset of the pool with `H` removed. The deck `D = H + U` is then flipped in uniformly random order. Given the flips so far `F` (per-suit counts, `k` cards), the probability the next card is suit `s` is

```
q(U) = MVH(U ; pool − H) · MVH(F ; D)          with D = H + U
w(U) = q(U) / Σ_V q(V)
P(next = s | H, F) = Σ_U  w(U) · (D_s − F_s) / (|D| − k)
```

where `MVH` is the multivariate hypergeometric probability and both sums run over every composition `U` of `P·n` cards into four suits with `U_s ≤ 10 − H_s` and `D_s ≥ F_s`. There are at most a few thousand compositions, so the exact sum is cheap. Compute `log q` with precomputed log-binomials and normalise with log-sum-exp so the weights stay well-conditioned.

This derivation was checked before the spec was finalised: an enumeration of the formula agrees with a Monte Carlo of the exact dealing procedure to within sampling noise, including a hand with six of one suit.

Fair value in points is `100 · P(next = reference suit)`.

This module is pure, synchronous, and unit-tested against a Monte Carlo simulation of the actual dealing procedure.

### 4.7 Configuration

Environment variables, read once at startup in `server.js`, each with the default above: `PORT` (3000), `BID_MS`, `REVEAL_BIDS_MS`, `REVEAL_CARD_MS`, `RESUME_TTL_MS`. Player cap is 6 and is a constant in `game-core.js`.

## 5. Error handling

- Malformed messages, unknown types, or messages from a socket that no longer owns its seat are ignored; rule violations (non-host starting, bid out of range, action in the wrong phase, join during a game) get an `error` reply and no state change.
- A player who disconnects mid-game keeps their seat, hand, and score for the rest of the game (roster freeze, section 4.3). For any auction they miss entirely their bid is 0; a bid they stored before dropping still stands. The game never waits for a disconnected player.
- If every human in a room is gone for `RESUME_TTL_MS`, the room and its bots are deleted and every game timer is cleared.
- Every socket message handler and every game timer callback runs inside its own try/catch. A throw is logged with the room code and the state change for that event is abandoned; the room's phase, scores, and history are only mutated after validation succeeds, so a failed event leaves the room as it was. Process-level `uncaughtException` and `unhandledRejection` are additionally logged and not fatal, as in emoji and traderprep, so one bad room cannot take every other room down. Room state is in memory and is lost on restart; v1 accepts that.
- The client reconnects with backoff on any close except code 4000, and re-sends `resume` on reconnect. While disconnected it shows a banner and disables the bid control.

## 6. Testing

All tests run with `npm test` (`node --test`).

- `game-core`: hand-size table matches section 2.2; `deal` produces the right deck size and hands of size `n`, the deck's per-suit counts equal the sum of all hands plus the hidden cards, and no suit exceeds 10 across hands, hidden cards, and the set-aside remainder combined; `settle` reproduces every worked example in section 2.4 exactly, is zero-sum for every buyer/seller split, and returns all-zero deltas with an empty buyer list for a void auction.
- `fair-value`: sums to 1 over suits; with no flips and a uniform hand equals the pool prior; a hand heavy in one suit raises that suit; flipping a suit lowers it; agrees with a Monte Carlo of the real dealing procedure within 0.005 for a handful of fixed cases, with the Monte Carlo conditioning by rejection on both the hand and the flips.
- `game` (state machine, with injected clock and rng): lobby → bidding on start; missing bids resolve to 0 at the deadline; all-locked resolves early and the old deadline firing afterwards has no effect; a lock and the deadline in the same tick settle once; a disconnected player's stored bid survives and counts as locked; stale-auction bids are ignored; reveal steps advance on the injected clock; last auction leads to results with hands revealed; two consecutive full games in one room share no state (history, flips, scores, timers); a void auction produces the specified history entry.
- `snapshot` secrecy: for every phase, including a resumed client mid-bidding, the per-recipient `state` contains the recipient's own hand and bid, contains the full public history, and does not contain the deck, any other hand, any other current bid amount before reveal, or any fair-value figure. Asserted as both required and forbidden keys.
- `bots`: bids are integers in range, always locked, land inside the bidding window for both the default and a 4-second `BID_MS`, and profile shading is applied; five bots get five distinct names.
- `rooms` and resume: spawns the real server and drives real `ws` clients, as `emoji/tests/server-resume.test.js` does. Covers join, join refused during a game, resume with the old socket left open (the case `terminate()` does not reproduce), host handoff, seat retention through a whole game while disconnected, seat expiry in the lobby, and room deletion after TTL.
- Manual pass in Chrome before calling it done: two tabs plus two bots, one full game on a phone-width viewport, a mid-game reload to check resume, and a deliberate deadline miss.

## 7. Deployment

Render web service defined by `render.yaml` in the repo, auto-deploying from `main`, `npm start`, health check on `/`. Render supports WebSockets on its web services. The free tier sleeps after idle and forgets rooms on wake; that is acceptable for launch and the starter tier removes it. A custom domain can be attached later. The DigitalOcean droplet that serves emoji is the fallback if Render proves awkward; nothing in the repo assumes either host.

## 8. Decisions log

- Standalone repo instead of a TraderPrep exercise: chosen by the owner for independence.
- No bankroll or elimination: scores are just a running tally, so the game can never stall on a player who cannot pay.
- Ties make every top bidder a buyer, and an all-way tie is void.
- Bids are public after every auction so that bids act as signals and price discovery has something to work with.
- Bots use only their hand and the flips, not other players' bids. Reading bids is a later improvement.
- No fair-value debrief in v1, and no fair-value code in the browser. Deferred, not rejected.
- Hidden cards stay in the design even though the pool already exceeds the deck. They keep the endgame from being fully countable by pooling everyone's bids.
