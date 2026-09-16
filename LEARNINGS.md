# LEARNINGS — follow-suit

Durable findings — past bug fixes, non-obvious behavior, tooling quirks. Add when something surprised us; read when starting work here. Newest entries at the top.

---

## 2026-09-15 — A locked bid plus a *debounced* unlock let the server resolve an auction at the previous amount

**Symptom / context:** Dragging the bid slider sometimes had no effect on the amount actually bid. Nothing threw, no error surfaced, and the dock kept showing the new number, so only the settled score disagreed. Intermittent, because it needed a bot bid to land in a 150 ms window.

**Root cause:** `setDraftAmount` in `public/js/table.js` set `draft.locked = false` *locally* and then routed the message through the amount debounce (`scheduleBidSend(false)`). `allLocked()` in `lib/game.js` reads the server's **stored** locked flag, not the client's, so for those 150 ms the server still believed the player was locked. Any bot bid arriving in the window completed `allLocked()` and called `resolve()` using the previous amount; the drag was discarded silently. A second hole on the same path: `input` fires all through a drag and is debounced, so the value the finger stopped on could still be pending when the bid deadline fired or the socket dropped, and the auction resolved at whatever had gone out before it.

**Fix / what to do next time:** Send the unlock immediately — `scheduleBidSend(wasLocked)` — so only the amount is debounced. Separately, both bid controls now also listen for `change` (one event, fired on pointer up / blur / Enter) and send that value straight away; measured 2 ms after release against the 150 ms debounce. That handler also writes the clamp back, so a typed 150 shows the 100 it bids. The general rule: **when a server-side readiness check (`allLocked`, a quorum, an "everyone ready" gate) reads state the client mutates optimistically, the message that CLEARS readiness must never be debounced — only the payload may be.** One boundary is irreducible: if a bot's bid is processed before the immediate unlock arrives, the old locked bid still resolves; a client cannot win a network race.

**Refs:** `public/js/table.js` (`setDraftAmount`, `scheduleBidSend`, the `change`/`commitDraft` listeners); `lib/game.js` `allLocked`/`bid`/`resolve`; `docs/superpowers/specs/2026-09-15-equal-probability-deal-design.md` §3.1.

## 2026-09-14 — The first doubled card belongs to a `runout: false` history entry

**Symptom / context:** Building the bonus-round dressing and the results recap, the obvious derivation — "this flip pays double if `last.runout`" — silently missed the single most important doubled payout, and grouped the recap one cell off.

**Root cause:** `advance()` checks `isRunoutCard(game.flipIndex, deckSize)` against the card *just flipped* (the would-be next reference), so the last auction is the one whose reference is card `m-5`. Its payoff flip is card `m-4`, which is already inside the doubled tail — but it is settled by `flipAndPay()` on that auction's own history entry, which has `runout: false`. Only the remaining four cards get `runout: true` entries. So a 20-card deck has five doubled flips but only four runout entries.

**Fix / what to do next time:** Never derive doubling from the `runout` flag. Use card position: `deckSize = state.flipped.length + state.cardsRemaining`, and card number `n` is doubled iff `n > deckSize - RUNOUT_CARDS`. In `revealCardTimeline` the card just flipped is number `state.flipped.length`. Verified empirically: gold payout chips separated 126/0 in the bonus round against 0/210 in normal rounds. Related: the bonus round is defined to *start* at the final auction (`cardsRemaining <= RUNOUT_CARDS`), which is also when the ×2 deck badge already appeared.

**Refs:** `lib/game.js` `advance`/`flipAndPay`/`runoutStep`; `public/js/timelines.js` `revealCardTimeline` (`doubled`); `public/js/table.js` `renderRecap`; `AGENTS.md` architecture notes; commit 66c0dcd.

## 2026-09-13 — A `document.activeElement` guard froze the bid number, because the dock focuses it for the whole auction

**Symptom / context:** Dragging the dock's bid slider moved the slider and the bid stack but left the big ring number stale (slider 77, number still 55). Nothing threw, and the bid actually sent was the slider's value, so only the number lied.

**Root cause:** `setDraftAmount` wrote the number input only when it did *not* hold focus (`document.activeElement !== els.bidInput`), a guard meant to keep a rewrite from fighting the caret while typing. But the bidding phase focuses `bidInput` as soon as the dock opens, so the guard was true for the entire auction and every non-typing update skipped the number.

**Fix / what to do next time:** Take the originating element as an explicit `source` argument and skip only that control, instead of inferring "the user is typing here" from focus. Any `activeElement` check is unsafe in a UI that focuses something on phase entry — pass provenance rather than reading global focus.

**Refs:** `public/js/table.js` `setDraftAmount` and the `bidInput`/`bidRange` listeners; the focus call in the bidding branch of `render`.

## 2026-09-13 — Animation beats cannot be verified in the Claude-in-Chrome tab; use headless Playwright, and change phase-timer defaults in three places

**Symptom / context:** Reworking the round-P&L badge in `public/js/timelines.js`, the MCP tab never showed a `.delta-badge` at all (MutationObserver on `#seats` recorded nothing across several auctions) while the log and seat scores kept updating. Separately, bumping the reveal-card default made two unrelated-looking tests fail one after another.

**Root cause:** the MCP tab reports `document.hidden === true` even when its window is foreground, so Chrome freezes rAF and Web Animations and `anim.js` timelines never advance (details and the cross-project workaround in the global `claude-code.md` log). The phase-timer defaults are duplicated: `lib/config.js` (env fallback) and `lib/game.js` `DEFAULT_CONFIG`, and both `tests/config.test.js` and `tests/snapshot.test.js` assert the literal values.

**Fix / what to do next time:** For any timeline change, run a headless Playwright script against a spare-port server (`PORT=3011 DEAL_MS=1500 BID_MS=5000 REVEAL_BIDS_MS=1500 node server.js`), join quick play, observe with a MutationObserver plus `getComputedStyle` sampling, and screenshot mid-hold; the extension tab is only good for static state. When changing `dealMs`/`bidMs`/`revealBidsMs`/`revealCardMs` defaults, edit `lib/config.js`, `lib/game.js`, and both test files together. Keep the reveal-card timeline under the `revealCardMs` budget: turn 620 + compare 800 + slide 280 + pay streams ~1.2 s + badge ~1.8 s + fade 300 already sits near 5 s.

**Refs:** `public/js/timelines.js` (`DELTA_*_MS`, `revealCardTimeline`); `lib/game.js:7`; `tests/config.test.js`; `tests/snapshot.test.js`; global log `~/.claude/agent-logs/claude-code.md` "occluded window makes the page document.hidden".

**Update 2026-09-13:** the 280 ms slide is gone — the flipped card now turns straight onto the reference slot, covering the old one, so the budget line reads turn 620 + hold 800 + streams + badge + fade.

## 2026-09-13 — A socket that closes over its room object can be stranded when the registry deletes that room underneath it

**Symptom / context:** A visitor sitting on the name screen of a room whose last human had left could later press Join and get a `joined` message but never a `state`; the button looked dead and nothing was logged. Only surfaced in the whole-branch review, not in any test.

**Root cause:** `server.js` resolved the room once per WebSocket connection (`const room = registry.getOrCreate(code)`) and kept that object for the socket's lifetime. Room deletion (no connected human for `RESUME_TTL_MS`) ignores visitors, so the object was removed from the registry while the socket still held it. A later `join` mutated the detached object, and the broadcast guard (`registry.get(room.code) === room`) correctly suppressed the broadcast, which is exactly what made the failure silent.

**Fix / what to do next time:** Re-resolve the room at the top of every message handler: if `registry.get(room.code) !== room`, call `getOrCreate`, re-add the socket to `room.visitors`, and clear `seat`. Any per-connection cache of registry-owned state needs the same treatment, or the registry must close/notify holders on delete. Covered by "a visitor stranded when the room is deleted still gets seated on a later join" in `tests/server.test.js`.

**Refs:** `server.js` (message handler, re-resolve block); `lib/rooms.js` `scheduleDeletion`/`deleteRoom`; commit `ad14782`.

## 2026-09-13 — Visitor-shape `state` messages have no `players`, so test predicates that read it throw inside the socket handler

**Symptom / context:** Two integration tests written against `m.players.length` failed with a TypeError thrown from inside the `ws` message listener rather than an assertion, because the first `state` a fresh socket receives is the visitor shape `{ type, room, phase, you: null, playerCount, maxPlayers }`.

**Root cause:** Spectators are out of scope, so `lib/snapshot.js` deliberately sends seatless sockets nothing about the match. Any predicate evaluated against every incoming message must tolerate that shape.

**Fix / what to do next time:** In `tests/server.test.js`, read `playerCount` for pre-join states, guard predicates with `m.players &&`, or pass a `from` watermark (`messages.length` captured before the action) so older visitor states are never scanned. The `until()` helper's waiter still runs the predicate on every later message, so guarding matters even with `from`.

**Refs:** `lib/snapshot.js` visitor branch; `tests/server.test.js` `until()`; commit `e32269a`.
