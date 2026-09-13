# LEARNINGS — follow-suit

Durable findings — past bug fixes, non-obvious behavior, tooling quirks. Add when something surprised us; read when starting work here. Newest entries at the top.

---

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
