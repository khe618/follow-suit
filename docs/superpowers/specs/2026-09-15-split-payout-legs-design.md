# Split payout legs — design

Amends `2026-09-13-table-ui-overhaul-design.md` (the log sheet, the results
recap) and `2026-09-13-game-feel-design.md` (the reveal choreography).
Everything not named here is unchanged.

## 1. Why

A round moves money twice, for opposite reasons:

- the **auction leg** — the buyer pays each seller that seller's own bid,
  settled the moment the bids are revealed;
- the **card leg** — the flipped card pays 10 (20 in the bonus round) per
  seller to the owner of every stake it hits, settled at the flip.

The server has always kept the two apart (`entry.purchase` and
`entry.payouts`), but every number the player saw was `entry.deltas`, which is
their sum. A single figure cannot answer the question the game is actually
about: *did I pay too much, or did the card just not come?* Paying 145 for
hearts and collecting nothing reads as "−145"; so does paying 45 and being
paid 100 by a suit that keeps missing elsewhere. Netting hides the winner's
curse at the exact moment it should be most obvious.

Nothing about the rules or the settlement changes. This is entirely what is
shown.

## 2. The legs

`Transitions.legDeltas(entry, id) → { purchase, payout }` is the one place the
split is derived. `purchase` comes straight from the entry; `payout` is
`deltas − purchase`, because the server sends the auction leg and the round
total. **`payout` is `null` until the flip settles**, which is not the same as
zero and must never render as one — a round whose bids are revealed but whose
card has not turned has a real auction leg and no card leg yet. `legBaseline`
now derives the card leg through the same helper instead of repeating the
subtraction.

No protocol change: both fields were already in the snapshot.

## 3. Where the split shows

### 3.1 The reveal, as two beats

The two legs already settle at different moments and their chips already fly
separately, so each beat now ends with its own seat badge and no beat ever
shows a sum:

- **bids reveal** — after the purchase chips land and the bought card flies to
  the buyer, every seat pops the auction leg.
- **card reveal** — after the payout chips land, every seat pops the card leg.

`deltaBadges()` is the shared beat. A card that hits nothing puts a `0` on
every seat, which is the point: it says the card paid nothing, next to an
auction leg that may have been large. A **void** auction is the one round with
no auction badge — nothing traded, every leg is zero, and the price badge
already says "void". The announcements follow suit — the bids
beat says what you paid, the card beat says what the card paid — instead of
one announcement carrying the round total.

**Budget.** The badge beat costs `DELTA_IN + DELTA_HOLD + DELTA_OUT` = 1700 ms,
and the bids timeline was already ~3380 ms against a 4500 ms phase. So
`revealBidsMs` goes to **6000 ms** (matching `revealCardMs`), for ~5080 ms of
timeline and ~900 ms of slack. Per the 2026-09-13 learning, that default lives
in four places — `lib/config.js`, `lib/game.js`, `tests/config.test.js` and
`tests/snapshot.test.js` — and all four move together.

### 3.2 The log sheet and the results recap

Both show the two legs on separate lines in one cell, auction above, card
payout below, divided by a hairline. Never summed, and no toggle: seeing both
at once is the entire point. A runout round has no auction at all, so its
auction line reads as an en dash rather than a zero someone has to interpret;
an unsettled card leg reads as a middot.

The log sheet's Bids/Payouts toggle is unchanged, and a legend appears in the
payouts view naming the two lines.

The toggle still defers its repaint while a timeline runs, and that guard has
to stay. The log looks independent of the table, but it is not: re-rendering
it changes its height, the log is part of the chrome measured into
`--chrome-h`, `--chrome-h` sizes the table, and the ring observer answers a
table resize with a full `renderSeats()` — which replaces the very stake
stacks and score nodes a running reveal holds references to. A mid-reveal
toggle would therefore fly the bought card at a detached stack and snap scores
to their final values before the chips landed. What changes is only that
`renderLog` now paints the legend, so the legend can never describe a table it
did not render while the repaint waits for the next full draw.

The recap's `aria-label` reports all three numbers — auction, card, and the
round they add to — so the sum is still available to a screen reader even
though no cell prints it.

## 4. Tests

`legDeltas` is unit-tested in `tests/transitions.test.js`: the legs add back to
the round the server settled, an unsettled entry yields `payout: null` (not
`0`), a runout round is all card leg, and an unknown player is zeroes rather
than a throw. The rendering itself is covered the way the rest of the client
is — a headless run against a real server, checked by eye.
