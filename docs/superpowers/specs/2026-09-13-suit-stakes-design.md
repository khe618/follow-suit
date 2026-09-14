# Follow Suit — suit stakes

Date: 2026-09-13
Status: approved 2026-09-13 (Codex-reviewed; ties kept void by the owner)
Builds on: `2026-09-12-follow-suit-design.md` (rules, server) and `2026-09-13-game-feel-design.md` (client). Everything in those specs stays in force except where this one amends it. Where the two older specs disagree with each other, this spec's section 2.1 is authoritative.

## 1. Goal

Replace the core bet with one that is lower variance, rewards estimation, and makes every bid a price the bidder may actually transact at.

Today a player buys the right to be paid 100 if the *next* card matches the reference suit. Fair value is usually around 25 and the outcome is 0 or 100, so one auction's noise is about twice the whole skill edge. And a losing bid is free, so a player who does not want to win has no reason to bid carefully.

After this change a player buys the reference **suit** for the rest of the deal: every later flip of that suit pays the owner 10 from each player who sold it to them. The payoff is a count, not a coin flip. And the buyer pays each seller **that seller's own bid**, so a losing bid is the price you sell at. Selling cheap costs money on every loss, and bidding above your value to sell dear risks becoming the buyer against a table that bid between your value and your bid, which costs more. Both directions of misreporting are punished, so the natural bid is close to what you think the suit is worth, adjusted for what you expect the others to do: a seller who expects a high bidder shades up a little, a buyer who thinks the others are cheap overbids to sweep them. That tension, plus the winner's curse (the highest estimate still buys), is the strategy the game is about.

Everything else about the product stays: the table, the deal, the dealing phase, bots, quick play, rooms, resume, the bid log, the results overlay. Out of scope, unchanged: accounts, persistence, spectators, a fair-value debrief, bots that read other players' bids.

## 2. Rules

### 2.1 Unchanged, and the authoritative numbers

Materials (a 40-card pool, 10 per suit, no ranks), the deck (the dealt hands shuffled together), the set-aside pool, the first flip, scores as a running tally that may go negative, competition ranking at the end, hands revealed at the end. Sections 2.1 to 2.3 and 2.5 of the v1 spec.

Player counts and hand sizes, as implemented in `game-core.js` (the v1 spec's "cap is 6" and the game-feel spec's "four cards" are stale):

| Players | Hand | Deck | Auctions |
| --- | --- | --- | --- |
| 2 | 10 | 20 | 19 |
| 3 | 7 | 21 | 20 |
| 4 | 5 | 20 | 19 |

Maximum four players.

### 2.2 An auction

One auction per card in the deck except the last. Auction `k` is for deck card `k`, the **reference card**, which is face up when bidding opens.

1. **Bidding.** Every player submits a sealed integer bid from 0 to 100. A bid is a price **per counterparty**. Bidding ends when every player has locked or when the timer expires. A player with no submitted bid at the deadline bids 0. The client sends the dock's default as soon as the auction opens (section 4.2), so a connected player who does nothing bids the public prior.
2. **Reveal bids.** All bids are shown with names. The highest bid wins. Every player with a bid equal to the highest is a **buyer**; everyone else is a **seller**. If **every** player ties there are no sellers and the auction is **void**: no purchase and no new stake. The flip still happens and stakes from earlier auctions still pay on it (section 2.4).
3. **Purchase.** Each buyer pays each seller **that seller's bid**. Each buyer now holds a **stake** on the reference suit against each seller. A stake is `{ auction, suit, buyers, sellers }`.
4. **Flip.** The next deck card is flipped. It becomes the next reference card.
5. **Payout.** For every stake on the flipped card's suit, from any earlier auction including the one just settled, each seller of that stake pays each buyer of that stake **10**. Stakes never expire; an owner collects on every later flip of the suit until the deck runs out. Co-buyers of a tied stake do not pay each other.

For every buyer–seller pair the trade happens at the lower of the two bids, which is always the seller's. That is the sense in which this is "second price, pairwise".

Settlement with buyers `B`, sellers `S`, bids `b`, and `CARD_PAYOUT = 10`:

- purchase, buyer `i`: `−Σ_{s∈S} b_s`; seller `s`: `+b_s · |B|`
- payout on a flip of suit `c`: for each stake `(B_j, S_j)` with suit `c`, buyer `i ∈ B_j`: `+10 · |S_j|`; seller `s ∈ S_j`: `−10 · |B_j|`

Both legs sum to zero across the table.

### 2.3 Worked examples

Three players, reference hearts, bids A 80, B 50, C 20. Purchase: A −70, B +50, C +20. A holds hearts against B and C. Each later heart: A +20, B −10, C −10. If four hearts follow, A nets −70 + 80 = +10; the bid of 80 said A expected eight, so A overpaid. B and C, who sold at 50 and 20, end at +10 and −20 on the stake: C sold too cheap.

Four players, bids A 60, B 60, C 30, D 10 (tie). Purchase: A −40, B −40, C +60, D +20. Each later flip of the suit: A +20, B +20, C −20, D −20.

Three players, bids A 5, B 0, C 0. Purchase: nothing changes hands. A holds the suit; each later flip pays A +20. Bidding 0 is no longer free.

Two players, bids 44 and 44 (both silent at the public prior): void. Nothing is bought; if either player already owns the flipped suit from an earlier round, that stake still pays when the card turns.

A card step with two stakes on hearts, one held by A against `{B, C, D}` from auction 2 and one held by C against `{A, B, D}` from auction 5, when a heart flips: A gets 10 from each of B, C, D and pays 10 to C; C gets 10 from each of A, B, D and pays 10 to A. Net: A +20, B −20, C +20, D −20. Two stakes were **hit**; the client draws the streams netted per ordered pair: B→A 10, D→A 10, B→C 10, D→C 10, and A↔C cancels to nothing.

Two players, A holds hearts against B from auction 1 and B holds hearts against A from auction 3. A heart flips: both stakes are hit, the two payments cancel, no chips move, both deltas are 0. This is the "payments cancel" case in section 4.4.

### 2.4 Void auctions

An all-way tie is void: `buyers` and `sellers` are empty, the purchase deltas are all zero, no stake is created, and the entry is marked `void: true`. Void affects only the current auction. The card step is unchanged: the next card is flipped and every existing stake on its suit pays exactly as it would after a normal auction, so a void entry can still carry non-zero payouts and deltas. The owner accepts that a fully passive table (every player silent at the same public prior) trades nothing; the case is unlikely at a real table and a coin-flip buyer was judged worse than no trade.

### 2.5 What is public

Everything in v1 section 2.6, plus every stake: the auction that created it, its suit, its buyers, its sellers. After each auction the record also shows each player's purchase delta and, after the flip, the number of stakes hit, the netted payout streams, and the round's net delta.

## 3. Server

### 3.1 `public/game-core.js`

- `PAYOUT` becomes `CARD_PAYOUT = 10`. `MAX_BID` stays 100 (the largest possible stake is 9 cards, worth 90).
- `resolveBids(bids)` returns `{ topBid, buyers, sellers, void }` as today except that `price` is renamed `topBid`, because it no longer names an amount that changes hands. An all-way tie has empty `buyers` and `sellers` and `void: true`.
- `settlePurchase(bids)` replaces `settle`: `resolveBids` plus `deltas`, the purchase deltas above, initialised to 0 for every id in `bids`. Void returns all-zero deltas.
- `settleFlip(stakes, suit, playerIds)` returns `{ hits, payouts, deltas }`. `hits` is the number of stakes whose suit is `suit`. `payouts` is the list of `{ from, to, amount }` for every ordered pair that owes money after netting every hit stake, ordered by `playerIds` (from, then to), zero pairs omitted. `deltas` is the net per player, initialised to 0 for every id in `playerIds`. No hit stakes: `hits 0`, `payouts []`, all-zero deltas.
- `priorValue(flipped, cardsRemaining)` returns `clamp(round(10 · cardsRemaining · (10 − F_s) / (40 − k)), 0, MAX_BID)` for the reference suit `s` (the last card in `flipped`), where `F_s` is that suit's count among the flipped cards and `k` is `flipped.length`. From a viewpoint with no hand, each remaining deck card is a uniformly random unseen pool card, so this is the expected remaining count of `s`. It is public arithmetic and lives in the shared module.

### 3.2 `lib/game.js`

State gains `stakes: []`, reset by the same full match reset as `history`. `playerIds()` is the frozen seat order of `game.players`.

- **Resolve** (deadline or all locked): missing bids become 0, `settlePurchase(bids)`, apply the purchase deltas to scores **now**, push the history entry, push the stake unless void, enter `reveal/bids`, arm the bids timer. Scores therefore already include the purchase when the `reveal/bids` snapshot is built. This replaces v1's rule that the server applies one net delta at the card step; two legs of different kinds are simpler when each is applied where it happens.
- **Flip** (after `revealBidsMs`): flip the next card, `settleFlip(stakes, card, playerIds())` over **all** stakes, apply its deltas, complete the history entry, enter `reveal/card`, arm the card timer.
- **Advance** (after `revealCardMs`): if cards remain, start the next auction with the flipped card as reference; else results.

History entry, exact shape:

```
{ index, reference, bids, buyers, sellers, topBid, void,
  purchase,            // { [id]: number } for every player, set at resolve
  flipped,             // suit, null until the card step
  hits,                // number, null until the card step
  payouts,             // [{ from, to, amount }], null until the card step
  deltas }             // { [id]: purchase + payout } for every player, null until the card step
```

`price` and `matched` are gone. Timer discipline, idempotent resolution, disconnect handling, and bot scheduling are unchanged.

### 3.3 `lib/fair-value.js`

The existing enumeration over compositions `U` already computes weights `w(U)` and the deck `D = H + U`. Add `expectedRemaining({ hand, flips, playerCount })` returning, per suit, `Σ_U w(U) · (D_s − F_s)`: the expected number of that suit still in the deck. `nextSuitProbabilities` stays (it is `expectedRemaining / (|D| − k)`) because its tests pin the enumeration against a Monte Carlo. `fairValue({ hand, flips, playerCount, reference })` becomes `CARD_PAYOUT · expectedRemaining[reference]`. Still server-only, still never served.

### 3.4 `lib/bots.js`

Shape unchanged: `clamp(round(fair · shade + N(0, σ)), 0, 100)`, and bots still do not read other bids. The profiles are re-tuned around 1.0 because under sell-at-own-bid a bid below fair sells cheap on every loss:

| Profile | Shade | σ | Behaviour |
| --- | --- | --- | --- |
| careful | 0.95 | 2 | rarely buys, sells a touch under fair |
| fair | 1.00 | 2 | bids its estimate |
| keen | 1.05 | 3 | sells a touch over fair, buys a little too often |
| wild | 1.12 | 6 | buys often and overpays: the winner's curse on display |

Modelling opponents' bids (the "bid just under the likely winner" strategy) is deferred; see the decisions log.

### 3.5 `lib/snapshot.js` and the wire protocol

Seated `state` gains `stakes`: in every in-match phase the full list, each `{ auction, suit, buyers: [...], sellers: [...] }` with the arrays copied; in the lobby `[]`. History entries are copied field by field: `bids`, `purchase`, and `deltas` as new objects, `buyers`, `sellers`, and `payouts` as new arrays (each payout as a new object), scalars as is; the null-until-card-step fields are sent as `null` before the card step, never omitted. `players[].score` in `reveal/bids` includes the purchase. Nothing else changes; the secrecy assertions stay: no deck, no other hands before results, no other bid amounts before reveal, no fair value.

### 3.6 Config

`revealCardMs` default rises from 5000 to 6000 (`REVEAL_CARD_MS`), updated in `lib/config.js`, `lib/game.js`, and both tests that assert it. The card timeline's worst case is about 4.7 s (section 4.4) and 5000 left too little slack before the next snapshot cancels it. `revealBidsMs` stays 4500.

## 4. Client

### 4.1 `public/transitions.js`

- `displayScores` is removed: the state layer renders `players[].score` directly in every phase, because the server now applies each leg when it happens.
- `legBaseline(state)` replaces `payoutBaseline`: in `reveal/bids` it returns `score − purchase[id]` (the scores before the purchase chips fly); in `reveal/card` it returns `score − (deltas[id] − purchase[id])` (the scores before the payout chips fly); elsewhere it returns the raw scores. A void entry has an all-zero purchase, so at `bids` it is the identity; at `card` it still undoes the payouts, which a void round can have.
- `paymentStreams(entry, ids, step)`: at `bids`, one stream per buyer–seller pair carrying **the seller's bid**, zero bids omitted, so a void entry yields none; at `card`, `entry.payouts` as is (already netted and ordered by the server), void or not.
- `CARD_TIMELINE_MS`, the worst case of the reveal-card timeline, exported next to `DEAL_TIMELINE_MS` and asserted in a Node test to be at most the config default `revealCardMs`.
- `plan` and `transitionKey` are unchanged.

### 4.2 The dock

Under the bid number, a small hint reads the bid as cards: `4.7 cards` for a bid of 47 (`(amount / 10).toFixed(1)`), so the number people type is always tied to the thing they are estimating. The default draft for each auction is `priorValue(flipped, cardsRemaining)` instead of the constant 25. The rest of the dock (slider, steppers, ring, Bid/Locked button) is unchanged.

### 4.3 Seats

Each seat gains a **stake row** under the score: one small suit chip per suit the player owns at least one stake on, showing the glyph and, when more than one, a count (`♥×2`). Rendered from `state.stakes` on every render, so hydration mid-game is correct. Hearts and diamonds use the red suit colour as elsewhere. Aria: the seat label gains `, holds hearts ×2`.

### 4.4 Timelines

**Reveal bids.** Tags rise from lowest to highest as today; the buyers' tags turn gold. The badge over the deck shows the reference suit glyph and the winning bid (`♥ 80`) and is labelled, in its aria text, "winning bid"; there is no single price to show, since each seller's tag is that seller's price. A void auction shows the grey `no trade` badge as today, is announced "No trade", and skips the streams. Announcement otherwise: "Maya buys hearts" or "Maya and Ben buy hearts". Then the purchase streams: each buyer to each seller, carrying the seller's bid, ticking scores from `legBaseline` to `state` scores. When the streams land, the buyer's new stake chip pops into the stake row.

**Reveal card.** The flip and the comparison beat are unchanged. The rail flashes gold when `hits > 0`; there is no flash otherwise. The match/miss colours are gone. Sound: the two-note chime if the recipient's payout delta is positive, the low thud if negative, a tap otherwise. Announcement, by `hits` and `payouts`: "Hearts. No stakes" (`hits 0`), "Hearts. Payments cancel" (`hits > 0`, `payouts` empty), else "Hearts. Maya collects 20" naming each player with a positive payout delta. Then the payout streams, ticking from `legBaseline` to `state` scores, then the round-delta badge under each score as today (net of both legs, so a round with a tiny purchase and a big payout shows the sum), then the tags and buyer glow fade.

Worst case with streams: 120 + 620 + 800 + 280 + about 860 (streams) + 150 + 1300 + 250 + 300 ≈ 4.7 s. `CARD_TIMELINE_MS = 4800`.

### 4.5 Bid log and results

The log's Bids view is unchanged (each player's bid per reference card, buyer cells gold). The Payouts view shows the round's net delta for every settled round, including void rounds, since a void round can still pay on older stakes; the dash is reserved for the pending column.

Results history table columns: `#`, `Ref`, `Bids`, `Buyer`, `Flip`, `Score change`. `Buyer` lists the buyers' names, or `void`. `Flip` shows the flipped suit and, when `hits > 0`, `· n stake` / `· n stakes`.

### 4.6 The tutorial

Six slides, same mini table. Captions and animations change where the rule changed:

1. **Objective.** A heart sits on the slot; a `♥` stake chip lands on your seat; the top card turns over, a heart, and chips fly from both other seats to you; it turns again, another heart, chips again. Caption: "Each round you bid for the suit on top. Own it, and every later flip of that suit pays you 10 from each player who sold it to you. Most chips when the deck runs out wins."
2. **Deal.** Unchanged.
3. **Shuffle back.** Unchanged.
4. **Bid.** Tags rise to 20, 50, 80; the 80 glows gold. Caption: "Everyone bids 0 to 100 in secret. The highest bid wins the suit and pays each other player the price that player bid. If two tie at the top, both buy."
5. **Pay.** Chips fly 50 and 20 from the buyer to the two others; a stake chip lands on the buyer. The card turns over beside the reference: a heart, and 10 flies back from each. A stepper labelled `hearts to come` (1 to 9, default 4) means the total number of later hearts **including the one shown**; changing it replays the flip beat that many times and the slide ends on the net badges, `purchase + N × oneFlipPayout`. Caption: "You pay each player their bid. Every later heart pays you 10 from each of them, so a bid of 47 says you expect about 4.7 more."
6. **Try it.** Three sliders labelled You, A, B and the same `hearts to come` stepper (0 to 9), with live net deltas beside each slider computed with `settlePurchase` and `settleFlip` as `purchase + N × oneFlipPayout`. Ties show all top bidders as buyers; an all-way tie shows "no trade". Caption: "Move the bids. Notice who wins the suit and who wins the money."

### 4.7 Text inventory

New or changed strings: the dock's `n.n cards` hint, the badge's suit glyph and "winning bid" aria label, `holds` in seat aria labels, the `Buyer` and `Flip` column headers, `· n stakes`, the tutorial captions above, and the announcements "{name} buys {suit}", "{Suit}. {name} collects {n}", "{Suit}. Payments cancel", "{Suit}. No stakes". `no trade` stays; `match` and `miss` leave the text inventory.

### 4.8 Documentation

`AGENTS.md`'s one-paragraph description of the game changes to the new rule. The v1 spec keeps its history; this spec is the rule of record for the bet, settlement, ties, and player counts.

## 5. Testing

All with `npm test`.

- `game-core`: `settlePurchase` reproduces every worked example in section 2.3 exactly and is zero-sum for a range of bid sets including partial ties; an all-way tie is void with empty buyers and sellers and all-zero deltas; `settleFlip` reproduces the two-stake example, nets opposing stakes per pair, reports `hits`, omits zero pairs, returns the two-player full-cancellation case as `hits 2, payouts []`, returns nothing for a suit with no stakes, initialises every player's delta from `playerIds`, and is zero-sum; `priorValue` gives 44 for auction 1 of a 4-player game (19 remaining, one card of the suit flipped) and clamps.
- `fair-value`: `expectedRemaining` sums over suits to `|D| − k`; with no flips equals the closed form `hand_s + (P−1)·n·(10 − hand_s)/(40 − n)`; flipping a card of a suit lowers that suit's expectation by less than one card (seeing the suit raises the deck's expected count of it) and raises no other suit's; `fairValue` is `10 ×` the reference suit's expectation; the existing Monte Carlo test stays for `nextSuitProbabilities`.
- `bots`: existing assertions with the new profile table; the shade test still gets `round(fair · shade)` at σ 0.
- `game`: the purchase is applied to scores at resolve and the `reveal/bids` snapshot shows it; a stake is recorded unless void; the card step pays every stake on the flipped suit including ones from earlier auctions, pays an older stake even when the current auction's suit differs, and pays an older stake after a void auction; the last flip pays out and leads to results with no pending timers; two consecutive games share no stakes; existing timer, lock, and disconnect tests updated for the new entry shape.
- `snapshot`: `stakes` present and public in every in-match phase and `[]` in the lobby; the exact history entry key list per phase, with the card-step fields `null` before the flip; copies are not aliased to game state; forbidden keys unchanged.
- `transitions`: `legBaseline` undoes exactly one leg in each reveal step and is the identity elsewhere; `paymentStreams` at `bids` carries each seller's bid and omits zeros; at `card` returns `entry.payouts`; `CARD_TIMELINE_MS ≤` the config default `revealCardMs`.
- `server`: existing socket tests updated for the entry shape; one full quick-play game reaches results with scores equal to the sum of history deltas.
- Manual in Chrome (or headless Chromium, see `LEARNINGS.md`): one quick-play game; the purchase streams carry each seller's bid; stake chips appear on the buyer; a later flip of an owned suit pays with the gold flash; the round badge equals the log's Payouts cell; the tutorial calculator agrees with section 2.3; reload mid-reveal draws the right scores.

## 6. Decisions log

- Stake instead of next-card bet: chosen by the owner to cut variance and make bids about a count. Considered and dropped: two-sided quotes with a spread cap (too many decisions per round), an exchange-style crossing of quotes (market making felt convoluted), and a median-price call market (loses the single winner).
- Pairwise second price (buyer pays each seller that seller's bid) instead of first price or a single second price: it is the smallest change that makes every bid a real price. Codex review pointed out, correctly, that this does not make bids truthful: sellers shade up toward the expected winner and buyers may overbid to sweep cheap sellers. The owner's view, kept in section 1: both directions of misreporting cost money, so bids land near value with a strategic lean, and that lean is the game.
- Payout of 10 per card per counterparty, bids in chips 0..100 with a cards hint: keeps the slider and MAX_BID as they are, and a bid of 47 reads naturally as 4.7 cards.
- Server applies each leg where it happens: with a purchase leg and a payout leg of different kinds, deriving an interim display score on the client was more machinery than it saved.
- Stakes are public, including sellers: the game is about reading the table, and the sellers are implied by the buyers anyway.
- The default bid is the public prior, not 25, so a silent player does not give the suit away. Every silent player then bids the same number, so a fully passive table ties and trades nothing; Codex proposed a random tie-break buyer, and the owner chose to keep ties void as the simpler rule, judging the case unlikely at a real table.
- Bots still ignore other bids and only had their shades re-centred: a policy that models opponents is the natural next step once humans have played the rules.
- `price` renamed `topBid`: in a game meant to teach prices, the field should not name a number nobody pays.
