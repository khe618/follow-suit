# Table UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Follow Suit table read correctly on phone-width screens — fitted seat pods with owned-card stacks, a log sheet, a readable results recap, a 60 s bid clock, a card that visibly moves to its buyer, and a named bonus round.

**Architecture:** The client keeps its existing two-layer split. The **state layer** (`table.js`) draws everything derivable from a snapshot and nothing else. The **timeline layer** (`timelines.js` over `anim.js`/`sequencer.js`) owns motion, and `transitions.js` is the only component that decides *which* timeline runs. Pure geometry lives in dependency-free UMD modules (`seat-layout.js`) unit-tested in Node. No server state changes; `lib/` changes only the bid-clock default.

**Tech Stack:** Vanilla ES modules, no bundler, no build step. `node --test` for unit tests. Headless Chrome via Playwright (installed in the session scratchpad, not in the repo) for layout and animation verification.

**Spec:** `docs/superpowers/specs/2026-09-13-table-ui-overhaul-design.md`

## Global Constraints

- No rules changes. `public/game-core.js` scoring, `lib/` settlement, and the wire protocol are untouched except `bidMs`.
- No new snapshot fields. Everything the client needs already exists in `state`.
- Internal identifiers `runout`, `RUNOUT_CARDS`, `isRunoutCard` and the history `runout` flag **do not change**. Only player-facing copy says "bonus round".
- The first doubled card is the payoff flip of the **final auction**, whose history entry has `runout: false`. Never derive doubling from `last.runout`. Derive from card position: `deckSize = state.flipped.length + state.cardsRemaining`; a flip of card number `n` is doubled iff `n > deckSize - RUNOUT_CARDS`.
- All motion is a tracked `ctx.animate()` / `ctx.fly()` / `ctx.turn()` call inside a timeline — never a CSS animation class on a state-layer node. This is what gives synchronous cancellation and automatic reduced-motion.
- `public/index.html` is read once at startup by `server.js`; restart the server after editing it.
- Existing tests in `tests/seat-layout.test.js` must pass **unmodified**.
- Bash tool is Git Bash (POSIX), not PowerShell.

**Verification servers.** Two are used throughout. Start them once and reuse:

```bash
# animation-accurate (default reveal timings — REQUIRED for flight/bonus assertions)
PORT=3011 DEAL_MS=1500 BID_MS=5000 node server.js &
# fast clock, to reach the results screen quickly
PORT=3012 DEAL_MS=600 BID_MS=900 REVEAL_BIDS_MS=350 REVEAL_CARD_MS=350 node server.js &
```

Never set `REVEAL_BIDS_MS` below 4000 when asserting the card flight — the bids timeline needs ~3.5 s and a shorter phase cancels it.

**Playwright** lives in the scratchpad, not the repo:
`cd "$SCRATCH" && npm i playwright@latest`, and always launch with
`chromium.launch({ channel: 'chrome' })` (the bundled browser build is not downloaded).

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `public/seat-layout.js` | Pure seat geometry: ring positions, radius fitting, pod facing |
| `public/transitions.js` | Snapshot→animation planning, incl. the `bonusBidding` kind |
| `public/js/table.js` | State layer: pods, stacks, centre, log, dock, recap, `.bonus` |
| `public/js/timelines.js` | Motion: deal, reveal bids (+ card flight), reveal card, bonus cinematic, results |
| `public/js/tutorial.js` | The eight-slide how-to-play dialog |
| `public/index.html` | Markup shell |
| `public/styles.css` | All styling |
| `lib/config.js`, `lib/game.js` | Bid-clock default |

If `table.js` passes ~800 lines, extract `renderRecap` to `public/js/recap.js` and the log sheet to `public/js/logsheet.js`, following the existing `lobby.js` pattern. Do this *inside* the task that crosses the line, not as a separate refactor.

---

### Task 1: Bid clock to 60 seconds

Independent of everything else; lands a green commit first.

**Files:**
- Modify: `lib/config.js:14`
- Modify: `lib/game.js:7`
- Test: `tests/config.test.js:8`, `tests/config.test.js:16`, `tests/snapshot.test.js:49`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `state.timing.bidMs` is 60000 by default.

- [ ] **Step 1: Update the three test assertions to the new default**

In `tests/config.test.js`:

```js
  assert.deepEqual(c.game, { dealMs: 9500, bidMs: 60000, revealBidsMs: 4500, revealCardMs: 6000 });
```

and in the env-override test in the same file:

```js
  assert.equal(c.game.bidMs, 60000);
```

In `tests/snapshot.test.js:49`:

```js
  assert.deepEqual(s.timing, { dealMs: 9500, bidMs: 60000, revealBidsMs: 4500, revealCardMs: 6000 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)|not ok"`
Expected: FAIL — `config.test.js` and `snapshot.test.js` report the old 30000.

- [ ] **Step 3: Change both defaults**

`lib/config.js:14`:

```js
      bidMs: envInt(env, "BID_MS", 60000),
```

`lib/game.js:7`:

```js
const DEFAULT_CONFIG = { dealMs: 9500, bidMs: 60000, revealBidsMs: 4500, revealCardMs: 6000 };
```

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. Note `lib/config.js:19` also contains `30000` for `heartbeatMs` — do **not** change it.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js lib/game.js tests/config.test.js tests/snapshot.test.js
git commit -m "feat: 60 seconds to bid"
```

---

### Task 2: Seat geometry — `fitRadii` and `podFace`

Pure functions, Node-tested, no DOM.

**Files:**
- Modify: `public/seat-layout.js`
- Test: `tests/seat-layout.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `seatPositions(count, { rx = RX, ry = RY } = {}) -> [{ x, y, angle }]` — percentages of the table box; unchanged when called with one argument.
  - `fitRadii({ tableW, tableH, podW, podH, railPx, counts = [2,3,4], maxRx = 46, maxRy = 46 }) -> { rx, ry }` — percentages, rounded to 2 decimals.
  - `podFace({ x, y }) -> "up" | "down" | "left" | "right"` — takes a seat position in percent, returns which way its cards fan (toward centre).

- [ ] **Step 1: Write the failing tests**

Append to `tests/seat-layout.test.js`:

```js
const { fitRadii, podFace } = require("../public/seat-layout.js");

// Every pod corner must sit inside the felt ellipse for every seat count.
function allInside({ tableW, tableH, podW, podH, railPx }, { rx, ry }, counts = [2, 3, 4]) {
  const a = tableW / 2 - railPx, b = tableH / 2 - railPx;
  const cx = tableW / 2, cy = tableH / 2;
  return counts.every((n) => seatPositions(n, { rx, ry }).every((p) => {
    const px = (p.x / 100) * tableW, py = (p.y / 100) * tableH;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const dx = px + sx * podW / 2 - cx, dy = py + sy * podH / 2 - cy;
      if ((dx * dx) / (a * a) + (dy * dy) / (b * b) > 1.0001) return false;
    }
    return true;
  }));
}

const BOXES = {
  phone360: { tableW: 336, tableH: 437, podW: 92, podH: 52, railPx: 15 },
  phone414: { tableW: 390, tableH: 507, podW: 92, podH: 52, railPx: 15 },
  tablet768: { tableW: 744, tableH: 465, podW: 112, podH: 64, railPx: 15 },
  desktop900: { tableW: 900, tableH: 562, podW: 112, podH: 64, railPx: 15 }
};

test("seatPositions takes explicit radii and defaults to the originals", () => {
  const def = seatPositions(4)[0];
  assert.equal(Math.round(def.y), 92);
  const tight = seatPositions(4, { rx: 30, ry: 25 });
  assert.equal(Math.round(tight[0].y), 75);
  assert.equal(Math.round(tight[1].x), 20);
});

test("fitRadii keeps every pod corner inside the felt at every breakpoint", () => {
  for (const [name, box] of Object.entries(BOXES)) {
    const r = fitRadii(box);
    assert.ok(r.rx > 0 && r.ry > 0, `${name} produced a usable ring`);
    assert.ok(allInside(box, r), `${name}: pods inside the felt`);
  }
});

test("fitRadii is maximal: nudging either radius pushes a pod out", () => {
  const box = BOXES.phone360;
  const r = fitRadii(box);
  assert.ok(!allInside(box, { rx: r.rx + 0.5, ry: r.ry }), "rx is at the limit");
  assert.ok(!allInside(box, { rx: r.rx, ry: r.ry + 0.5 }), "ry is at the limit");
});

// Pinned so the coordinate-ascent order cannot drift silently.
test("fitRadii returns the reviewed values", () => {
  assert.deepEqual(fitRadii(BOXES.phone360), { rx: 31.47, ry: 28.85 });
  assert.deepEqual(fitRadii(BOXES.tablet768), { rx: 39.93, ry: 31.08 });
});

test("fitRadii survives a pod larger than the felt", () => {
  const r = fitRadii({ tableW: 200, tableH: 200, podW: 400, podH: 400, railPx: 15 });
  assert.equal(r.rx, 0);
  assert.equal(r.ry, 0);
});

test("podFace points a seat's cards at the centre", () => {
  assert.equal(podFace({ x: 50, y: 80 }), "up");
  assert.equal(podFace({ x: 50, y: 20 }), "down");
  assert.equal(podFace({ x: 19, y: 50 }), "right");
  assert.equal(podFace({ x: 81, y: 50 }), "left");
  // Three-player diagonals resolve by dominant axis.
  assert.equal(podFace({ x: 23, y: 36 }), "right");
  assert.equal(podFace({ x: 77, y: 36 }), "left");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/seat-layout.test.js 2>&1 | grep -E "not ok|# fail"`
Expected: FAIL — `fitRadii is not a function`.

- [ ] **Step 3: Implement the two new exports**

In `public/seat-layout.js`, replace the `seatPositions` function and the `return` with:

```js
  // Seat i sits at angle 360*i/count clockwise from the bottom, so index 0
  // (the viewer) is bottom centre, index 1 is to their left, and the last
  // index is to their right. Coordinates are percentages of the table box.
  function seatPositions(count, { rx = RX, ry = RY } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 6) throw new RangeError(`unsupported seat count: ${count}`);
    const out = [];
    for (let i = 0; i < count; i++) {
      const angle = (360 * i) / count;
      const rad = (angle * Math.PI) / 180;
      out.push({ x: 50 - rx * Math.sin(rad), y: 50 + ry * Math.cos(rad), angle });
    }
    return out;
  }

  // Largest seat ring that keeps every corner of every pod inside the felt
  // ellipse, for every seat count the table supports — so the ring does not
  // jump when a player joins or leaves. rx and ry trade off against each
  // other, so "largest" needs an objective: coordinate ascent, rx first,
  // four rounds. The values it produces are pinned by a test.
  function fitRadii({ tableW, tableH, podW, podH, railPx, counts = [2, 3, 4], maxRx = 46, maxRy = 46 }) {
    const a = tableW / 2 - railPx;
    const b = tableH / 2 - railPx;
    const cx = tableW / 2;
    const cy = tableH / 2;
    if (a <= 0 || b <= 0) return { rx: 0, ry: 0 };
    const fits = (rx, ry) => counts.every((n) => seatPositions(n, { rx, ry }).every((p) => {
      const px = (p.x / 100) * tableW;
      const py = (p.y / 100) * tableH;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const dx = px + sx * (podW / 2) - cx;
          const dy = py + sy * (podH / 2) - cy;
          if ((dx * dx) / (a * a) + (dy * dy) / (b * b) > 1) return false;
        }
      }
      return true;
    }));
    const climb = (other, axis) => {
      let lo = 0;
      let hi = axis === "rx" ? maxRx : maxRy;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        if (axis === "rx" ? fits(mid, other) : fits(other, mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    let rx = 0;
    let ry = 0;
    for (let round = 0; round < 4; round++) {
      rx = climb(ry, "rx");
      ry = climb(rx, "ry");
    }
    return { rx: Number(rx.toFixed(2)), ry: Number(ry.toFixed(2)) };
  }

  // Which way a seat's owned cards fan: always toward the middle of the
  // table, by dominant axis, so diagonal seats are defined too.
  function podFace({ x, y }) {
    const dx = 50 - x;
    const dy = 50 - y;
    if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "down" : "up";
    return dx >= 0 ? "right" : "left";
  }

  return { seatPositions, fitRadii, podFace };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/seat-layout.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`, with the four pre-existing tests still passing.

If the pinned values in the fourth test do not match, do **not** edit the pinned test to match your output — that test exists to catch an ascent-order change. Re-check the `climb`/round structure against the code above.

- [ ] **Step 5: Commit**

```bash
git add public/seat-layout.js tests/seat-layout.test.js
git commit -m "feat: fit the seat ring to the felt"
```

---

### Task 3: Seat pods and owned-card stacks

The core layout change. Uses Task 2.

**Files:**
- Modify: `public/js/table.js` (`buildSeat` ~134, `renderStakeRow` ~191, `renderSeats` ~203, `place` ~128)
- Modify: `public/styles.css` (`.seat`, `.avatar`, `.seat-name`, `.seat-score`, `.seat-stakes`, `.stake-chip`)

**Interfaces:**
- Consumes: `seatPositions`, `fitRadii`, `podFace` from Task 2.
- Produces:
  - Pod DOM: `.seat[data-face]` containing `.avatar`, `.seat-name`, `.seat-score`, `.seat-stakes`, `.seat-status`, `.bid-tag`, `.seat-remove`.
  - Stack DOM: `.seat-stakes > .stake-stack[data-suit][data-count] > .stake-card` (up to 4) `+ .stake-count`.
  - `renderStakeRow(el, id) -> string` returning `"3 spades, 2 hearts"`.

- [ ] **Step 1: Add the CSS tokens and pod/stack rules**

In `public/styles.css`, in `:root`, add:

```css
  --pod-w: 92px;
  --pod-h: 52px;
  --stake-w: 16px;
  --stake-h: 23px;
```

and at the `@media (min-width: 640px)` level (add the block near the other breakpoints):

```css
@media (min-width: 640px) {
  :root { --pod-w: 112px; --pod-h: 64px; --stake-w: 20px; --stake-h: 29px; }
}
```

Replace the `.seat` rule (`styles.css:146`) and the `.seat-stakes`/`.stake-chip` rules with:

```css
.seat {
  position: absolute; transform: translate(-50%, -50%);
  width: var(--pod-w); height: var(--pod-h);
  display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
  align-items: center; gap: 0 6px; padding: 4px 6px;
  border-radius: 999px; background: rgba(0, 0, 0, 0.3);
  text-align: left; z-index: 2;
}
.seat .avatar { grid-row: 1 / 3; width: 36px; height: 36px; font-size: 1rem; }
.seat-name { grid-column: 2; font-size: 0.78rem; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); }
.seat-score { grid-column: 2; justify-self: start; padding: 0 6px; border-radius: 999px; background: rgba(0, 0, 0, 0.45); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.8rem; }

/* Owned suits, fanned toward the middle of the table. */
.seat-stakes { position: absolute; display: flex; gap: 4px; pointer-events: none; }
.seat[data-face="up"] .seat-stakes { bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); }
.seat[data-face="down"] .seat-stakes { top: calc(100% + 4px); left: 50%; transform: translateX(-50%); }
.seat[data-face="right"] .seat-stakes { left: calc(100% + 4px); top: 50%; transform: translateY(-50%); }
.seat[data-face="left"] .seat-stakes { right: calc(100% + 4px); top: 50%; transform: translateY(-50%); }
.stake-stack { position: relative; height: var(--stake-h); width: var(--stake-w); }
.stake-card {
  position: absolute; top: 0; width: var(--stake-w); height: var(--stake-h);
  border-radius: 3px; border: 1px solid #fff; background: var(--card-face); color: var(--black);
  display: flex; align-items: center; justify-content: center;
  font-size: calc(var(--stake-w) * 0.62); font-weight: 700;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
.stake-card.hearts, .stake-card.diamonds { color: var(--red); }
.stake-count {
  position: absolute; right: -5px; bottom: -5px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: var(--gold); color: #1a1408;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.62rem; font-weight: 800; line-height: 14px; text-align: center;
}
```

Delete the old `.seat-stack` rule and the `.seat-stack .stack-chip` rule in the animation-layer section (the bid stack moves to the dock in Task 4).

Each `.stake-card` after the first is offset by 70% of the card width; set that inline from JS (Step 3) so the cap is one source of truth.

- [ ] **Step 2: Rebuild the pod and the stack row in `table.js`**

Replace `buildSeat`'s `stack` creation (it appended `.seat-stack`) — delete those two lines and drop `stack` from the final `el.append(...)`. Replace `renderStakeRow` with:

```js
  // Up to STACK_EDGES overlapping card edges per suit, plus a count badge
  // from two upward: seven spades read as four edges and a "7", never as
  // seven cards of width.
  const STACK_EDGES = 4;
  function renderStakeRow(el, id) {
    const owned = ownedStakes(id);
    const suits = SUITS.filter((s) => owned[s] > 0);
    const row = el.querySelector(".seat-stakes");
    row.replaceChildren(...suits.map((s) => {
      const stack = document.createElement("div");
      stack.className = "stake-stack";
      stack.dataset.suit = s;
      stack.dataset.count = String(owned[s]);
      const edges = Math.min(STACK_EDGES, owned[s]);
      for (let i = 0; i < edges; i++) {
        const card = document.createElement("div");
        card.className = `stake-card ${s}`;
        card.style.left = `${i * 70}%`;
        card.textContent = i === edges - 1 ? SUIT_SYMBOLS[s] : "";
        stack.append(card);
      }
      stack.style.width = `calc(var(--stake-w) * ${1 + (edges - 1) * 0.7})`;
      if (owned[s] > 1) {
        const badge = document.createElement("span");
        badge.className = "stake-count";
        badge.textContent = String(owned[s]);
        stack.append(badge);
      }
      return stack;
    }));
    return suits.map((s) => `${owned[s]} ${s}`).join(", ");
  }
```

- [ ] **Step 3: Fit the ring to the measured table**

In `table.js`, next to the other module-level state, add:

```js
  let ring = { rx: 44, ry: 42 };
  function measureRing() {
    const box = els.table.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const css = getComputedStyle(document.documentElement);
    const podW = parseFloat(css.getPropertyValue("--pod-w")) || 92;
    const podH = parseFloat(css.getPropertyValue("--pod-h")) || 52;
    const next = fitRadii({ tableW: box.width, tableH: box.height, podW, podH, railPx: 15 });
    if (next.rx === ring.rx && next.ry === ring.ry) return false;
    ring = next;
    return true;
  }
  const ringObserver = new ResizeObserver(() => { if (measureRing() && state) renderSeats(); });
  ringObserver.observe(els.table);
```

Import `fitRadii` and `podFace` alongside `seatPositions` (they come off `window.SeatLayout`; follow the existing destructure at the top of `table.js`).

In `renderSeats`, replace the `positions` line and add the facing:

```js
    const positions = seatPositions(lobby ? MAX_PLAYERS : Math.max(1, players.length), ring);
```

and inside the `players.forEach`, right after `place(el, positions[i]);`:

```js
      el.dataset.face = podFace(positions[i]);
```

Also set `el.dataset.face` on empty lobby seats where they are appended.

In `dispose`, add `ringObserver.disconnect();`.

- [ ] **Step 4: Verify with the layout harness**

Write `$SCRATCH/verify.mjs` (full source in Task 12) and run:

```bash
node verify.mjs 3011 320 360 414 768 1024
```

Expected: every width reports `ok` for "pods outside felt" and "horizontal scroll". The "pods under the dock" and "hand row collapsed" checks may still fail — Task 6 fixes those.

Also confirm visually at 360 px that each pod shows avatar, name and score on one pill and that stacks sit on the centre-facing side.

- [ ] **Step 5: Commit**

```bash
git add public/js/table.js public/styles.css
git commit -m "feat: fixed-size seat pods with owned-card stacks"
```

---

### Task 4: Move the bid chip stack into the dock

**Files:**
- Modify: `public/index.html` (dock block, ~line 88)
- Modify: `public/js/table.js` (`renderBidStack` ~442, `els` ~20, `resetTransient` ~61)
- Modify: `public/styles.css` (`.dock`, new `.bid-stack`)

**Interfaces:**
- Consumes: Task 3's pod (which no longer has `.seat-stack`).
- Produces: `#bidStack` in the dock, one `.chip-sprite` per 10 of the current draft.

- [ ] **Step 1: Add the element**

In `public/index.html`, inside `.ring-wrap`, after the `<input id="bidInput" …>`:

```html
        <div id="bidStack" class="bid-stack" aria-hidden="true"></div>
```

- [ ] **Step 2: Style it**

In `public/styles.css`, add:

```css
.bid-stack { position: absolute; left: 50%; bottom: -6px; width: 22px; height: 22px; transform: translateX(-50%); pointer-events: none; }
.bid-stack .chip-sprite { position: absolute; left: 0; bottom: 0; }
```

- [ ] **Step 3: Point `renderBidStack` at it**

Add `bidStack: $("bidStack")` to the `els` object, then replace `renderBidStack`:

```js
  // The dock stacks a chip for every 10 you bid, so the number has a
  // physical size. Yours only; every non-bidding phase clears it.
  function renderBidStack() {
    els.bidStack.replaceChildren();
    if (!state || state.phase !== "bidding") return;
    const count = Math.ceil(draft.amount / 10);
    for (let i = 0; i < count; i++) {
      const chip = document.createElement("div");
      chip.className = "chip-sprite";
      chip.style.transform = `translateY(${-i * 3}px)`;
      els.bidStack.append(chip);
    }
  }
```

In `resetTransient`, remove the loop that cleared `.seat-stack` children and any `.stake-chip` visibility reset that referenced the old chips.

- [ ] **Step 4: Verify**

Restart the 3011 server (markup changed). Join quick play at 360 px, drag the slider, and confirm the chip stack grows under the ring and that **your avatar is fully visible** — the previous build drew chips over it.

Run: `node verify.mjs 3011 360` — still `ok` on pods/scroll.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/table.js public/styles.css
git commit -m "feat: the dock stacks a chip for every 10 bid"
```

---

### Task 5: Log sheet, with suit counts kept on the table

**Files:**
- Modify: `public/index.html` (log block ~47, topbar ~17)
- Modify: `public/js/table.js` (`els`, `setLogMode` ~293, `renderLog` ~301)
- Modify: `public/styles.css` (`.log`, `.log-foot`, new `.log-sheet`, `.counts-row`)

**Interfaces:**
- Consumes: nothing.
- Produces: `#logSheet` dialog; `#suitCounts` relocated to an always-visible `.counts-row` under the table; `renderLog()` no longer touches open state.

- [ ] **Step 1: Restructure the markup**

In the topbar actions, before `#helpBtn`:

```html
      <button type="button" id="logBtn" class="icon-btn labeled">Log</button>
```

Wrap the log in a dialog and move the toggle into its header; replace the whole `<div id="log" …>…</div>` block with:

```html
      <dialog id="logSheet" class="log-sheet" aria-label="Cards and bids so far">
        <div class="log-sheet-head">
          <div class="log-mode" role="group" aria-label="Log view">
            <button type="button" id="logBidsBtn" class="log-mode-btn" aria-pressed="true">Bids</button>
            <button type="button" id="logPayoutsBtn" class="log-mode-btn" aria-pressed="false">Payouts</button>
          </div>
          <button type="button" id="logCloseBtn" class="icon-btn" aria-label="Close log">×</button>
        </div>
        <div id="log" class="log">
          <div class="log-scroll">
            <table class="log-table" aria-label="Cards and bids so far">
              <thead><tr id="logHead"></tr></thead>
              <tbody id="logBody"></tbody>
            </table>
          </div>
        </div>
      </dialog>
```

and add, immediately after the closing `</div>` of `#table`:

```html
      <div id="suitCounts" class="suit-counts counts-row" aria-label="Cards flipped by suit"></div>
```

- [ ] **Step 2: Own the open state explicitly**

In `table.js`, add `logSheet: $("logSheet")`, `logBtn: $("logBtn")`, `logCloseBtn: $("logCloseBtn")` to `els`, and add:

```js
  // Availability (does the log have data?) and openness (is the sheet up?)
  // are separate. renderLog only ever writes content; this owns open state.
  const wide = matchMedia("(min-width: 640px)");
  function syncLogSheet() {
    if (wide.matches) {
      if (!els.logSheet.open) els.logSheet.show();   // non-modal, in flow
      els.logBtn.hidden = true;
    } else {
      if (els.logSheet.open) els.logSheet.close();
      els.logBtn.hidden = false;
    }
  }
  function openLogSheet() {
    if (!wide.matches && !els.logSheet.open) {
      els.logSheet.showModal();
      els.logCloseBtn.focus();
    }
  }
  function closeLogSheet() {
    if (!wide.matches && els.logSheet.open) {
      els.logSheet.close();
      els.logBtn.focus();
    }
  }
  wide.addEventListener("change", syncLogSheet);
  els.logBtn.addEventListener("click", openLogSheet);
  els.logCloseBtn.addEventListener("click", closeLogSheet);
  els.logSheet.addEventListener("close", () => { if (!wide.matches) els.logBtn.focus(); });
  els.logSheet.addEventListener("click", (e) => { if (e.target === els.logSheet) closeLogSheet(); });
  syncLogSheet();
```

In `renderLog`, replace the two visibility lines:

```js
    const show = state.phase !== "lobby";
    els.log.dataset.available = String(show);
    els.logBtn.disabled = !show;
    if (!show) return;
```

Leave the `els.suitCounts.replaceChildren(...)` block exactly as it is — it now paints the always-visible row under the table.

- [ ] **Step 3: Style the sheet and the counts row**

```css
.log-sheet { border: none; padding: 0; background: transparent; color: var(--ink); }
.log-sheet::backdrop { background: rgba(0, 0, 0, 0.6); }
.log-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; }
.counts-row { justify-content: center; padding: 4px 0; }
@media (max-width: 639px) {
  .log-sheet[open] { position: fixed; inset: 0; width: 100%; max-width: none; height: 100dvh; max-height: none; margin: 0; background: var(--felt); display: flex; flex-direction: column; }
  .log-sheet .log { flex: 1; min-height: 0; }
  .log-sheet .log-scroll { max-height: 100%; }
}
@media (min-width: 640px) {
  .log-sheet { display: block; position: static; width: min(100%, 900px); margin: 0 auto; }
  .log-sheet-head { justify-content: flex-start; }
  #logCloseBtn { display: none; }
}
```

Delete the `.log-foot` rule and the `.table-view:has(#log:not([hidden])) .table` rule (`styles.css:139`) — the table no longer shares vertical space with the log on phones, and Task 6 replaces that clamp.

- [ ] **Step 4: Verify**

Restart the 3011 server. At 360 px: the table has no log above it, the suit counts sit under the felt, and the topbar has a `Log` button that opens a full-screen sheet. Tab into the sheet and confirm focus stays inside and returns to `Log` on Escape. At 900 px: no `Log` button, the log renders inline above the table as before.

Run: `node verify.mjs 3011 360 768` — `suit counts visible` must pass at both.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/table.js public/styles.css
git commit -m "feat: log sheet on phones, suit counts always on the table"
```

---

### Task 6: Height-first table and the vertical budget

**Files:**
- Modify: `public/styles.css` (`.table`, `.table-view`)
- Modify: `public/js/table.js` (dock measurement)

**Interfaces:**
- Consumes: Task 5's counts row.
- Produces: `--dock-h` on `document.documentElement`, always current.

- [ ] **Step 1: Publish the dock height**

In `table.js`, alongside `ringObserver`:

```js
  // The dock is fixed and overlays the column, so the table's budget has to
  // know how tall it actually is — not a guessed constant.
  const dockObserver = new ResizeObserver(() => {
    const h = els.dock.hidden ? 0 : els.dock.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--dock-h", `${Math.round(h)}px`);
  });
  dockObserver.observe(els.dock);
```

Disconnect it in `dispose` next to `ringObserver`.

- [ ] **Step 2: Size the table height-first**

Replace the `.table-view` and `.table` size rules:

```css
.table-view { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 12px; padding-bottom: calc(var(--dock-h, 0px) + 12px); }
.table {
  position: relative;
  height: clamp(220px, calc(100dvh - var(--topbar-h, 52px) - var(--hand-h, 78px) - var(--counts-h, 30px) - var(--dock-h, 0px) - env(safe-area-inset-bottom) - 40px), 100vh);
  width: auto; aspect-ratio: 10 / 13; max-width: min(100%, 900px);
  border-radius: 50%;
  background: radial-gradient(ellipse at 50% 40%, var(--felt-light), var(--felt-mid) 60%, var(--felt-dark));
  box-shadow: inset 0 0 0 12px var(--rail), inset 0 0 0 15px var(--rail-2), inset 0 0 60px rgba(0, 0, 0, 0.55), 0 24px 60px rgba(0, 0, 0, 0.6);
}
@media (min-width: 720px) { .table { aspect-ratio: 16 / 10; } }
```

`height` + `aspect-ratio` + `max-width` is what preserves the ratio under the clamp; a `max-height` on a width-driven box would squash it instead.

- [ ] **Step 3: Verify no overlap at every width**

Run: `node verify.mjs 3011 320 360 414 768 1024`
Expected: **all widths pass** — including "pods under the dock" and "hand row collapsed", which is what this task fixes.

- [ ] **Step 4: Commit**

```bash
git add public/js/table.js public/styles.css
git commit -m "fix: size the table from the space actually left for it"
```

---

### Task 7: Drop the rail flash for local hit feedback

**Files:**
- Modify: `public/js/table.js` (`els.flash` ~43-47, `resetTransient` ~61-80)
- Modify: `public/js/timelines.js` (`revealCardTimeline` ~300-312)
- Modify: `public/styles.css` (`.rail-flash` rules)

**Interfaces:**
- Consumes: Task 3's `.stake-stack[data-suit]`.
- Produces: nothing reusable.

- [ ] **Step 1: Delete the flash**

Remove the three lines that create and append `els.flash` in `table.js`, the `els.flash.className = "rail-flash";` line in `resetTransient`, and the `.rail-flash` CSS rules (all four).

- [ ] **Step 2: Replace the feedback in `revealCardTimeline`**

Replace the `if (hit) { els.flash… }` block with:

```js
  // Local feedback instead of flashing the whole table: ring the card that
  // just landed, and pulse every stack that it pays. Tracked animations, so
  // the sequencer cancels them and reduced motion is handled for us.
  if (hit) {
    ctx.animate(top, [
      { boxShadow: "0 2px 6px rgba(0,0,0,0.45)" },
      { boxShadow: `0 0 0 3px var(--gold), 0 0 18px var(--gold)`, offset: 0.35 },
      { boxShadow: "0 2px 6px rgba(0,0,0,0.45)" }
    ], { duration: 700, easing: "ease-out" }).catch(() => {});
    for (const id of ids) {
      const stack = t.seatEl(id).querySelector(`.stake-stack[data-suit="${last.flipped}"]`);
      if (!stack) continue;
      ctx.animate(stack, [
        { transform: "scale(1)" },
        { transform: "scale(1.18)", offset: 0.4 },
        { transform: "scale(1)" }
      ], { duration: 600, easing: "ease-out" }).catch(() => {});
    }
  }
```

- [ ] **Step 3: Verify**

Watch a game at 3011 to a flip that pays. Expected: the flipped card rings gold and matching stacks pulse; the felt itself never flashes. Check the browser console is clean.

- [ ] **Step 4: Commit**

```bash
git add public/js/table.js public/js/timelines.js public/styles.css
git commit -m "feat: local hit feedback instead of the whole-table flash"
```

---

### Task 8: The card flies to its buyer

**Files:**
- Modify: `public/js/timelines.js` (`revealBidsTimeline` ~234-252)

**Interfaces:**
- Consumes: Task 3's `.stake-stack[data-suit][data-count]` and `.stake-card`.
- Produces: nothing reusable.

- [ ] **Step 1: Replace the stake-chip handoff with the flight**

In `revealBidsTimeline`, delete the `newChips` lines (the `const newChips = …` and the `for (const chip of newChips) chip.style.visibility = "hidden";`) and replace the trailing `if (newChips.length) …` block. New handoff, before the `const order = …` line:

```js
  // The buyer's stack is drawn by the state layer for the post-purchase
  // state. Wind it back to its pre-purchase look so the flight can land on
  // it: a capped stack gains no new edge, only a count, so the count is the
  // thing held back, not the card.
  const landings = last.void ? [] : last.buyers.map((id) => {
    const stack = t.seatEl(id).querySelector(`.stake-stack[data-suit="${last.reference}"]`);
    if (!stack) return null;
    const after = Number(stack.dataset.count);
    const card = stack.querySelector(".stake-card:last-of-type");
    const badge = stack.querySelector(".stake-count");
    if (card) card.style.visibility = "hidden";
    if (badge) badge.textContent = String(after - 1);
    if (badge && after - 1 < 2) badge.style.visibility = "hidden";
    return { stack, card, badge, after };
  }).filter(Boolean);
```

and replace the final pop with:

```js
  // The reference card cannot leave the slot — the next flip turns onto it —
  // so what flies to the buyer is a copy: you buy a claim on the suit, not
  // the card itself.
  if (landings.length) {
    audio.play("tag");
    const slot = ctx.centre(els.refSlot);
    await ctx.until(Promise.all(landings.map(async ({ stack, card, badge, after }) => {
      const copy = ctx.spawn(`card small ${last.reference}`, SUIT_SYMBOLS[last.reference]);
      ctx.put(copy, slot);
      await ctx.fly(copy, slot, ctx.centre(stack), CARD_TO_BUYER_MS, { arc: 30 });
      if (!ctx.alive()) return;
      copy.remove();
      if (card) card.style.visibility = "";
      if (badge) { badge.textContent = String(after); badge.style.visibility = ""; }
    })));
  }
```

Add the constant next to the others at the top of `timelines.js`:

```js
const CARD_TO_BUYER_MS = 420;
```

- [ ] **Step 2: Check the budget did not blow**

The bids timeline should now measure ≈3.5 s against `revealBidsMs` 4500. Verify empirically with the default-timing server:

```bash
node flight.mjs 3011     # source in Task 12
```

Expected: reports the flight completing and the stack count settling **before** the phase changes, at both 2-player and 4-player tables.

- [ ] **Step 3: Verify the tie case**

A two-way tie sends one copy to each buyer. Force it by watching until the log shows two buyers, or trust the `flight.mjs` assertion that `landings.length` matched `last.buyers.length` each round.

- [ ] **Step 4: Commit**

```bash
git add public/js/timelines.js
git commit -m "feat: the bought suit flies to its buyer"
```

---

### Task 9: Bonus round

**Files:**
- Modify: `public/transitions.js` (`plan` ~31)
- Modify: `public/js/table.js` (`renderCentre` ~263, `render` ~571, dock)
- Modify: `public/js/timelines.js` (new `bonusRoundTimeline`, `revealCardTimeline` doubling)
- Modify: `public/index.html` (banner element)
- Modify: `public/styles.css` (`.bonus` dressing, `.bonus-banner`, `.dock.pending`)
- Test: `tests/transitions.test.js`

**Interfaces:**
- Consumes: `RUNOUT_CARDS` from `game-core.js`.
- Produces: `plan()` may return `kind: "bonusBidding"`; `bonusRoundTimeline(ctx, t, state)`.

- [ ] **Step 1: Write the failing planner tests**

Append to `tests/transitions.test.js` (match the existing snapshot-building helper in that file):

```js
test("the bonus round gets its own bidding kind, exactly once", () => {
  const base = { matchId: 1, phase: "bidding", revealStep: null, auctionIndex: 16, players: [], cardsRemaining: 5 };
  const first = plan(null, base);
  assert.equal(first.kind, "bonusBidding");
  // A duplicate snapshot is an idempotent update, not a replay.
  assert.equal(plan(base, { ...base }).kind, "update");
  // Hydration never replays the cinematic.
  assert.equal(plan(null, base, { hydrate: true }).kind, "hydrate");
});

test("ordinary auctions are unaffected", () => {
  const base = { matchId: 1, phase: "bidding", revealStep: null, auctionIndex: 3, players: [], cardsRemaining: 12 };
  assert.equal(plan(null, base).kind, "bidding");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/transitions.test.js 2>&1 | grep -E "not ok|# fail"`
Expected: FAIL — got `bidding`, wanted `bonusBidding`.

- [ ] **Step 3: Add the planner kind**

In `public/transitions.js`, the factory needs `RUNOUT_CARDS`. It is a UMD module with no dependencies today; read the constant off the same global the browser already has and fall back for Node:

```js
  const RUNOUT_CARDS = (typeof require === "function" ? require("./game-core.js") : root.GameCore).RUNOUT_CARDS;
```

Place that inside the factory, above `transitionKey`. Then in `plan`'s switch:

```js
      case "bidding":
        // The bonus round starts at the final auction: from here every card
        // left pays double, so this is the auction where the doubling most
        // changes the right bid.
        return { key, kind: next.cardsRemaining === RUNOUT_CARDS ? "bonusBidding" : "bidding" };
```

- [ ] **Step 4: Run the planner tests**

Run: `node --test tests/transitions.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Add the persistent state and the banner element**

`public/index.html`, inside `#table` after `#sprites`:

```html
        <div id="bonusBanner" class="bonus-banner" aria-hidden="true">Bonus round · payouts double</div>
```

`table.js` `renderCentre`, after the `deckDouble` line:

```js
    // Derived from the snapshot, so a reconnect mid-bonus-round lands in the
    // right state with no animation.
    els.table.classList.toggle("bonus", !lobby && state.cardsRemaining <= RUNOUT_CARDS);
```

In `renderDock`, when bidding and `state.cardsRemaining <= RUNOUT_CARDS`, show a note. Add to the dock markup in `index.html` inside the dock, after the lock button:

```html
        <p id="bonusNote" class="bonus-note" hidden>These cards pay double.</p>
```

and in `renderDock`, after `els.dock.hidden = !bidding;`:

```js
    els.bonusNote.hidden = !bidding || state.cardsRemaining > RUNOUT_CARDS;
```

CSS:

```css
.table.bonus { background: radial-gradient(ellipse at 50% 40%, #2a7a4f, #1a5c3a 60%, #10462c); box-shadow: inset 0 0 0 12px #6b4a1a, inset 0 0 0 15px var(--gold), inset 0 0 60px rgba(0, 0, 0, 0.55), 0 24px 60px rgba(0, 0, 0, 0.6); }
.bonus-banner { position: absolute; left: 0; right: 0; top: 42%; padding: 10px 0; text-align: center; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #1a1408; background: linear-gradient(180deg, var(--gold-2), var(--gold)); opacity: 0; pointer-events: none; z-index: 6; }
.bonus-note { grid-column: 1 / -1; margin: 0; text-align: center; color: var(--gold-2); font-size: 0.85rem; }
.dock.pending { visibility: hidden; }
```

- [ ] **Step 6: Add the cinematic and the ordering rule**

In `timelines.js`:

```js
// The one-time entry into the bonus round. The planner decides when this
// runs (transitions.js), so a reconnect never replays it.
export async function bonusRoundTimeline(ctx, t, state) {
  const { els, audio } = t;
  audio.play("rise");
  t.announce("Bonus round. The last five cards pay double.");
  await ctx.animate(els.bonusBanner, [
    { opacity: 0, transform: "translateX(-40%)" },
    { opacity: 1, transform: "none", offset: 0.35 },
    { opacity: 1, transform: "none", offset: 0.75 },
    { opacity: 0, transform: "translateX(40%)" }
  ], { duration: 900, easing: "ease-out" });
}
```

In `table.js`'s `render` switch, add the case — and note `drawAll()` has already run and shown the dock, which is why `.pending` is set before the timeline rather than after:

```js
      case "bonusBidding":
        els.dock.classList.add("pending");
        els.dock.inert = true;
        runTimeline((ctx) => bonusRoundTimeline(ctx, handle, next).finally(() => {
          els.dock.classList.remove("pending");
          els.dock.inert = false;
          els.bidInput.focus({ preventScroll: true });
        }));
        break;
```

`renderDock` and `patchLive` must not touch `.pending` — the draft initialisation and the automatic default-bid send still run immediately, so a silent player is still scored.

- [ ] **Step 7: Fix the doubled-payout derivation**

In `revealCardTimeline`, replace the `firstRunout` computation and give the gold treatment to every doubled flip:

```js
  const deckSize = state.flipped.length + state.cardsRemaining;
  // The first doubled card is the payoff flip of the FINAL auction, whose
  // history entry has runout: false — so position, never last.runout.
  const doubled = state.flipped.length > deckSize - RUNOUT_CARDS;
```

Use `doubled` where `firstRunout` gated the announcement prefix, changing the wording to "Bonus round. " only when `state.cardsRemaining === RUNOUT_CARDS - 1` (the first doubled flip), and pass `doubled` into `payStreams` so chips get a `gold` class:

```js
      const chip = ctx.spawn(gold ? "chip-sprite gold" : "chip-sprite");
```

with `.chip-sprite.gold { background: var(--gold); border-color: var(--gold-2); }` in CSS. Thread a `gold` argument through `payStreams(ctx, t, streams, from, to, gold = false)`.

- [ ] **Step 8: Verify**

Run: `node bonus.mjs 3012` (source in Task 12). Expected: `.bonus` first appears while `cardsRemaining === 5` and while the phase is `bidding`; the banner plays exactly once per game; a mid-bonus reload shows `.bonus` with no banner.

- [ ] **Step 9: Commit**

```bash
git add public/transitions.js public/js/table.js public/js/timelines.js public/index.html public/styles.css tests/transitions.test.js
git commit -m "feat: name and stage the bonus round"
```

---

### Task 10: Results recap strip

**Files:**
- Modify: `public/index.html` (results overlay ~101-109)
- Modify: `public/js/table.js` (`renderResults` ~517, new `renderRecap`)
- Modify: `public/styles.css` (`.history-details`, `table.history` out; `.recap` in)

**Interfaces:**
- Consumes: `state.history`, `state.flipped`, `state.cardsRemaining`.
- Produces: `renderRecap()`.

- [ ] **Step 1: Replace the markup**

Delete the whole `<details class="history-details">…</details>` block and put in its place:

```html
        <ol id="recap" class="recap" aria-label="Round by round"></ol>
```

- [ ] **Step 2: Build the recap**

In `table.js`, add `recap: $("recap")` to `els`, delete the `els.historyBody` lines from `renderResults`, and add:

```js
  // One cell per auction, in deck order. The bonus divider goes before the
  // FINAL auction, because that is where doubling starts (spec 8.1) — its
  // cell keeps its buyer, since it is a real auction and the first doubled
  // card is what it pays on.
  function renderRecap() {
    const nameOf = (id) => (state.players.find((p) => p.id === id) || { name: id }).name;
    const deckSize = state.flipped.length + state.cardsRemaining;
    const firstBonus = state.history.findIndex((h) => h.index >= deckSize - RUNOUT_CARDS);
    els.recap.replaceChildren(...state.history.map((h, i) => {
      const li = document.createElement("li");
      li.className = "recap-cell" + (i === firstBonus ? " bonus-start" : "");
      // The buyer's real cost is what they paid every seller, not topBid.
      const paid = h.buyers.length ? -(h.purchase[h.buyers[0]] || 0) : 0;
      const mine = (h.deltas && h.deltas[state.you]) || 0;
      const cardNumber = i + 2;
      const isDoubled = cardNumber > deckSize - RUNOUT_CARDS;
      const ref = cardEl(h.reference, "mini");
      const who = document.createElement("span");
      who.className = "recap-who" + (h.void ? " void" : "");
      who.textContent = h.runout ? "—" : h.void ? "void" : `${h.buyers.map((id) => nameOf(id)[0]).join("")}·${paid}`;
      const flip = cardEl(h.flipped, "mini");
      if (isDoubled) flip.classList.add("doubled");
      const delta = document.createElement("span");
      delta.className = "recap-delta " + (mine > 0 ? "pos" : mine < 0 ? "neg" : "zero");
      delta.textContent = fmtDelta(mine);
      for (const el of [ref, who, flip, delta]) el.setAttribute("aria-hidden", "true");
      li.append(ref, who, flip, delta);
      li.setAttribute("aria-label",
        `Round ${h.index}, ${h.reference}: ` +
        (h.runout ? "bonus round, no auction" : h.void ? "no trade" : `${h.buyers.map(nameOf).join(" and ")} bought for ${paid}`) +
        `, flipped ${h.flipped}${isDoubled ? " for double" : ""}, you ${mine >= 0 ? "plus" : "minus"} ${Math.abs(mine)}`);
      return li;
    }));
  }
```

Call `renderRecap()` at the end of `renderResults`.

- [ ] **Step 3: Style it**

```css
.recap { list-style: none; margin: 0; padding: 8px 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; }
.recap-cell { flex: none; display: grid; justify-items: center; gap: 3px; padding: 6px 5px; border-radius: 8px; background: var(--felt); border: 1px solid var(--line); }
.recap-cell.bonus-start { border-left: 3px solid var(--gold); }
.recap-who { font-size: 0.68rem; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
.recap-who.void { opacity: 0.6; }
.recap-delta { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.75rem; font-weight: 700; }
.recap-delta.pos { color: var(--good); } .recap-delta.neg { color: var(--bad); } .recap-delta.zero { color: var(--muted); }
.card.mini.doubled { outline: 2px solid var(--gold); }
```

Delete `.history-details`, `.table-wrap` and the `table.history` rules.

- [ ] **Step 4: Verify**

Run: `node results.mjs 3012` (source in Task 12). Expected: one cell per history entry; exactly one `.bonus-start`; the cell before it is an auction with a buyer; the last five flipped cards carry `.doubled`; no page-level horizontal scroll (only the strip scrolls).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/table.js public/styles.css
git commit -m "feat: round-by-round recap instead of the history table"
```

---

### Task 11: Tutorial

**Files:**
- Modify: `public/js/tutorial.js` (`SLIDES` ~173-320, `renderCalculator` ~361-423)
- Modify: `public/styles.css` (`.tut-instruction`)

**Interfaces:**
- Consumes: Task 4's `#bidStack` concept (slide 4 copy), Task 9's bonus dressing (slide 8).
- Produces: an eight-entry `SLIDES` array.

- [ ] **Step 1: Fix slide 1 and add slide 8**

Slide 1's caption becomes (the ×2 sentence moves to the end of the deck):

```js
    caption: "Each round you bid for the suit on top. Own it, and every later flip of that suit pays you 10 from each player who sold it to you. Most chips when the deck runs out wins.",
```

Append a final slide after the calculator slide:

```js
  {
    caption: "The last five cards are the bonus round: no auction, and every payout doubles. Suits you already own keep paying — twice as much.",
    async run(ctx, m) {
      m.table.classList.add("bonus");
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      await heartPays(ctx, m, false);
      await ctx.wait(1200);
    }
  }
```

Make sure `miniTable()` removes the `bonus` class when a slide is rebuilt (it constructs a fresh table each `show()`, so nothing leaks; confirm by stepping back from slide 8 to 7).

- [ ] **Step 2: Fix slide 5's caption and remove its duplicate stepper**

Slide 5's caption becomes:

```js
    caption: "You pay each player their own bid. Every later heart then pays you 10 from each of them. The dock stacks a chip for every 10 you bid.",
```

Delete `controls: true` from that slide and change its `run` to use a fixed two hearts (`const n = 2;` in place of `const n = opts.hearts;`). The slide-level `.tut-controls` stepper is then never shown; delete the `controls` element handling in `show()` (`controls.hidden = !slide.controls;` stays correct and simply never fires true) and the `hearts` variable plus its listener block at the bottom of `createTutorial`.

- [ ] **Step 3: Fix the calculator's arithmetic and wording**

In `renderCalculator`, the note is built at `tutorial.js:412`. The break-even is what matters and the current text both misgrammars and omits it. Replace the note line with:

```js
      const sellers = rows.length - r.buyers.length;
      const perCard = CARD_PAYOUT * sellers;
      const paid = r.buyers.length ? r.buyers.reduce((sum, name) => sum + bidOf(name), 0) - bidOf(r.buyers[0]) + bidOf(r.buyers[0]) : 0;
      note.textContent = r.void
        ? "No trade — everyone bid the same."
        : `${r.buyers.join(" & ")} ${r.buyers.length > 1 ? "buy" : "buys"} hearts for ${cost}. Each later heart pays ${perCard}, so ${Math.ceil(cost / perCard)} hearts break even.`;
```

where `cost` is the sum of the *sellers'* bids (what the buyer actually pays). Compute it from the same `bids` object the row sliders drive:

```js
      const cost = r.sellers.reduce((sum, name) => sum + bids[name], 0);
```

Sanity check the reviewed example: bids 80/50/20 → the 80 buys, pays 50+20 = **70**, collects 10 from each of **2** sellers = **20 per heart**, so `ceil(70/20)` = **4 hearts**. Four, not seven.

- [ ] **Step 4: Add instruction lines and live announcements**

Add above each interactive slide's controls:

```html
<p class="tut-instruction">Drag a bid and watch who wins the suit — and who wins the money.</p>
```

for the calculator, and for the stepper row: `"Set how many hearts are still to come."` Give the note `aria-live="polite"` so a slider or stepper change is announced, and give each slider a distinct accessible name:

```js
      input.setAttribute("aria-label", `${name} bid`);
```

CSS: `.tut-instruction { text-align: center; color: var(--gold-2); font-size: 0.9rem; margin: 0; }`

- [ ] **Step 5: Verify**

Run: `node tut.mjs 3011` (source in Task 12). Expected: 8 dots; slide 1's caption has no "double"; slide 8 mentions the bonus round; the calculator at the default bids reads "4 hearts break even"; no slide reports overlapping boxes between `.tut-stage` and the calculator's first row.

Step through all eight slides at 360 px and confirm nothing overlaps.

- [ ] **Step 6: Commit**

```bash
git add public/js/tutorial.js public/styles.css
git commit -m "feat: reorder and correct the how-to-play"
```

---

### Task 12: Verification harnesses and the full pass

These scripts live in the session scratchpad, not the repo. Write them once, early — Tasks 3, 6, 8, 9, 10 and 11 all call them.

**Files:**
- Create: `$SCRATCH/verify.mjs`, `$SCRATCH/flight.mjs`, `$SCRATCH/bonus.mjs`, `$SCRATCH/results.mjs`, `$SCRATCH/tut.mjs`

- [ ] **Step 1: `verify.mjs` — layout at every width**

```js
import { chromium } from 'playwright';
const port = process.argv[2] || 3011;
const WIDTHS = process.argv.slice(3).map(Number);
const RAIL = 15;
const b = await chromium.launch({ channel: 'chrome' });
let failures = 0;
for (const W of (WIDTHS.length ? WIDTHS : [320, 360, 414, 768, 1024])) {
  const page = await b.newPage({ viewport: { width: W, height: 780 } });
  await page.goto(`http://localhost:${port}/`);
  await page.fill('#nameInput', 'You');
  await page.click('#quickBtn');
  await page.waitForSelector('#dock:not([hidden])', { timeout: 40000 });
  await page.waitForTimeout(900);
  const r = await page.evaluate((RAIL) => {
    const t = document.getElementById('table').getBoundingClientRect();
    const a = t.width / 2 - RAIL, bb = t.height / 2 - RAIL;
    const cx = t.left + t.width / 2, cy = t.top + t.height / 2;
    const outside = [];
    for (const s of document.querySelectorAll('.seat')) {
      const q = s.getBoundingClientRect();
      const worst = Math.max(...[[q.left, q.top], [q.right, q.top], [q.left, q.bottom], [q.right, q.bottom]]
        .map(([x, y]) => ((x - cx) ** 2) / (a * a) + ((y - cy) ** 2) / (bb * bb)));
      if (worst > 1.0001) outside.push({ seat: (s.querySelector('.seat-name') || {}).textContent || '(empty)', ratio: +worst.toFixed(3) });
    }
    const dock = document.getElementById('dock').getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      outside,
      covered: [...document.querySelectorAll('.seat')].filter(s => s.getBoundingClientRect().bottom > dock.top + 1)
        .map(s => (s.querySelector('.seat-name') || {}).textContent),
      handH: Math.round(document.getElementById('hand').getBoundingClientRect().height),
      countsVisible: !!document.getElementById('suitCounts')?.checkVisibility?.()
    };
  }, RAIL);
  const problems = [];
  if (r.scrollW > r.clientW) problems.push(`horizontal scroll (${r.scrollW} > ${r.clientW})`);
  if (r.outside.length) problems.push(`pods outside felt: ${JSON.stringify(r.outside)}`);
  if (r.covered.length) problems.push(`pods under the dock: ${r.covered.join(', ')}`);
  if (r.handH < 40) problems.push(`hand row collapsed (${r.handH}px)`);
  if (!r.countsVisible) problems.push('suit counts not visible');
  if (problems.length) { failures++; console.log(`FAIL ${W}px\n   - ` + problems.join('\n   - ')); }
  else console.log(`ok   ${W}px  (hand ${r.handH}px)`);
  await page.close();
}
await b.close();
console.log(failures ? `\n${failures} width(s) failing` : '\nall widths pass');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: `flight.mjs` — the card reaches the buyer inside the phase**

Watch `.stake-stack` count attributes with a MutationObserver across three auctions on the **default-timing** server; assert that for every non-void auction the observed `data-count` rises only after a `.card.small` sprite has existed in `#sprites`, and that it has settled before `#dock` reappears.

- [ ] **Step 3: `bonus.mjs` — the cinematic fires once, at the right moment**

Poll `document.getElementById('table').classList.contains('bonus')` together with the deck count each 100 ms through a whole fast game; assert the first `true` coincides with a deck count of 5 and a visible dock, and that `#bonusBanner` animates exactly once.

- [ ] **Step 4: `results.mjs` and `tut.mjs`**

`results.mjs` plays a fast game to the results overlay and asserts the recap invariants from Task 10 Step 4. `tut.mjs` opens `/how-to-play`, walks all dots, screenshots each, and asserts the Task 11 Step 5 invariants.

- [ ] **Step 5: Full pass**

```bash
npm test 2>&1 | grep -E "^# (pass|fail)"
node verify.mjs 3011 320 360 414 768 1024
node flight.mjs 3011 && node bonus.mjs 3012 && node results.mjs 3012 && node tut.mjs 3011
```

Expected: `# fail 0` and every harness green.

- [ ] **Step 6: Shut the servers down**

Only the ones this work started (3011, 3012) — never a server the user already had running:

```bash
for p in 3011 3012; do
  pid=$(netstat -ano | grep ":$p " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "$pid" ] && powershell.exe -Command "Stop-Process -Id $pid -Force"
done
```

---

## Self-Review

**Spec coverage.** §3.1 → Task 2. §3.2/§3.3 → Task 3. §3.4 → Task 4. §4.1 → Task 5. §4.2 → Task 6. §5 → Task 10. §6 → Task 1. §7 → Task 8. §8 → Task 9. §9 → Task 7. §10 → Task 11. §11 → Task 12 plus the per-task verify steps. §12 file table matches the tasks above.

**Type consistency.** `fitRadii`/`podFace`/`seatPositions` signatures are identical in Task 2's implementation, Task 3's use, and Task 12's harness. `.stake-stack[data-suit][data-count]` and `.stake-card` are named identically in Tasks 3, 7 and 8. `bonusRoundTimeline(ctx, t, state)` matches the other timelines' shape. `renderStakeRow` returns `"3 spades, 2 hearts"` in Task 3 and nothing else depends on the old `×` form.

**Known soft spot.** Task 11 Step 3's `cost`/`paid` lines need care: `cost` is the sum of the sellers' bids, and the `paid` line in the draft is redundant — delete it and use `cost` alone. The break-even sanity check (70 → 4 hearts) is the acceptance test for that step.
