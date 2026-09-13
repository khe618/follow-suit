# Follow Suit — game feel overhaul

Date: 2026-09-13
Status: draft for review
Builds on: `2026-09-12-follow-suit-design.md` (the rules and server architecture there stay in force except where this spec amends them)

## 1. Goal

Make Follow Suit feel like sitting at a card table, not reading a website. Same rules, same server authority, same secrecy boundary. What changes:

- The game screen becomes a **poker table**: players sit around an oval, the deck and reference card sit in the middle, your hand is fanned in front of you.
- **Animations** carry the game's events: the deal, the shuffle-back, bids being revealed, the card flip, and chips flying between seats when players pay each other.
- **Sound effects and music**, synthesized in the browser with the Web Audio API. No audio files.
- **Far less text.** Icons, numbers, and motion replace sentences. The rules leave the lobby and live in an interactive tutorial.
- **Simpler entry.** No room-code box on the landing page. Quick play seats you with bots at once; Play with friends gives you a link to share.
- **No host.** Anyone seated at the table can add or remove bots, deal, and play again.
- **Bots get random human-style names** with a small bot marker.

Out of scope, unchanged from v1: accounts, persistence, spectators, a fair-value debrief, native apps. Also out of scope here: composed music tracks, avatar pictures, haptics, chat, emotes.

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
- New config key `dealMs` (env `DEAL_MS`, default 7000). The reveal card step gets more room for the payment animation: `revealCardMs` default rises from 3000 to 4000. `revealBidsMs` stays 2500.

### 2.2 No host

`hostId` is removed from `lib/rooms.js` and from the `state` message. Any **seated, connected human whose socket owns its seat** may send `add-bot`, `remove-bot`, `start-game`, and `return-to-lobby`. Visitors and displaced sockets still cannot. Room deletion already keys off "no connected human", not the host, so nothing else moves.

### 2.3 Random bot names

`lib/bots.js` replaces the fixed five-name list with a pool of about forty short first names (mixed origins, none matching a common English word, none longer than 8 characters). `pickBotName(takenNames, randomInt)` returns a uniformly random name not currently used by a seat in the room, or `null` if the pool is exhausted, which cannot happen with a 6-seat cap. Profiles are still assigned in order of addition as before.

The "reserved for bots" name check in `server.js` goes away: names are labels, ids are identity, and a human sharing a name with a bot is merely cosmetic. Bots are marked `isBot` in `state` as today, and the client renders a small chip glyph on their seat.

### 2.4 Quick play

New client message `quick-play { name, resumeToken? }`. Semantics: exactly `join`, and then, if the join created a **new** seat and the room is in the lobby with that seat as the only one, the server adds bots until the room has 4 seats and starts the game. If the room already had other seats (someone opened the link first) it behaves as a plain `join` and the client lands in the lobby. Errors are the same as `join`'s. The `joined` reply is sent before the game starts so the client stores its token before the first `dealing` snapshot arrives.

Quick play always makes a 4-player table (you plus 3 bots): with 4 players everyone gets 4 cards and there are 19 auctions, the shortest of the standard games.

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
  js/
    app.js            entry; routing between views; owns the socket and state
    net.js            WebSocket connect / reconnect / send, resume, take-over
    table.js          renders the table from state; asks anim.js to play transitions
    anim.js           promise-based sequencer, FLIP-style card and chip flights
    audio.js          Web Audio SFX and generative music, mute toggles
    tutorial.js       the how-to-play dialog: five slides and the calculator
    lobby.js          lobby-specific parts of the table (empty seats, deal, invite)
    landing.js        landing and join screens
```

Modules communicate through `app.js`: it holds `state`, calls `table.render(state, prev)` on every snapshot, and exposes `send`. `table.js` owns all DOM under the table view and is the only module that decides what to animate, by diffing `prev` against `state` (phase, revealStep, matchId, auctionIndex, scores). `anim.js` and `audio.js` are pure services with no knowledge of game state.

### 3.2 Views

Five views plus one dialog: **landing**, **join**, **table** (serves lobby, dealing, bidding, reveal), **results** (an overlay on the table), **taken-over**, and the **tutorial** dialog.

**Landing (`/`).** Full-bleed felt. The word mark with the four suit glyphs, which flip over one at a time on load. A name field (remembered as today). Two large chip-styled buttons: **Quick play** and **Play with friends**. A small round **?** button opens the tutorial. A sound toggle sits in the corner. No tagline, no paragraph.

- Quick play: saves the name, calls `/api/new-room`, navigates to `/abcd#quick`. On load the client sees the hash, removes it with `history.replaceState`, and once the socket opens sends `quick-play` with the stored name. It shows a "dealing you in" splash (deck shuffle animation, no text beyond the name of the table) until the first `dealing` snapshot arrives.
- Play with friends: saves the name, calls `/api/new-room`, navigates to `/abcd#sit`. On load, with a stored name, the client sends `join` immediately and shows the lobby; without a stored name it shows the join screen.
- If the name field is empty, both buttons focus it and shake it. No toast.

**Join (`/abcd` from a shared link).** The table is drawn in the background, blurred, with as many seats occupied as `playerCount` says. In front: a name field (prefilled if remembered) and one button, **Sit down**. If the room is mid-game the button is replaced by a pulsing "table in play" pip and the view waits; when a lobby snapshot arrives the button appears. The first click on Sit down is also the audio unlock gesture.

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
- **Centre**: a face-down deck stack whose visual thickness tracks `cardsRemaining` (up to 8 drawn layers), with the count on its top card. Beside it the reference card, large, face up. A small face-down mini-stack marked with the hidden-card count sits behind the deck. Under the table, a row of mini cards for every flipped card so far (scrolls horizontally, newest on the right) and four suit chips with counts.
- **Your hand**: fanned at the bottom edge in front of your seat, cards overlapping, sorted by suit, face up. On phones the fan is tighter.
- **Dock** (bidding only): a slider from 0 to 100 styled as a track of chips, the current bid as a big number in a ring that drains as the timer runs (the ring uses `timing.bidMs` and `remainingMs`, turns red under 5 s), and one **Lock** button. Locking turns the button into a check and the ring gold. Moving the slider after locking unlocks, as today. The number is also editable directly for keyboard users. The only words on the dock are "Lock" and, once locked, "Locked".
- **Top bar**: room code as a small pill, `7 / 19` auction counter during play, sound and music toggles, **?** for the tutorial, and a **Leave** door glyph. Nothing else.

### 3.4 The deal timeline

Played by `table.js` when a snapshot arrives with `phase: "dealing"` for a `matchId` it has not yet animated. Card sprites are DOM elements animated with `transform` between measured positions (FLIP), so the same code works at any viewport size.

1. **Deal** (`P × n + n` cards, one every 70 ms, clockwise starting from the seat to the left of you): a card back flies from the deck to each seat in turn. Yours land in the hand fan and flip face up on arrival with a card-slide sound; other players' cards stack face down at their seat; the `n` hidden cards go to the hidden mini-stack. At most 28 cards, so at most about 2 s.
2. **Peek** (1.5 s): nothing moves. You look at your hand. Bots' seats show a brief "looking" tilt.
3. **Gather** (0.8 s): every dealt card, yours included (they flip face down first), flies back to the deck. Shuffle sound.
4. **Shuffle** (0.8 s): the deck splits into two half-stacks that riffle back together twice. Riffle sound.
5. **Flip** (0.5 s): the top card flips face up into the reference slot with a flip sound. The hand fan re-deals itself quietly from the bottom edge so your cards are visible again (they are yours to look at for the whole game).

Total about 5.6 s, inside the 7 s `dealMs`. If a snapshot arrives with `remainingMs` less than the timeline needs (a reload mid-deal), the timeline is skipped and the final frame is drawn directly. When the `bidding` snapshot arrives, the timeline is cancelled if still running and the final frame is drawn.

### 3.5 The auction timelines

**Reveal bids** (on the first `reveal/bids` snapshot for an auction): each seat's bid tag flips up above the seat, staggered 120 ms apart starting from the lowest bid, each with a chip tap. The buyers' tags turn gold and their seats glow; a gold price badge with the number appears over the deck. A void auction shows a grey "no trade" badge instead. Highest bid gets a short rising sound.

**Reveal card** (on the first `reveal/card` snapshot for an auction):

1. **Flip** (0.5 s): the top card flips off the deck into the reference slot. The old reference slides into the flipped row. Match: green flash on the rail and a two-note chime. Miss: red flash and a low thud.
2. **Pay** (about 1.5 s): chip sprites fly between seats along an arc, six chips per payment stream, spaced 60 ms. On a match, each seller sends chips to each buyer. On a miss, each buyer sends chips to each seller. Each arriving chip clinks and ticks the receiving seat's score toward its new value; the score counter runs with an easing counter so it lands on the exact value as the last chip arrives. A delta badge (`+40` in green, `−20` in red) floats up from each seat.
3. The buyer glow and bid tags fade out. Next `bidding` snapshot: the dock slides up, the ring starts full, a soft deal-in sound plays.

If a snapshot for a later step arrives mid-animation, the running animation is cancelled and the final frame drawn; scores are always taken from `state`, never from the animation.

**Results**: the overlay slides up after the last pay animation, or immediately on a reload. Winner's row: fanfare if you won, a softer resolve chord otherwise.

### 3.6 Sound and music

`audio.js` builds one `AudioContext` on the first user gesture (landing buttons, Sit down, or any tap on the table). Two independent toggles, persisted in `localStorage` (`followsuit:sfx`, `followsuit:music`), both default on. When the tab is hidden, music pauses via `visibilitychange`.

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

Music is generative, a lounge pad: a cycle of four chords (ii–V–I–vi in a warm key, 8 s each), each voiced by three detuned triangle oscillators through a low-pass filter with a slow LFO on the cutoff, plus a sine bass playing the root on the first beat of each bar and a very quiet brushed hi-hat pattern from filtered noise. Tempo around 76 BPM. Overall gain around −20 dBFS so it sits well under the effects. The loop runs on `AudioContext` scheduling (lookahead scheduler), not `setInterval` audio.

### 3.7 The tutorial

`tutorial.js` renders a `<dialog>` with five slides, a dot indicator, Back and Next, keyboard arrows, and swipe on touch. Opened from the **?** button on the landing, the join screen, the lobby, and the table, and by visiting `/how-to-play`. Each slide has a mini table (same seat, card, and chip elements at reduced scale, three seats) and at most two short sentences of caption. Slide animations replay each time the slide is shown.

1. **Deal.** Cards deal to three seats; yours flip up. Caption: "Everyone gets a hand. You see only yours."
2. **Shuffle back.** All hands and a small hidden stack fly into the deck, it riffles, the top card flips up. Caption: "The hands and some hidden cards go back in. Will the next card match this suit?"
3. **Bid.** Three bid tags rise to 80, 50, 20; the 80 glows gold. Caption: "Everyone bids 0 to 100 in secret. Highest bid buys the bet from everyone else at that price."
4. **Pay.** Chips fly 80 from the buyer to each of the two others; the card flips; a Match/Miss toggle replays the payout: on a match 100 comes back from each; on a miss nothing does. Caption: "Match: each other player pays the buyer 100. Miss: the buyer keeps nothing."
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
- Every control is a real `<button>` or `<input>`; the slider remains a native range input styled with CSS. Seats have `aria-label`s with name, score, and status so a screen reader can follow the table.
- The table works at 360 px wide and at 1440 px wide with no horizontal scroll.

## 4. Testing

Server, all with `npm test`:

- `game`: `start` enters `dealing` with `remainingMs === dealMs`; bids during dealing return `not_bidding`; no bot timers are armed during dealing; advancing the fake clock by `dealMs` opens auction 1 with bots scheduled; a `return-to-lobby` during dealing is refused; a second `start` while dealing throws (phase is not lobby); the deal timer is cancelled by `destroy`.
- `rooms`: `hostId` is gone; `join`, `addBot`, `removeBot`, `startGame`, `returnToLobby` have no host concept.
- `bots`: names come from the pool, are unique within the taken list, use the injected `randomInt`, and `pickBotName` returns `null` only when every name is taken; existing bid tests unchanged.
- `snapshot`: key list updated (`hostId` out, `timing` in); in `dealing` the recipient's own hand and the reference are present and the deck, other hands, and `auctionIndex` are not; secrecy assertions extended to the new phase.
- `server` (real sockets): a second joiner can add a bot and start the game; a visitor cannot; `quick-play` from a fresh room yields a `joined` then a `dealing` state with four players, three of them bots; `quick-play` into a room that already has a seat behaves as a plain join; `/how-to-play` serves the app shell.
- `seat-layout`: for 2..6 players, index 0 is at bottom centre, positions are distinct, all within the box, and neighbours are at least a minimum angular distance apart.

Client, manual in Chrome before calling it done, on a phone-width viewport and a laptop viewport:

1. Landing → Quick play: deal timeline plays with sound, bidding opens with the ring full, bots lock with chip sounds, reveal, pay animation, scores match the history table at the end.
2. Landing → Play with friends → second tab opens the link → Sit down → both see each other at the table → either tab adds a bot → the second tab deals.
3. Reload mid-deal and mid-reveal: the final frame is drawn, no stuck sprites, scores correct.
4. Tutorial: all five slides animate, the calculator agrees with the worked examples from the v1 spec (80/50/20 match → +40/−20/−20; miss → −160/+80/+80).
5. Sound and music toggles persist across reload; music stops when the tab is hidden.
6. Reduced motion enabled in DevTools: game still readable, no flights.
7. Two tabs on the same seat: taken-over view appears.

## 5. Decisions log

- Deal animation needs a server phase, not a client delay, so every client sees the same window and bots do not bid over the animation.
- Quick play is a server message, not a client script of add-bot × 3 + start, so it is one round trip and cannot be interrupted by a stray joiner half-way.
- Host removed: with a share-link lobby and at most six seats, the host role was friction with no safety benefit. Room deletion already keyed on connected humans.
- Bot names random from a pool rather than generated, so they read as names.
- Audio synthesized rather than sampled: no assets to license or ship, and it matches the vector look of the table. Music is atmospheric, not a composed track; a file-based track can replace the generator later behind the same `audio.js` interface.
- The tutorial is a dialog inside the app rather than a page so it can reuse the live card, chip, and seat elements and stay in sync with the table's look.
- History table kept on the results screen behind a disclosure: the number-heavy record is useful for people who want to study a game, but it should not be the first thing on screen.
- ES modules without a bundler: the browser support floor for this app already assumes modern JavaScript, and splitting the client is the only way to keep the animation, audio, and rendering code reviewable.
