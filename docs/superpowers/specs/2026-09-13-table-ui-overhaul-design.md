# Table UI overhaul — design

Date: 2026-09-13
Status: reviewed (Codex adversarial pass folded in)
Amends: `2026-09-13-game-feel-design.md` (client layout, animation, tutorial).
Game rules are unchanged except the bid clock; `game-core.js` scoring,
`lib/` settlement, and the wire protocol are untouched.

## 1. Why

Measured on the current build at a 360×780 viewport (4-player quick play):

- All four seat pods lie outside the felt ellipse. The left and right pods
  clip the viewport (`left: -10`, `right: 370`), so the page scrolls
  horizontally (`scrollWidth` 370 > 360).
- The top pod lands on the BIDS/PAYOUTS toggle — the reported "bid/payouts
  button interferes with the table".
- Your own bid chip stack is drawn over your own avatar, hiding it.
- Your pod's bottom edge (687) falls below the dock's top (664), so the hand
  row is crushed to nothing.
- The same pod-outside-felt failure occurs at 768 px, so this is not only a
  phone problem.

Beyond layout: stakes are abstract suit pills in a game about owning suits;
the end-of-game History is a 19-row table with columns clipped off the right
edge; 30 s is tight for a game about estimating a value; the runout has no
name and no moment; and the full-table rail flash is a holdover from the
pre-stakes version.

## 2. Goals / non-goals

**Goals.** Every pod renders identically and sits wholly inside the felt at
any supported width. Owned suits show as stacked cards on the table. The log
stops competing with the felt on phones without hiding the information the
game is played on. Results end with a readable recap. 60 s to bid. A card
visibly moves to its buyer. The last five cards become a named, staged "bonus
round". The tutorial teaches the auction first and the bonus round last, and
its interactive slides state what to do and what just happened.

**Non-goals.** No rules changes. No spectator mode. No new server state or
snapshot fields. Desktop is improved only where it shares code with mobile.

**Stated assumption.** "Player chips" in the request is read as *the seat
pods* — the per-player cluster of avatar, name and score — not the poker-chip
payment sprites. §3 is built on that reading.

## 3. Seat pods and owned cards

### 3.1 Seat geometry

`public/seat-layout.js` hard-codes `RX = 44`, `RY = 42` percent
(`seat-layout.js:10`). The current `.seat` is 84 px wide and ~115 px tall
(`styles.css:146`), which is what puts every pod off the felt.

Two changes, both pure and Node-testable:

```js
seatPositions(count, { rx = RX, ry = RY } = {})   // options are new
fitRadii({ tableW, tableH, podW, podH, railPx, counts = [2,3,4] })
  -> { rx, ry }                                    // percent of the table box
```

Existing callers and all four tests in `tests/seat-layout.test.js` call
`seatPositions(n)` with no options and assert against the present constants
(e.g. `y === 92`), so defaulting to `RX`/`RY` keeps them green unchanged.

`fitRadii` needs an explicit objective, because rx and ry trade off and no
unique "largest" pair exists. The rule is:

1. **Containment.** A candidate `{rx, ry}` fits iff, for *every* seat count in
   `counts` and every seat in it, all four corners of the pod box satisfy the
   felt ellipse `((x-cx)/a)² + ((y-cy)/b)² ≤ 1`, where `a = tableW/2 - railPx`
   and `b = tableH/2 - railPx`. Checking all counts (not just the current one)
   keeps the ring from jumping when a player joins or leaves. Checking all
   four corners is what makes diagonal seats (3-player, 120°/240°) safe.
2. **Objective.** Coordinate ascent: binary-search the largest feasible `rx`
   at the current `ry`, then the largest feasible `ry` at that `rx`, four
   rounds, starting from `ry = 0`. This is deterministic, and the ascent order
   (rx first) is a deliberate choice, not an accident — the unit test pins the
   resulting values so it cannot drift silently.

Validated against the measured geometry (rail 15 px = the 12 px + 3 px inset
box-shadows at `styles.css:133`):

| viewport | table box | pod | result | all corners inside, 2/3/4 players |
| --- | --- | --- | --- | --- |
| 360 px | 336×437 | 92×52 | rx 31.5%, ry 28.9% | yes |
| 414 px | 390×507 | 92×52 | rx 34.1%, ry 31.7% | yes |
| 768 px | 744×465 | 112×64 | rx 39.9%, ry 31.1% | yes |
| 900 px | 900×562 | 112×64 | rx 41.8%, ry 34.1% | yes |

`table.js` measures `#table` under a `ResizeObserver`, reads the pod box from
`--pod-w` / `--pod-h`, and passes the result to `seatPositions`.

### 3.2 The pod

One fixed-size element per player, identical at every seat index: avatar,
name, and score on a compact box sized by `--pod-w` / `--pod-h` (92×52 on
phones, 112×64 at ≥640 px). It never grows with holdings, badges, or tags.
`.seat.empty` (lobby) uses the same box. The bid tag, delta badge and status
dot keep their current positions relative to the pod.

Each pod carries `data-face`, the direction its cards fan — always *toward the
table centre*. Derived by dominant axis of the vector from pod to centre:
`|dy| >= |dx|` gives `up`/`down`, otherwise `left`/`right`. This is defined for
diagonal seats too (3-player 120° → `right`, 240° → `left`).

### 3.3 Owned cards replace stake chips

`.stake-chip` is removed. Holdings render as one stack of mini cards per suit,
in a row on the pod's `data-face` side:

```
TOP SEAT          ( A )  Ada  +40
                   ♠♠♠  ♥♥          fans DOWN, toward the centre

                    deck  ·  reference

                   ♠♠  ♦             fans UP, toward the centre
BOTTOM SEAT       ( Y )  You  -15
```

- Mini card 16×23 on phones, 20×29 at ≥640 px.
- One `.stake-stack[data-suit][data-count]` per suit owned, ordered by
  `SUITS`. Within a stack, cards overlap by 70% of their width, capped at
  **four** `.stake-card` edges; a count badge appears when `data-count ≥ 2`.
  Seven spades read as four edges with a `7`, never seven cards wide.
- The row is capped at `--pod-w`; with four suits the overlap tightens rather
  than the row wrapping.

**Accessible label — deliberate change.** `renderStakeRow` currently returns
`spades ×3, hearts ×2`, which the seat prepends with `holds `
(`table.js:191`, `table.js:239`). It will return `3 spades, 2 hearts`, so the
seat reads "holds 3 spades, 2 hearts". This is a change, not a preserved
contract.

### 3.4 The bid chip stack moves to the dock

`renderBidStack` (`table.js:442`) draws poker chips over *your own avatar* —
which is why the avatar is invisible in the measured screenshot — and the
tutorial calls them "the dock reads your bid back as cards". They are chips,
not cards; they are on the seat, not the dock; and no slide shows them.

`.seat-stack` and its CSS are deleted. The stack renders into a new
`#bidStack` in the dock beside the ring, one chip per 10 of `draft.amount`.
The tutorial line becomes "the dock stacks a chip for every 10 you bid", which
is then true, and slide 4 demonstrates it.

## 4. Mobile layout

### 4.1 The log: grid into a sheet, counts stay on the table

The log footer holds two different things (`table.js:363`): the Bids/Payouts
toggle, and the per-suit counts of cards flipped so far. **The suit counts are
the single most useful number on screen** — they are the input to estimating
what a suit is worth. They stay visible on the table at every width, moving to
a compact row directly under the felt. Only the bids/payouts *grid* and its
toggle move into the sheet.

**Open-state contract.** `renderLog()` today sets `#log.hidden` purely from
phase (`table.js:303`), so any render would reopen a sheet the player had
closed. Availability and openness become separate concepts:

- `#log` lives inside `<dialog id="logSheet">` at all times. `renderLog()`
  only ever writes content and sets `data-available` from the phase; it never
  touches the dialog's open state.
- A `matchMedia("(min-width: 640px)")` listener owns the open state: on
  desktop the dialog is held open non-modally with `.show()` so it renders
  in-flow above the table; on phones it is `.close()`d and the topbar's `Log`
  button opens it with `.showModal()`. Crossing the breakpoint re-normalises.

**Modal contract** (matching `tutorial.js:449`): native `<dialog>` so focus is
contained and the background inert; `aria-label="Cards and bids so far"`;
initial focus on the sheet's close button; `Escape` and backdrop click close
it; focus returns to the `Log` button that opened it.

### 4.2 Vertical budget

The magic numbers go. `--dock-h` is published from a `ResizeObserver` on the
dock (0 while hidden) and `--safe-b` from `env(safe-area-inset-bottom)`. The
table is sized height-first so its aspect ratio survives the clamp:

```css
.table { height: clamp(220px, var(--table-budget), 100%);
         width: auto; aspect-ratio: 10 / 13; max-width: min(100%, 900px); }
```

with `--table-budget: calc(100dvh - var(--topbar-h) - var(--hand-h)
- var(--counts-h) - var(--dock-h) - var(--safe-b))`. The `clamp` floor is what
keeps short viewports and enlarged text from producing a zero or negative
height. Setting `max-height` on a width-driven box would have broken the
ratio instead of shrinking the box.

## 5. Results recap

The `<details>` + `table.history` block (`index.html:101`) is deleted. In its
place, under the standings, a horizontally scrollable recap.

**Grouping.** The bonus boundary cannot come from the `runout` flag. Traced on
a real game: for a 20-card deck the auctions are history entries 0–14 and only
entries 15–18 carry `runout: true`, yet the *doubled* cards are 16–20 — the
first doubled card is the payoff flip of the final auction, whose entry has
`runout: false`. So:

- One cell per history entry, in order.
- A cell's flipped card is marked `×2` when **that flip was doubled**, derived
  by card position: for entry index `i` the flipped card number is `i + 2`
  (card 1 is the opening reference), doubled iff `i + 2 > deckSize -
  RUNOUT_CARDS`, where `deckSize = state.flipped.length +
  state.cardsRemaining`.
- The `bonus` divider is drawn before the **final auction** cell, matching
  §8.1's definition of when the bonus round starts. That cell keeps its buyer
  row — it is a real auction, and the first doubled card is what it pays on.

**Price.** There is no single "price". `topBid` decides *who* buys; the buyer's
actual cost is the sum of every seller's bid, available as `-purchase[buyerId]`
(`lib/game.js:193`). The recap shows the **amount actually paid**, labelled as
such, and renders one buyer chip per buyer so ties are not flattened.

**Semantics.** The strip is an `<ol>`; each `<li>` carries a complete
`aria-label` ("Auction 3, hearts: Joss bought for 60, flipped spades, you
minus 10") with the glyph content `aria-hidden`. This keeps the recap legible
to assistive technology, which a bare strip of suit glyphs and initials would
not be. It sits in its own `overflow-x: auto` container and is the only
horizontally scrolling element on the screen.

## 6. Bid clock: 60 s

`bidMs` 30000 → 60000 in the four places the default is duplicated and
asserted (per `LEARNINGS.md`): `lib/config.js:14`, `lib/game.js:7`,
`tests/config.test.js:8`, `tests/config.test.js:16`, `tests/snapshot.test.js:49`.

`botDelayMs` is `min(6000, floor(bidMs / 2))` (`lib/bots.js:54`), so bots still
bid in 1.5–6 s and the auction still resolves the moment the last human locks;
the clock is a ceiling, not a pace. The ring's `urgent` (<5 s) and "ten seconds
left" thresholds are absolute and stay as they are.

## 7. The card moves to its buyer

At the end of `revealBidsTimeline`, after the purchase chips land, the bought
suit visibly changes hands. The reference card cannot leave the slot — it is
still the top card and the next flip turns onto it — so the flight is a
**copy**, which is also what the mechanic is: you buy a claim on the suit, not
the card.

**Landing target and handoff.** The target is the buyer's
`.stake-stack[data-suit]` container, which the state layer has already drawn
for the post-purchase state. Because stacks aggregate and cap at four edges,
"hide the new chip and pop it" no longer has a unique referent. The handoff is
therefore defined on the stack, not on a card:

1. Before the flight, the timeline sets the stack's `data-count` back to its
   pre-purchase value and hides its last `.stake-card` (there is always at
   least one; a brand-new stack hides its only card).
2. A `card big` copy of the reference is spawned on the ref slot and flown
   with `ctx.fly` (small arc), scaling to mini size.
3. On landing, `data-count` is restored and the hidden card is shown. When the
   purchase added no new edge (count already ≥ 4), only the badge changes —
   which is why the count, not the card, is the thing held back.

Void auctions fly nothing; a tie flies one copy per buyer, concurrently.

**Budget.** Worst case is a 4-player two-way tie: 4 payment streams and 2
concurrent copies. Streams run concurrently, so `payStreams` is ~860 ms
(`6 × 60 + 500`) regardless of count, and the two copies fly together.
Measured from the constants: tag stagger 480 + price `pop` 220 + `BIDS_PAUSE`
1400 + streams 860 + stake `pop` 220 ≈ **3180 ms** today. The flight replaces
the final 220 ms `pop` with ~540 ms, giving ≈ **3500 ms** against the 4500 ms
`revealBidsMs`. No budget change is required. (`pop` is 220 ms —
`timelines.js:104` — not 150.)

## 8. Bonus round

### 8.1 When it starts

The runout is renamed **bonus round** in player-facing copy only. Internal
identifiers (`runout`, `RUNOUT_CARDS`, `isRunoutCard`, the history `runout`
flag) are server protocol and rules code and do not change.

The bonus round starts when `cardsRemaining <= RUNOUT_CARDS` — i.e. **at the
final auction**, not at the first no-auction flip. Every card still to come
from that point pays double, so the final auction's stake is worth exactly 2×
per card; it is the one auction where not knowing about the doubling costs
most. It is also when the `×2` deck badge already appears
(`table.js:271`), which today precedes the spoken "final five cards" line by a
whole auction.

### 8.2 Two layers, and the planner decides

- **Persistent (state layer).** `#table` carries `.bonus` whenever
  `state.cardsRemaining <= RUNOUT_CARDS`. Derived from the snapshot, so a
  reconnect mid-bonus-round lands in the right state with no animation. It
  warms the felt, gilds the rail, keeps the `×2` badge, and adds a `BONUS`
  label by the deck. The dock carries a "these cards pay double" note during
  the final auction.
- **Planner.** `transitions.js` is the only component that decides what
  animates (`transitions.js:31`), so the cinematic gets its own kind rather
  than a conditional inside `table.js`: `plan()` returns `kind:
  "bonusBidding"` when `next.phase === "bidding" && next.cardsRemaining ===
  RUNOUT_CARDS`. Key-based deduplication already makes it once-only, and
  `meta.hydrate` still short-circuits to `"hydrate"`, so a reconnect never
  replays it. Covered by a `tests/transitions.test.js` case.
- **Cinematic (timeline layer).** `bonusRoundTimeline` sweeps a banner across
  the felt, flares the deck, plays `rise`, ~900 ms.

**Ordering rule.** `drawAll()` runs before the transition switch
(`table.js:571`), and a duplicate snapshot takes `patchLive()` which calls
`renderDock()` again — so "banner, then dock" needs an explicit rule rather
than luck. On `bonusBidding` the dock is given `.pending` (visually hidden,
`inert`) before the timeline starts and it is cleared when the timeline
settles; `renderDock` and `patchLive` must not clear `.pending` themselves.
The draft initialisation and the automatic default-bid send still happen
immediately, so a silent player is still scored; only visibility, focus and
the ring's appearance wait. The 900 ms comes out of a 60 s clock.

**Doubled payouts.** Gold payout sprites likewise cannot key off
`last.runout`, which is false for the first doubled flip. In
`revealCardTimeline` the card just flipped has number `state.flipped.length`,
so the flip is doubled iff `state.flipped.length > deckSize - RUNOUT_CARDS`.

## 9. The rail flash goes

`.rail-flash` — the element built at `table.js:45`, its reset in
`resetTransient` (`table.js:67`), its CSS, and its use in
`revealCardTimeline` (`timelines.js:309`) — is deleted.

Hit feedback becomes local: a gold ring on the flipped card, and a pulse on
every owned stack of the matching suit. Both are **tracked `ctx.animate()`
calls inside the timeline**, never CSS classes on state-layer nodes. That
gives three things for free: the sequencer cancels them synchronously on
`cancelAll`, nothing can leak into the next auction, and `anim.js`'s
`reducedFrames` (`anim.js:26`) supplies the reduced-motion form. The same rule
governs the §8 bonus sweep, deck flare and banner.

## 10. Tutorial

> **Amended 2026-09-14.** Slides 6 and 7 — the two interactive
> calculator slides — were cut, leaving six animated slides. Their net
> deltas were computed as `purchase + N x oneFlipPayout` with no
> `RUNOUT_MULTIPLIER`, so every heart the player pictured landing in the
> bonus round was worth half what the slide claimed; the "doubling is
> deliberately excluded here" note below did not survive contact with
> readers. The worth-of-a-suit lesson moves into slide 5's caption.
> `renderCalculator`, the `instruction` slide field, and the `.calc*` /
> `.tut-stepper` / `.tut-instruction` CSS are gone with them.

Eight slides, ordered so the auction is understood before any modifier.

1. **The goal.** "Bid for the suit on top. Own it, and every later card of that
   suit pays you 10 from each player who sold it to you. Most chips when the
   deck runs out wins." The ×2 sentence is removed from here.
2. **The deal.** Unchanged.
3. **The shuffle.** Unchanged.
4. **The auction.** Secret bids; highest buys; you pay each other player *that
   player's own bid*. The dock's chip stack (§3.4) is demonstrated by an
   **automated** slider sweep — slide 4 is a demonstration, not an
   interactive, so slides 6 and 7 remain the only two interactive slides.
5. **What you own.** The card flies to the buyer and lands as a stack (§7),
   then later cards of that suit pay. Its existing "hearts to come" stepper
   (`controls: true`) is **removed** — the calculator slide has its own,
   separate stepper (`renderCalculator`'s local `later`), and two steppers
   labelled the same way on adjacent slides is a live source of the reported
   confusion. This slide shows a fixed two-heart example.
6. **Interactive — move the bids.** Instruction line: "Drag a bid and watch who
   wins the suit — and who wins the money." Live readout, corrected: in the
   80/50/20 example the buyer pays 50+20 = **70** and collects 10 from *each*
   of two sellers = **20 per heart**, so break-even is **4 hearts**, not 7.
   The formula is `ceil(paid / (CARD_PAYOUT × sellers))`. Also fixes the
   current ungrammatical "You buys hearts" (`tutorial.js:412`).
7. **Interactive — what is it worth.** The calculator's stepper, reframed:
   "How many hearts are left? → the suit is worth about **X** to you", where
   `X = heartsLeft × CARD_PAYOUT × sellers` (sellers = 2 on the tutorial's
   three-seat table). Doubling is deliberately excluded here; it arrives on
   slide 8.
8. **Bonus round.** Last. "The last five cards skip the auction and pay
   double. Suits you already own keep paying — twice as much." Shown with the
   §8 table dressing so the live moment is recognisable.

**Accessibility.** Each calculator slider keeps a distinct accessible name
("You bid", "A bid", "B bid") rather than a shared "their bid"; the
consequence readout gets `aria-live="polite"` so changing a slider or stepper
announces its result, which today only the slide caption does
(`tutorial.js:331`).

**Layout.** The mini-table's bottom-seat furniture currently overlaps the
calculator's first row; with the §3 pod (52 px rather than 115 px tall) the
existing 44 px `padding-bottom` on `.tut-stage` is sufficient, and the
delta badge no longer reaches the slider rows.

## 11. Testing

- **Node unit tests.** `fitRadii` — pods inside the ellipse at 320/360/414/768/
  1200 px for 2, 3 and 4 players; the pinned rx/ry values from §3.1;
  degenerate sizes. The `data-face` dominant-axis rule, including the 3-player
  diagonals. Added to `tests/seat-layout.test.js`, whose four existing tests
  must pass untouched.
- **Planner.** `tests/transitions.test.js` gains: `bonusBidding` is returned
  exactly once at `cardsRemaining === RUNOUT_CARDS`; a duplicate snapshot
  gives `update`; `meta.hydrate` gives `hydrate`.
- **Existing suites.** `tests/config.test.js` and `tests/snapshot.test.js`
  updated for `bidMs`. No other server test should move; if one does, the
  change has leaked past the client.
- **Headless browser.** Per `LEARNINGS.md` the Claude-in-Chrome tab reports
  `document.hidden === true` and freezes rAF, so timelines cannot be verified
  there; verification uses headless Chrome via Playwright.
  **Timing correction:** the LEARNINGS recipe's `REVEAL_BIDS_MS=1500` would
  cancel the bids timeline at ~2.1 s, before the §7 flight ever starts. Use
  `PORT=3011 DEAL_MS=1500 BID_MS=5000` and leave `REVEAL_BIDS_MS` /
  `REVEAL_CARD_MS` at their defaults for any assertion about the flight,
  payouts or the bonus cinematic.
  Assertions: no pod corner outside the felt ellipse at 320/360/414/768/1024;
  no horizontal page scroll; no pod under the dock; the hand row keeps
  height; suit counts visible at every width; the flight reaches the buyer's
  stack and the count settles only on landing; `.bonus` appears exactly once
  and at the final auction; the recap has one cell per history entry with the
  divider before the final auction.
  A red baseline already exists: the harness currently reports all four pods
  outside the felt at both 360 px and 768 px, plus horizontal scroll and a pod
  under the dock at 360 px.
- **Manual.** Chrome device emulation at 360×640 for the sheet, the dock, and
  both interactive tutorial slides.

## 12. Files

| File | Change |
| --- | --- |
| `public/seat-layout.js` | `seatPositions` options arg; new `fitRadii` |
| `public/transitions.js` | `bonusBidding` planner kind |
| `public/js/table.js` | pods, stacks, `#bidStack`, log sheet + open-state contract, `renderRecap`, `.bonus`, `.pending` dock, rail-flash removal |
| `public/js/timelines.js` | card-to-buyer flight + stack handoff, `bonusRoundTimeline`, doubled-flip derivation, local hit feedback |
| `public/js/tutorial.js` | eight slides, corrected arithmetic, a11y, stepper de-duplication |
| `public/index.html` | dock bid stack, `<dialog id="logSheet">`, suit-counts row, recap container, rail-flash element gone |
| `public/styles.css` | pod tokens, stacks, sheet, recap, bonus dressing, height-first table |
| `lib/config.js`, `lib/game.js` | `bidMs` 60000 |
| `tests/seat-layout.test.js`, `tests/transitions.test.js`, `tests/config.test.js`, `tests/snapshot.test.js` | assertions above |

## 13. Risks

- **`table.js` size.** 649 lines today, and this adds the recap, the sheet and
  pod geometry. Past ~800 lines the recap and the log sheet move to their own
  ES modules under `public/js/`, following `lobby.js`.
- **Stack legibility at 320 px.** Four suits × four edges at 16 px is the worst
  case; if it does not read, suits beyond the first two degrade to
  symbol-plus-count pills rather than wrapping the row.
- **`index.html` is read once at startup** (`server.js`), so the server needs a
  restart for markup changes.
