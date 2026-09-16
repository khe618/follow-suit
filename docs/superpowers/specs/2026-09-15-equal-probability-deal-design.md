# Equal-probability deal — design

Amends `2026-09-12-follow-suit-design.md` (sections 2.1, 4.6) and
`2026-09-13-suit-stakes-design.md` (sections 2.6, 4.x dock). Everything not
named here is unchanged.

## 1. Why

The deck was cut from a 40-card pool holding exactly 10 of each suit. That
made suits scarce: six spades in your hand meant only four could be anywhere
else, so a lopsided hand told you as much about the *other* hands as about
your own. It is a real inference, but it is the wrong one — it is a fact about
the pool, not about the market — and it is hard to hold in your head while
bidding. Cards are now dealt with equal probability instead, so what you learn
comes only from the cards you can actually see.

## 2. Rules

### 2.1 The deal (amends v1 §2.1)

Every card dealt is an independent uniform draw over the four suits. There is
no pool, no per-suit cap, and nothing is set aside. Hand sizes are unchanged
(10 / 7 / 5 for 2 / 3 / 4 players), and the deck is still exactly the dealt
hands shuffled together, so the deck is `P · n` cards as before.

Consequences that matter at the table:

- A suit is no longer capped at 10. All twenty cards of a two-player deal can
  be spades. This is rare, not impossible, and nothing in the rules or the
  settlement cares.
- Your hand carries **no** information about anyone else's. It is informative
  only because it *is* part of the deck — a quarter to a half of it.
- The flips remain informative: they tell you what has already left the deck,
  including cards from hands you never saw.

### 2.2 Fair value (amends v1 §4.6)

Same shape, one weight changes. From one player's view the unseen part of the
deck `U` (the other hands) is `(P−1)·n` independent uniform draws rather than a
subset of a finite pool, so its composition is multinomial:

```
q(U) = Multinomial(U ; (P−1)·n, ¼ each) · MVH(F ; D)      with D = H + U
w(U) = q(U) / Σ_V q(V)
P(next = s | H, F) = Σ_U  w(U) · (D_s − F_s) / (|D| − k)
```

The sum runs over every composition `U` of `(P−1)·n` into four suits with
`D_s ≥ F_s`; the `U_s ≤ 10 − H_s` cap is gone. Dropping the factors constant
across `U`, the log weight is `Σ_i [ logC(D_i, F_i) − log(U_i!) ]`. At most 816
compositions, so the exact sum stays cheap. Log-sum-exp normalisation as
before.

Sanity check that pins it: with no flips, `E[remaining_s] = H_s + (P−1)·n/4`,
independent of the rest of the hand. A two-player hand of 6/2/2/0 expects
8.5 spades in the deck (was 7.33 under the pool).

`cardValue`, `fairValue`, the bonus round and the bot profiles are untouched.

### 2.3 The dock no longer suggests a bid (amends suit-stakes §2.6)

Each auction's bid now opens at **0**, not at the public prior. `priorValue`
is deleted from `game-core` — handing every player a computed estimate of the
card's worth undercuts the one thing the game asks them to do. A silent player
still scores 0, exactly as before; the dock sends the opening 0 as soon as the
auction opens so the number on screen is always the real bid.

## 3. Client

### 3.1 The bid slider

Three defects, one visible symptom ("I slide it and the bid doesn't change"):

- **The unlock was debounced.** Moving the slider unlocks the bid, but the
  message carrying `locked: false` waited 150 ms behind the amount debounce.
  In that window the server still held a *locked* bid, so the next bot bid
  could complete `allLocked()` and resolve the auction at the old amount,
  silently discarding the drag. The unlock is now sent immediately; only the
  amount is debounced.
- **The last value of a drag could stay in the debounce.** `input` fires all
  through a drag and is debounced 150 ms, so the value the finger stopped on
  could still be pending when the deadline fired or the socket dropped, and the
  auction resolved at whatever went out before it. Both controls now also
  listen for `change` — one event, fired when the control is committed
  (pointer up, blur, Enter) — and send that value straight away. Measured at
  2 ms after release, against a 150 ms debounce. The same handler writes the
  clamp back, so a typed 150 now shows the 100 it actually bids.
- **The gesture was stolen.** The range input had no `touch-action`, so a drag
  that wandered a few pixels off the horizontal was claimed by the page as a
  scroll and the bid stopped following the finger. It is now
  `touch-action: none`, in a 44 px-tall hit box.

One boundary remains and is accepted: if a bot's bid is processed before the
immediate unlock arrives, the old locked bid still resolves. Removing the
artificial delay is all a client can do; it cannot win a network race.

### 3.2 Four-colour deck

Spades black, hearts red, diamonds blue, clubs green, as four `--suit-*`
custom properties, plus lightened `--suit-*-felt` variants for the chips and
glyphs that sit straight on the felt rather than on a card face.

### 3.3 Phone layout

At 390 px the felt is ~366 px wide, of which a seat pod, the centre cluster
and another seat pod wanted ~305 px. Seats ended up 20 px from the deck. Three
things give ground below 480 px so the fitted seat ring can push back out:

- pods drop to 82 × 48 (the rule that already existed below 380 px, raised to
  cover every phone),
- the page gutter drops from 12 px to 4 px,
- the rail thins from 15 px to 10 px. Rail width becomes `--rail-w`, which
  `measureRing()` reads instead of its previous hard-coded 15 — CSS and the
  seat geometry can no longer disagree.

The winning-bid badge also climbs to `top: -46px`, clear of the two side
seats' bid tags, which sat on exactly its line.

Measured pod-to-centre gap: 20 → 40 px at 390 px, 19 → 30 px at 360 px. The
table's own size formula is unchanged.

## 4. Tests

- `deal` is uncapped and uniform: an all-one-suit deal is reachable, a suit
  exceeds 10 over many deals, and each suit takes about a quarter of the draws.
- `fair-value` keeps its seeded Monte Carlo, now sampling the new dealing
  procedure by rejection; the closed forms become `H_s + (P−1)·n/4`.
- A new `tests/helpers/deal.js` gives the game and snapshot tests a
  deterministic deal (player 1 all spades, player 2 all hearts, …, shuffle the
  identity), replacing the old `randomInt: (n) => n − 1`, which under the new
  deal yields four identical all-clubs hands.
- `priorValue`'s test is deleted with the function.
