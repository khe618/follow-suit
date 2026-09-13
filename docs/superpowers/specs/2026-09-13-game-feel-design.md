# Follow Suit — game feel overhaul

Date: 2026-09-13
Status: implemented 2026-09-13
Builds on: `2026-09-12-follow-suit-design.md` (the rules and server architecture there stay in force except where this spec amends them)

## 1. Goal

Make Follow Suit feel like sitting at a card table, not reading a website. Same rules, same server authority, same secrecy boundary. What changes:

- The game screen becomes a **poker table**: players sit around an oval, the deck and reference card sit in the middle, your hand is fanned in front of you.
- **Animations** carry the game's events: the deal, the shuffle-back, bids being revealed, the card flip, and chips flying between seats when players pay each other.
- **Sound effects**, synthesized in the browser with the Web Audio API. No audio files, and no background music (dropped by the owner during implementation).
- **Far less text.** Icons, numbers, and motion replace sentences. The rules leave the lobby and live in an interactive tutorial.
- **Simpler entry.** No room-code box on the landing page. Quick play seats you with bots at once; Play with friends gives you a link to share.
- **No host.** Anyone seated at the table can add or remove bots, deal, and play again.
- **Bots get random human-style names** with a small bot marker.

Out of scope, unchanged from v1: accounts, persistence, spectators, a fair-value debrief, native apps. Also out of scope here: background music of any kind, avatar pictures, haptics, chat, emotes.

## 2. Server changes

The server changes are small and come first, because the client animations depend on them.

### 2.1 A `dealing` phase

Today `start` flips card 1 and opens auction 1 in the same tick, so the client has no window in which to show the deal. A new phase sits between lobby and the first auction:

```
lobby → dealing → bidding → reveal(bids) → reveal(card) → bidding → … → results
                                                          └──────────────┘ (anyone: Play again → lobby)
```

- `start` performs the full match reset as before, deals, sets `flipIndex = 1`, then enters `dealing` with `dealEndsAt = now + DEAL_MS` and arms one phase timer (`kind: "deal"`) that calls `startAuction(1)`. The timer carries `matchId` and is subject to the same guard as every other phase timer.
- During `dealing`: no bot bids are scheduled; `bid` returns `not_bidding`; `setConnected` only records the flag. `returnToLobby` still requires `results`.
- `remainingMs()` returns the time left in the current phase for both `dealing` and `bidding` (0 otherwise).
- New config key `dealMs` (env `DEAL_MS`, default 7000). Both reveal steps get more room for the payment animations: `revealBidsMs` default rises from 2500 to 3000 and `revealCardMs` from 3000 to 4500 (the flipped card rests beside the old reference for a comparison beat before taking the slot).
- The deal timer is armed with the existing `armTimer`; with `auction === null` its captured auction index is 0, and the timer-identity and `matchId` guards protect it as they do every other phase timer. `destroy` and `resetMatch` clear it like any other.

### 2.2 No host

`hostId` is removed from `lib/rooms.js` and from the `state` message. Any **seated, connected human whose socket owns its seat** may send `add-bot`, `remove-bot`, `start-game`, and `return-to-lobby`. Visitors and displaced sockets still cannot. Room deletion already keys off "no connected human", not the host, so nothing else moves.

### 2.3 Random bot names

`lib/bots.js` replaces the fixed five-name list with a pool of about forty short first names (mixed origins, none matching a common English word, none longer than 8 characters). `pickBotName(takenNames, randomInt)` returns a uniformly random name not currently used by a seat in the room, or `null` if the pool is exhausted, which cannot happen with a 4-seat cap. Profiles are still assigned in order of addition as before.

The "reserved for bots" name check in `server.js` goes away: names are labels, ids are identity, and a human sharing a name with a bot is merely cosmetic. Bots are marked `isBot` in `state` as today, and the client renders a small chip glyph on their seat.

### 2.4 Quick play

New client message `quick-play { name, resumeToken? }`. Semantics: exactly `join`, and then, if the join created a **new** seat and that seat is the only seat in the room (no other human, connected or not, and no bot), the server adds bots until the room has 4 seats and starts the game. If the room already had any other seat (someone opened the link first, or a disconnected lobby seat is still within its TTL) it behaves as a plain `join` and the client lands in the lobby. Errors are the same as `join`'s. The `joined` reply is sent before the game starts so the client stores its token before the first `dealing` snapshot arrives.

In the normal case, a freshly reserved room, quick play therefore makes a 4-player table (you plus 3 bots): with 4 players everyone gets 4 cards and there are 19 auctions, the shortest of the standard games.

### 2.5 Routes

| Route | Serves |
| --- | --- |
| `/` | The app shell (landing) |
| `/abcd` | The app shell for that room |
| `/how-to-play` | The app shell; the client opens the tutorial over the landing |
| `/api/new-room` | unchanged |

`public/how-to-play.html` is deleted. Everything else is unchanged.

### 2.6 Wire protocol changes

`state` (seated shape):

- `phase` may now be `"dealing"`.
- `remainingMs` is meaningful in `dealing` and `bidding`.
- `hostId` is removed.
- New `timing: { dealMs, bidMs, revealBidsMs, revealCardMs }` so the client can draw a draining timer ring and decide whether there is time to run the deal timeline.
- In `dealing` the snapshot contains the recipient's own `hand` and the `reference` card (flip 1 is public information), `flipped` of length 1, and `auctionIndex: null`.

Everything else in `state`, the visitor shape, `joined`, and `error` is unchanged. Secrecy rules are unchanged: no deck, no other hands before results, no other bid amounts before reveal.

Client → server additions: `quick-play` (section 2.4). Client → server removals: none. `add-bot`, `remove-bot`, `start-game`, `return-to-lobby` lose their host requirement.

### 2.7 Seat order

The client places seats from the order of `players` in `state`, rotated so the recipient is at the bottom. `players` is already in seat order (join order in the lobby, frozen at start), so no new field is needed.

## 3. Client

### 3.1 Files

The client moves from one 435-line script to ES modules. `game-core.js` stays a UMD classic script loaded first; modules read `window.GameCore`.

```
public/
  index.html          shell: five views + tutorial dialog + top bar
  styles.css          theme, table, cards, chips, seats, dock, dialog, animations
  game-core.js        unchanged
  seat-layout.js      UMD, pure: seat positions on the oval for 2..6 players
  transitions.js      UMD, pure: decides what a new snapshot means for the table
  js/
    app.js            entry; in-document routing between views; owns the socket and state
    net.js            WebSocket connect / reconnect / send, resume, take-over
    table.js          renders the table from state; plays transitions via anim.js
    anim.js           promise-based sequencer, FLIP-style card and chip flights
    audio.js          Web Audio SFX and the mute toggle
    tutorial.js       the how-to-play dialog: five slides and the calculator
    lobby.js          lobby-specific parts of the table (empty seats, deal, invite)
    landing.js        landing and join screens
```

Modules communicate through `app.js`: it holds `state`, calls `table.render(state, meta)` on every snapshot, and exposes `send`. `table.js` owns all DOM under the table view. `transitions.js` is the only place that decides what to animate (section 3.10). `anim.js` and `audio.js` are pure services with no knowledge of game state.

**Single document.** `/`, `/abcd`, and `/how-to-play` all serve the same shell, so moving from the landing into a room is an in-document route change (`history.pushState`), not a page load. `app.js` reads the route from `location.pathname` on load and again on `popstate`. This keeps the `AudioContext` created by the landing gesture alive into the game. A `popstate` that changes the room code reloads the page; the client never tries to swap sockets between rooms in place. The quick-play and play-with-friends intents from the landing are held in memory, never in the URL, so a reload of `/abcd` always lands on the join screen or, with a stored token, resumes.

### 3.2 Views

Five views plus one dialog: **landing**, **join**, **table** (serves lobby, dealing, bidding, reveal), **results** (an overlay on the table), **taken-over**, and the **tutorial** dialog.

**Landing (`/`).** Full-bleed felt. The word mark with the four suit glyphs, which flip over one at a time on load. A name field (remembered as today). Two large chip-styled buttons: **Quick play** and **Play with friends**. A small round **?** button opens the tutorial. A sound toggle sits in the corner. No tagline, no paragraph.

- Quick play: saves the name, unlocks audio, calls `/api/new-room`, pushes `/abcd` onto history, opens the socket with a `quick` intent, and once the socket opens sends `quick-play` with the name. It shows a "dealing you in" splash (deck shuffle animation, no text beyond the room code) until the first seated snapshot arrives.
- Play with friends: saves the name, unlocks audio, calls `/api/new-room`, pushes `/abcd`, opens the socket with a `sit` intent, and sends `join` with the name once the socket opens. The lobby appears with the first seated snapshot.
- If the name field is empty, both buttons focus it and shake it. No toast.

**Join (`/abcd` loaded directly, from a shared link or a reload without a token).** The table is drawn in the background, blurred, with as many seats occupied as `playerCount` says. In front: a name field (prefilled if remembered) and one button, **Sit down**. If the room is mid-game the button is replaced by a pulsing "table in play" pip and the view waits; when a lobby snapshot arrives the button appears. The first click on Sit down is also the audio unlock gesture for this document. A reload with a stored token skips this screen and resumes, as today.

**Table, lobby phase.** The table itself is the lobby. Seats around the oval show each seated player (avatar disc with initial, name, bot glyph if a bot, dimmed if away). Empty seats are drawn as dashed chairs with a **+** glyph; tapping one sends `add-bot`. A bot seat shows a small **×** on hover or tap to send `remove-bot`. In the centre of the table: a **Deal** button (enabled at 2 or more seats; pulses gently when enabled) with a `2 / 6` counter under it, and an **Invite** button that copies the room link and, on devices with `navigator.share`, opens the share sheet. The top bar has the **?** button for the tutorial. There is no rules text, no host note, no hand-size sentence.

**Table, dealing.** Section 3.4 timeline.

**Table, bidding.** The dock at the bottom (section 3.3). Other seats show a slow "thinking" pulse until locked, then a small check chip. Your seat shows your current bid as a chip stack that grows with the slider.

**Table, reveal.** Section 3.5 timeline.

**Results.** An overlay slides up over the table: standings top to bottom with rank medal glyphs, name, final score, and the player's starting hand fanned face-up. The winner's row gets a brief confetti burst of suit glyphs. Two buttons: **Play again** (anyone; sends `return-to-lobby`) and **Leave** (navigates to `/`). A **History** disclosure below the buttons expands the per-auction table from v1, collapsed by default.

**Taken-over.** Unchanged in content, restyled.

### 3.3 The table layout

- The table is an ellipse centred in the viewport, sized with `clamp()` so it fills a phone in portrait (taller than wide) and a laptop in landscape (wider than tall). Felt texture is a CSS radial gradient plus a subtle noise overlay; the rail is a darker wood-toned ring.
- `seat-layout.js` exports `seatPositions(count)` returning `[{ x, y, angle }]` in percentages of the table box, index 0 always at bottom centre (the recipient), the rest evenly spaced clockwise around the remaining arc, with positions tuned so that 2 players are opposite each other and 6 are evenly spread. It is a pure module so it can be unit-tested in Node.
- **Seat**: avatar disc (initial letter on a per-seat colour from a fixed 6-colour palette assigned by seat index), name below it (truncated with ellipsis at 10 characters), score chip to the side showing the number, status pip. Seats are absolutely positioned inside the table box.
- **Centre**: a face-down deck stack whose visual thickness tracks `cardsRemaining` (up to 8 drawn layers), with the count on its top card. Beside it the reference card, large, face up. Under the table, a row of mini cards for every flipped card so far (scrolls horizontally, newest on the right) and four suit chips with counts.
- **Your hand**: fanned at the bottom edge in front of your seat, cards overlapping, sorted by suit, face up. On phones the fan is tighter.
- **Dock** (bidding only): a slider from 0 to 100 styled as a track of chips flanked by **−1** / **+1** step buttons, the current bid as a big number in a ring that drains as the timer runs (the ring uses `timing.bidMs` and `remainingMs`, turns red under 5 s), and one **Lock** button. The draft opens at 25 each auction and is sent as soon as the auction opens, so the number shown is always the bid on record. Locking turns the button into a check and the ring gold. Moving the slider after locking unlocks, as today. The number is also editable directly for keyboard users. The only words on the dock are "Lock" and, once locked, "Locked".
- **Top bar**: room code as a small pill, `7 / 19` auction counter during play, a sound toggle, **?** for the tutorial, and a **Leave** door glyph. Nothing else.

### 3.4 The deal timeline

Played by `table.js` when the planner (section 3.10) returns kind `deal`. Card sprites are DOM elements animated with `transform` between measured positions (FLIP), so the same code works at any viewport size.

1. **Deal** (`P × n` cards, one every 70 ms, clockwise starting from the seat to the left of you): a card back flies from the deck to each seat in turn. Yours land in the hand fan and flip face up on arrival with a card-slide sound; other players' cards stack face down at their seat. At most 21 cards (2.2 of the v1 spec), so at most about 1.5 s.
2. **Peek** (1.2 s): nothing moves. You look at your hand. Bots' seats show a brief "looking" tilt.
3. **Gather** (0.8 s): every dealt card, yours included (they flip face down first), flies back into the deck. Shuffle sound.
4. **Shuffle** (0.8 s): the deck splits into two half-stacks that riffle back together twice. Riffle sound.
5. **Flip** (0.5 s): the top card flips face up into the reference slot with a flip sound. The hand fan re-deals itself quietly from the bottom edge so your cards are visible again (they are yours to look at for the whole game).

Total about 5.7 s in the worst case; the planner's threshold is 6 s, inside the 7 s `dealMs`. The planner (section 3.10) runs the timeline only when the snapshot is a genuine transition into `dealing` and `remainingMs` is at least the timeline's length; otherwise the final frame is drawn directly. When the `bidding` snapshot arrives, the timeline is cancelled if still running and the final frame is drawn.

### 3.5 The auction timelines

Live play shows the **gross two-step** settlement the rules describe: the buyer pays the price to every seller when the bids are revealed, and on a match every seller pays 100 to the buyer when the card is revealed. The server still applies the single net delta at the card step (section 4.4 of the v1 spec), so between the two legs the client shows a **display score** it derives itself (section 3.10).

**Reveal bids** (on the transition into `reveal/bids` for an auction, 3 s):

1. **Tags** (about 0.7 s): each seat's bid tag flips up above the seat, staggered 120 ms apart starting from the lowest bid, each with a chip tap. The buyers' tags turn gold and their seats glow; a gold price badge with the number appears over the deck. A void auction shows a grey "no trade" badge instead and the step ends here. Highest bid gets a short rising sound.
2. **Purchase** (about 1.2 s): one chip stream from every buyer to every seller carrying `price`. A stream of amount 0 sends no chips. Each arriving chip clinks and ticks the receiving seat's display score up while the paying seat's ticks down, easing so both land on their display scores as the last chip arrives.

**Reveal card** (on the transition into `reveal/card` for an auction, 4 s):

1. **Flip** (0.5 s): the top card flips off the deck into the reference slot. The old reference slides into the flipped row. Match: green flash on the rail and a two-note chime. Miss: red flash and a low thud.
2. **Payout** (about 1.5 s): on a match, one chip stream from every seller to every buyer carrying 100, with the same clink-and-tick behaviour, landing on the exact `state` score. On a miss no chips move; the display scores already equal the `state` scores. Void: nothing moves. A delta badge with the auction's net delta (`+40` in green, `−20` in red, `0` in grey) floats up from every seat in both cases.
3. The buyer glow and bid tags fade out. Next `bidding` snapshot: the dock slides up, the ring starts full, a soft deal-in sound plays.

A stream is six chip sprites along an arc, spaced 60 ms. With tied buyers every buyer pays every seller and every seller pays every buyer, so the two legs sum to the deltas in `history`. If a snapshot for a later step arrives mid-animation, the running animation is cancelled and the final frame drawn with the display scores for that step; the animation itself never decides a score.

**Results**: the overlay slides up after the last pay animation, or immediately on hydration. Winner's row: fanfare if you won, a softer resolve chord otherwise.

### 3.6 Sound

`audio.js` builds one `AudioContext` per document on the first user gesture (landing buttons, Sit down, or any tap on the table) and calls `resume()` on it from every later gesture in case the browser suspended it. Because room entry is an in-document route change (section 3.1), the context created on the landing survives into the game. After a reload, sound stays silent until the first gesture in the new document; that is browser policy and is accepted. One toggle, persisted in `localStorage` (`followsuit:sfx`), default on.

Sound effects, all synthesized:

| Event | Sound |
| --- | --- |
| card deal / slide | short band-passed noise burst with a fast decay, pitch varied ±10% |
| card flip | a click (short sine at 2 kHz) followed by a slide |
| shuffle / riffle | 12 rapid noise bursts with rising density |
| chip clink | short triangle wave at a random pitch from a small pentatonic set, 80 ms decay |
| chip push (lock) | low filtered noise thump plus a clink |
| bid tag reveal | soft tap |
| timer under 5 s | one soft tick per second, rising in pitch |
| match | two-note major chime (a fifth up) |
| miss | low sine thud with a brief pitch drop |
| you won | four-note fanfare |
| game over, not won | resolved major chord, quiet |
| button tap | a very short click |


### 3.7 The tutorial

`tutorial.js` renders a `<dialog>` with five slides, a dot indicator, Back and Next, keyboard arrows, and swipe on touch. Opened from the **?** button on the landing, the join screen, the lobby, and the table, and by visiting `/how-to-play`. Each slide has a mini table (same seat, card, and chip elements at reduced scale, three seats) and at most two short sentences of caption. Slide animations replay each time the slide is shown.

1. **Deal.** Cards deal to three seats; yours flip up. Caption: "Everyone gets a hand. You see only yours."
2. **Shuffle back.** The undealt rest of the pool slides off the table, the hands fly back to rebuild the deck, it riffles, the top card flips up. Caption: "The rest of the pool is set aside unseen. Only the hands are shuffled together: that is the deck." Facts list the deck size per player count.
3. **Bid.** Three bid tags rise to 80, 50, 20; the 80 glows gold. Caption: "Everyone bids 0 to 100 in secret. Highest bid buys the bet from everyone else at that price."
4. **Pay.** The same two-step as live play: chips fly 80 from the buyer to each of the two others; the card flips; a Match/Miss toggle replays the payout: on a match 100 comes back from each; on a miss nothing does. The slide ends on the net delta badges (`+40 / −20 / −20` or `−160 / +80 / +80`). Caption: "Match: each other player pays the buyer 100. Miss: the buyer keeps nothing."
5. **Try it.** Three sliders labelled You, A, B, a Match/Miss toggle, and live score deltas beside each slider computed with `GameCore.settle`. Ties show all top bidders as buyers; an all-way tie shows "no trade". Caption: "Move the bids. Notice who wins the auction and who wins the money."

There is no "why the game is hard" slide. The dialog closes with Escape, the × button, or a tap outside.

### 3.8 Text inventory

Every string the client shows during play, to keep the "less text" promise honest:

- Landing: `Follow Suit`, `Your name`, `Quick play`, `Play with friends`.
- Join: `Sit down`, name placeholder.
- Lobby: `Deal`, `Invite`, `Link copied`, the `n / 6` counter.
- Table: `Lock`, `Locked`, the `k / N` auction counter, room code, numbers on chips, cards, badges, and deltas, `no trade`.
- Results: `Play again`, `Leave`, `History`, plus the v1 history table under the disclosure.
- Errors from the server are shown as short toasts, as today.
- Taken-over: two short sentences and `Reload`.

### 3.9 Motion and accessibility

- `prefers-reduced-motion: reduce` replaces flights with 150 ms cross-fades and skips the shuffle; timelines still run so state changes are visible, just without travel.
- All animation is `transform` and `opacity` only, so it stays smooth on phones.
- Every control is a real `<button>` or `<input>`; the slider remains a native range input styled with CSS. Glyph-only controls carry accessible names: empty seat "Add a bot", bot remove "Remove {name}", `?` "How to play", door "Leave table", sound "Sound effects on/off", invite "Copy invite link". Seats have `aria-label`s of the form "{name}, {score} points, {locked | thinking | away}{, bot}".
- One visually hidden `aria-live="polite"` region announces, in one short sentence each: bids revealed with the buyer and price ("Maya buys at 62", "No trade"), the flipped card and outcome ("Hearts, match"), your own delta ("You plus 40"), ten seconds left in bidding, connection lost and restored, and the phase changes into dealing, results, and lobby. Nothing else is announced, so the region stays quiet enough to be useful.
- Focus: opening the tutorial moves focus into the dialog and closing it restores focus to the opener; when bidding begins focus moves to the bid number input unless the user is already interacting with a control.
- The table works at 360 px wide and at 1440 px wide with no horizontal scroll.

### 3.10 Snapshot handling and animation ownership

The server sends more snapshots than there are transitions: a message handler broadcasts once from `onChange` and once more after the handler returns, so a start delivers two identical `dealing` snapshots and a final lock two identical `reveal/bids` snapshots. The client must treat snapshots as idempotent state, not as events.

`transitions.js` (pure, UMD, tested in Node) exports `plan(prev, next, meta)` where `meta` is `{ hydrate: boolean, reducedMotion: boolean }`. It returns a **transition key** `${matchId}:${phase}:${revealStep || ""}:${auctionIndex || 0}` and a **kind**:

| Condition | Kind |
| --- | --- |
| `hydrate` is true, or `prev` is null | `hydrate`: draw the final frame of `next`, no timeline |
| key unchanged | `update`: idempotent refresh (scores, lock pips, timer, connection flags); never touches the sprite layer |
| into `dealing` with `remainingMs >= DEAL_TIMELINE_MS` | `deal` |
| into `dealing` otherwise | `hydrate` |
| into `bidding` | `bidding`: cancel any running timeline, draw final frame, dock in |
| into `reveal/bids` | `revealBids` |
| into `reveal/card` | `revealCard` |
| into `results` | `results` |
| into `lobby` | `lobby` |

`hydrate` is true for the first seated `state` received after a socket open on which the client did not itself send `join` or `quick-play`; `net.js` sets it. A fresh join or quick play therefore animates its first transition (quick play lands straight in `dealing` and must deal), while a resume after reload or reconnect draws the final frame. `joined` is not used as a gate because a resume can broadcast a snapshot before `joined` is sent.

**Ownership.** The table DOM has two layers. The **state layer** (seats, deck, reference, hand, dock, badges) is rebuilt or patched by `render` on every snapshot from `state` alone. The **sprite layer** (flying cards, chips, riffle halves) is written only by timelines. Timelines position sprites by measuring state-layer elements, then remove their sprites and reveal the corresponding state-layer element when they finish or are cancelled.

**Cancellation.** `anim.js` keeps a generation counter. Starting a timeline increments it and captures the value; every `await` inside a timeline is followed by a check that the captured generation is still current, and if not the timeline clears its sprites and returns without touching the state layer. Cancelling therefore cannot leave a stale continuation writing to the DOM. `table.dispose()` bumps the generation, clears the sprite layer, and stops the timer ring; `app.js` calls it on take-over, on Leave, on socket replacement, and before switching to a non-table view.

Duplicate-snapshot rule, made explicit: a second snapshot with the same key while a timeline is running takes the `update` path, which does not restart, cancel, or draw over the running timeline.

**Display scores.** `transitions.js` also exports `displayScores(state)` returning `{ [playerId]: number }`. In every phase but `reveal/bids` it is each player's `score` from `state`. In `reveal/bids` the last history entry has bids, buyers, and price but no deltas yet, and the purchase leg has conceptually happened: each buyer's display score is `score − price × sellers.length` and each seller's is `score + price × buyers.length`; a void entry changes nothing. Because the server applies the net delta at the card step, `score + netDelta` equals the display score after the purchase leg plus the payout leg, so the two legs always reconcile with `state`. The state layer renders display scores, never raw scores, so hydration mid-reveal shows the right interim numbers.

## 4. Testing

Server, all with `npm test`:

- `game`: `start` enters `dealing` with `remainingMs === dealMs`; bids during dealing return `not_bidding`; no bot timers are armed during dealing; advancing the fake clock by `dealMs` opens auction 1 with bots scheduled; a `return-to-lobby` during dealing is refused; a second `start` while dealing throws (phase is not lobby); the deal timer is cancelled by `destroy`.
- `rooms`: `hostId` is gone; `join`, `addBot`, `removeBot`, `startGame`, `returnToLobby` have no host concept.
- `bots`: names come from the pool, are unique within the taken list, use the injected `randomInt`, and `pickBotName` returns `null` only when every name is taken; existing bid tests unchanged.
- `snapshot`: key list updated (`hostId` out, `timing` in); in `dealing` the recipient's own hand and the reference are present, `auctionIndex` is `null`, and the deck and other hands are absent; secrecy assertions extended to the new phase.
- `server` (real sockets): the spawned server gets `DEAL_MS=50` alongside the short bid and reveal timings so existing tests that wait for `bidding` keep their margin; a second joiner can add a bot and start the game; a visitor cannot; `quick-play` from a fresh room yields a `joined` then a `dealing` state with four players, three of them bots; `quick-play` into a room that already has a seat behaves as a plain join; `/how-to-play` serves the app shell. The 7 s production default is asserted in the config test, not by waiting for it.
- `seat-layout`: for 2..6 players, index 0 is at bottom centre, positions are distinct, all within the box, and neighbours are at least a minimum angular distance apart.
- `transitions` `displayScores`: equals raw scores outside `reveal/bids`; in `reveal/bids` reproduces the purchase leg for the v1 worked examples (80/50/20 → −160/+80/+80 relative to raw; the 60/60/30/10 tie → −120/−120/+120/+120); a void entry leaves scores unchanged; display score plus the payout leg equals the raw score after the card step.
- `transitions` `plan`: fed snapshot sequences and asserted kind by kind: duplicate `dealing` snapshots yield `deal` then `update`; a `dealing` snapshot with short `remainingMs` yields `hydrate`; the first snapshot after a socket open yields `hydrate` even in `reveal/card`; `reveal/bids` twice yields `revealBids` then `update`; skipping straight from `bidding` to `reveal/card` yields `revealCard`; a new `matchId` in `dealing` yields `deal` again; results then lobby yields `results` then `lobby`. Generation cancellation in `anim.js` is tested with a fake sequencer: a cancelled timeline resolves without calling its DOM hooks after the cancel point.

Client, manual in Chrome before calling it done, on a phone-width viewport and a laptop viewport:

1. Landing → Quick play: deal timeline plays with sound, bidding opens with the ring full, bots lock with chip sounds, reveal, pay animation, scores match the history table at the end.
2. Landing → Play with friends → second tab opens the link → Sit down → both see each other at the table → either tab adds a bot → the second tab deals.
3. Reload mid-deal and mid-reveal: the final frame is drawn, no stuck sprites, scores correct.
4. Tutorial: all five slides animate, the calculator agrees with the worked examples from the v1 spec (80/50/20 match → +40/−20/−20; miss → −160/+80/+80).
5. The sound toggle persists across reload.
6. Reduced motion enabled in DevTools: game still readable, no flights.
7. Two tabs on the same seat: taken-over view appears.

## 5. Decisions log

- Deal animation needs a server phase, not a client delay, so every client sees the same window and bots do not bid over the animation.
- Quick play is a server message, not a client script of add-bot × 3 + start, so it is one round trip and cannot be interrupted by a stray joiner half-way.
- Host removed: with a share-link lobby and at most four seats, the host role was friction with no safety benefit. Room deletion already keyed on connected humans.
- Bot names random from a pool rather than generated, so they read as names.
- Audio synthesized rather than sampled: no assets to license or ship, and it matches the vector look of the table.
- No background music: a generative lounge pad was specified and built, then removed at the owner's request during implementation (2026-09-13); sound effects stay.
- The tutorial is a dialog inside the app rather than a page so it can reuse the live card, chip, and seat elements and stay in sync with the table's look.
- History table kept on the results screen behind a disclosure: the number-heavy record is useful for people who want to study a game, but it should not be the first thing on screen.
- ES modules without a bundler: the browser support floor for this app already assumes modern JavaScript, and splitting the client is the only way to keep the animation, audio, and rendering code reviewable.
- Landing to room is an in-document route change, not a page load, so the audio context unlocked on the landing survives into the game. A reload still needs one gesture; that is browser policy.
- Live play shows the gross two-step settlement (buyer pays the price at the bids reveal, sellers pay 100 at a match), chosen by the owner over a single net stream because the two legs are what teach the rule. The server stays net; the client derives the interim display score.
- Snapshots are idempotent state, and transitions are derived by a pure planner keyed on match, phase, step, and auction. Codex review found that the server's double broadcast per handler would otherwise replay or interrupt animations.
