import { emptySeat, renderLobbyCentre, initLobbyControls } from "./lobby.js";
import { createAnim } from "./anim.js";
import { dealTimeline, revealBidsTimeline, revealCardTimeline, resultsTimeline, bonusRoundTimeline } from "./timelines.js";

const { SUITS, SUIT_SYMBOLS, countSuits, rank, MAX_PLAYERS, priorValue, RUNOUT_CARDS } = window.GameCore;
const { seatPositions, fitRadii, podFace } = window.SeatLayout;
const $ = (id) => document.getElementById(id);
const RING_LENGTH = 282.7;
const MEDALS = ["🥇", "🥈", "🥉"];

export function cardEl(suit, size, down) {
  const node = document.createElement("div");
  node.className = `card ${suit || ""} ${size || ""} ${down ? "down" : ""}`.replace(/\s+/g, " ").trim();
  node.textContent = suit ? SUIT_SYMBOLS[suit] : "";
  node.setAttribute("aria-label", down ? "face-down card" : suit);
  return node;
}

export function createTable({ send, roomCode, toast, audio }) {
  const els = {
    seats: $("seats"), deck: $("deck"), deckCount: $("deckCount"), refSlot: $("refSlot"),
    priceBadge: $("priceBadge"), lobbyCentre: $("lobbyCentre"), dealBtn: $("dealBtn"), inviteBtn: $("inviteBtn"),
    sprites: $("sprites"), log: $("log"), logHead: $("logHead"), logBody: $("logBody"), suitCounts: $("suitCounts"),
    logSheet: $("logSheet"), logBtn: $("logBtn"), logCloseBtn: $("logCloseBtn"),
    logBidsBtn: $("logBidsBtn"), logPayoutsBtn: $("logPayoutsBtn"),
    hand: $("hand"), handFan: $("handFan"), handMemo: $("handMemo"), dock: $("dock"), bidInput: $("bidInput"),
    bidDownBtn: $("bidDownBtn"), bidUpBtn: $("bidUpBtn"), bidStack: $("bidStack"),
    bidRange: $("bidRange"), lockBtn: $("lockBtn"), ringArc: $("ringArc"), results: $("resultsView"), standings: $("standings"),
    recap: $("recap"), playAgainBtn: $("playAgainBtn"), table: $("table"), deckDouble: $("deckDouble"),
    bonusBanner: $("bonusBanner"), bonusNote: $("bonusNote")
  };
  const seatEls = new Map();
  let state = null;
  let draft = { auction: null, amount: 0, locked: false };
  let resyncDraft = true;
  let bidSendTimer = null;
  let deadlineAt = 0;
  let ringTotal = 1;
  let ringTimer = null;
  let lastTickSecond = -1;
  let tenAnnounced = false;
  let connected = true;

  const anim = createAnim(els.sprites);

  // Writes a displayed score without touching state (timelines tick these).
  function showScore(id, value) {
    const el = seatEls.get(id);
    if (el) setScore(el, value);
  }
  function announce(text) {
    const live = $("live");
    live.textContent = "";
    live.textContent = text;
  }
  // Every non-update render starts from a clean state layer: nothing hidden
  // or pinned by a timeline, no leftover stacks, flashes, or sprites.
  function resetTransient() {
    els.handFan.style.visibility = "";
    els.handMemo.style.opacity = "";
    els.refSlot.style.visibility = "";
    els.priceBadge.style.visibility = "";
    els.priceBadge.style.opacity = "";
    els.deckDouble.style.visibility = "";
    // Belt and braces: a cancelled bonus cinematic must never strand the dock.
    els.dock.classList.remove("pending");
    els.dock.inert = false;
    for (const el of seatEls.values()) {
      const tag = el.querySelector(".bid-tag");
      tag.style.visibility = "";
      tag.style.opacity = "";
      const avatar = el.querySelector(".avatar");
      avatar.classList.remove("peek");
      avatar.style.opacity = "";
      for (const b of el.querySelectorAll(".delta-badge")) b.remove();
      for (const k of el.querySelectorAll(".stake-stack")) k.style.visibility = "";
      for (const c of el.querySelectorAll(".stake-card")) c.style.visibility = "";
      for (const b of el.querySelectorAll(".stake-count")) b.style.visibility = "";
    }
    els.sprites.replaceChildren();
  }
  const handle = { els, audio, seatEl: (id) => seatEls.get(id) || null, orderedPlayers, showScore, announce };

  function drawAll() {
    renderSeats();
    renderCentre();
    renderLog();
    renderHand();
    renderDock();
    renderResults();
  }

  // The only fields an idempotent update may touch while a timeline owns
  // the table: connection flags, lock pips, the timer, the counter. Never
  // the hand, reference, river, scores, tags, or sprites.
  function patchLive() {
    for (const p of state.players) {
      const el = seatEls.get(p.id);
      if (!el) continue;
      el.classList.toggle("away", !p.connected);
      el.querySelector(".seat-status").className = "seat-status" + (state.phase === "bidding" && p.connected ? (p.locked ? " locked" : " thinking") : "");
    }
    if (state.phase === "bidding") renderDock();
  }

  // A real timeline error (not cancellation) must not strand the table.
  function runTimeline(fn) {
    anim.run(fn).catch((err) => {
      console.error("[table] timeline failed:", err);
      resetTransient();
      drawAll();
    });
  }

  // ---------- ordering & helpers ----------
  function orderedPlayers(s) {
    const i = s.players.findIndex((p) => p.id === s.you);
    return i < 0 ? s.players.slice() : [...s.players.slice(i), ...s.players.slice(0, i)];
  }
  function bySuit(cards) {
    return cards.slice().sort((a, b) => SUITS.indexOf(a) - SUITS.indexOf(b));
  }
  function fmtDelta(n) {
    return n > 0 ? `+${n}` : String(n);
  }
  function seatColor(index) {
    return `var(--seat-${(index % 6) + 1})`;
  }
  // The seat ring is fitted to the felt actually on screen, so pods never
  // hang over the rail at phone widths. fitRadii is an exact maximal fit,
  // which would leave pod corners sitting right on the rail; this much
  // clearance per side is added here so they sit visibly inside it.
  const POD_CLEARANCE = 5;
  let ring = { rx: 44, ry: 42 };
  function measureRing() {
    const box = els.table.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const css = getComputedStyle(document.documentElement);
    const podW = parseFloat(css.getPropertyValue("--pod-w")) || 92;
    const podH = parseFloat(css.getPropertyValue("--pod-h")) || 52;
    const next = fitRadii({
      tableW: box.width, tableH: box.height,
      podW: podW + POD_CLEARANCE * 2, podH: podH + POD_CLEARANCE * 2, railPx: 15
    });
    if (next.rx === ring.rx && next.ry === ring.ry) return false;
    ring = next;
    return true;
  }

  // On phones the log is a modal sheet; from 640px up it is simply part of
  // the page. Openness is owned here and nowhere else.
  const wide = matchMedia("(min-width: 640px)");
  function syncLogSheet() {
    if (wide.matches) {
      if (els.logSheet.open) els.logSheet.close();
      els.logSheet.show();
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
    if (!wide.matches && els.logSheet.open) els.logSheet.close();
  }
  // createTable runs again on every rejoin (app.js) against the same static
  // DOM, so these have to come off again in dispose or they stack up.
  const teardown = new AbortController();
  const on = { signal: teardown.signal };
  wide.addEventListener("change", syncLogSheet, on);
  els.logBtn.addEventListener("click", openLogSheet, on);
  els.logCloseBtn.addEventListener("click", closeLogSheet, on);
  els.logSheet.addEventListener("close", () => { if (!wide.matches) els.logBtn.focus(); }, on);
  els.logSheet.addEventListener("click", (e) => { if (e.target === els.logSheet) closeLogSheet(); }, on);
  syncLogSheet();

  // Everything in the column that is not the table. The table is sized from
  // what is left, so its own height must not feed back in here.
  const chrome = [document.querySelector(".topbar"), els.hand, els.suitCounts, els.dock];
  function measureChrome() {
    let total = 0;
    for (const el of chrome) {
      if (!el || el.hidden) continue;
      total += el.getBoundingClientRect().height;
    }
    document.documentElement.style.setProperty("--chrome-h", `${Math.round(total)}px`);
  }
  const chromeObserver = new ResizeObserver(measureChrome);
  for (const el of chrome) if (el) chromeObserver.observe(el);

  const ringObserver = new ResizeObserver(() => {
    if (measureRing() && state) renderSeats();
  });
  ringObserver.observe(els.table);

  function place(el, pos) {
    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
  }

  // ---------- seats (state layer) ----------
  function buildSeat(p, index) {
    const el = document.createElement("div");
    el.className = "seat";
    el.dataset.id = p.id;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.setProperty("--seat-color", seatColor(index));
    avatar.textContent = (p.name[0] || "?").toUpperCase();
    if (p.isBot) {
      const mark = document.createElement("span");
      mark.className = "bot-mark";
      mark.textContent = "⚙";
      mark.setAttribute("aria-hidden", "true");
      avatar.append(mark);
    }
    const name = document.createElement("div");
    name.className = "seat-name";
    const score = document.createElement("div");
    score.className = "seat-score";
    const num = document.createElement("span");
    num.className = "score-num";
    score.append(num);
    const stakes = document.createElement("div");
    stakes.className = "seat-stakes";
    const status = document.createElement("div");
    status.className = "seat-status";
    const tag = document.createElement("div");
    tag.className = "bid-tag";
    tag.hidden = true;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "seat-remove";
    remove.textContent = "×";
    remove.hidden = true;
    remove.addEventListener("click", () => send({ type: "remove-bot", playerId: p.id }));
    el.append(tag, avatar, name, score, stakes, status, remove);
    return el;
  }

  function setScore(el, value) {
    const num = el.querySelector(".score-num");
    num.textContent = String(value);
    num.dataset.value = String(value);
    const wrap = el.querySelector(".seat-score");
    wrap.classList.toggle("pos", value > 0);
    wrap.classList.toggle("neg", value < 0);
  }

  // Stakes a player owns, per suit, from the public stake list.
  function ownedStakes(id) {
    const out = {};
    for (const s of SUITS) out[s] = 0;
    for (const st of state.stakes || []) if (st.buyers.includes(id)) out[st.suit] += 1;
    return out;
  }
  // One stack of real cards per suit owned. Up to STACK_EDGES overlapping
  // edges, then a count badge: seven spades read as four edges and a "7",
  // never as seven cards of width.
  // Visible edges per stack, by how many suits are held. Four suits at four
  // edges each would be ~210px against a 92px pod, so the row tightens as it
  // fills; the count badge always carries the true number either way.
  const STACK_EDGES = [4, 3, 2, 1];
  const STACK_STEP = 0.7;
  function renderStakeRow(el, id) {
    const owned = ownedStakes(id);
    const suits = SUITS.filter((s) => owned[s] > 0);
    const row = el.querySelector(".seat-stakes");
    row.replaceChildren(...suits.map((s) => {
      const stack = document.createElement("div");
      stack.className = "stake-stack";
      stack.dataset.suit = s;
      stack.dataset.count = String(owned[s]);
      const edges = Math.min(STACK_EDGES[suits.length - 1], owned[s]);
      for (let i = 0; i < edges; i++) {
        const card = document.createElement("div");
        card.className = `stake-card ${s}`;
        // Offsets are card widths, not stack widths: the stack is wider
        // than one card, so a percentage here would spread them far apart.
        card.style.left = `calc(var(--stake-w) * ${(i * STACK_STEP).toFixed(2)})`;
        card.textContent = i === edges - 1 ? SUIT_SYMBOLS[s] : "";
        stack.append(card);
      }
      stack.style.width = `calc(var(--stake-w) * ${(1 + (edges - 1) * STACK_STEP).toFixed(2)})`;
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

  function renderSeats() {
    const players = orderedPlayers(state);
    const lobby = state.phase === "lobby";
    const positions = seatPositions(lobby ? MAX_PLAYERS : Math.max(1, players.length), ring);
    const scores = {};
    for (const p of state.players) scores[p.id] = p.score;
    const last = state.history[state.history.length - 1];
    const inReveal = state.phase === "reveal" && last;
    const keep = new Set();
    players.forEach((p, i) => {
      let el = seatEls.get(p.id);
      if (!el) {
        el = buildSeat(p, state.players.findIndex((x) => x.id === p.id));
        seatEls.set(p.id, el);
        els.seats.append(el);
      }
      keep.add(p.id);
      place(el, positions[i]);
      el.dataset.face = podFace(positions[i]);
      el.classList.toggle("you", p.id === state.you);
      el.classList.toggle("away", !p.connected);
      el.classList.toggle("buyer", Boolean(inReveal && last.buyers.includes(p.id)));
      const nameEl = el.querySelector(".seat-name");
      nameEl.textContent = p.name.length > 10 ? `${p.name.slice(0, 10)}…` : p.name;
      nameEl.title = p.name;
      setScore(el, scores[p.id]);
      const holds = renderStakeRow(el, p.id);
      const status = el.querySelector(".seat-status");
      status.className = "seat-status" + (state.phase === "bidding" && p.connected ? (p.locked ? " locked" : " thinking") : "");
      const tag = el.querySelector(".bid-tag");
      tag.hidden = !inReveal || Boolean(last.runout);
      if (inReveal) tag.textContent = String(last.bids[p.id]);
      const remove = el.querySelector(".seat-remove");
      remove.hidden = !(lobby && p.isBot);
      remove.setAttribute("aria-label", `Remove ${p.name}`);
      // Away wins over locked: the server reports a disconnected human as locked.
      const statusText = !p.connected ? "away" : state.phase === "bidding" ? (p.locked ? "bid placed" : "thinking") : "";
      el.setAttribute("aria-label", `${p.name}, ${scores[p.id]} points${statusText ? ", " + statusText : ""}${holds ? ", holds " + holds : ""}${p.isBot ? ", bot" : ""}`);
    });
    for (const [id, el] of seatEls) {
      if (!keep.has(id)) {
        el.remove();
        seatEls.delete(id);
      }
    }
    for (const e of els.seats.querySelectorAll(".seat.empty")) e.remove();
    if (lobby) {
      for (let i = players.length; i < MAX_PLAYERS; i++) {
        const seat = emptySeat(positions[i], false, send);
        seat.dataset.face = podFace(positions[i]);
        els.seats.append(seat);
      }
    }
  }

  // ---------- centre, river, hand ----------
  // Deck thickness: one 2 px shadow layer per 3 cards remaining, capped at 8.
  function deckShadow(cards) {
    const layers = Math.min(8, Math.ceil(cards / 3));
    const parts = [];
    for (let i = 1; i <= layers; i++) parts.push(`0 ${i * 2}px 0 ${i % 2 ? "#5a2222" : "#4a1a1a"}`);
    parts.push("0 10px 18px rgba(0, 0, 0, 0.6)");
    return parts.join(", ");
  }

  function renderCentre() {
    const lobby = state.phase === "lobby";
    els.lobbyCentre.hidden = !lobby;
    els.deck.classList.toggle("empty", !lobby && state.cardsRemaining === 0);
    els.deck.style.boxShadow = deckShadow(lobby ? 21 : state.cardsRemaining);
    els.deckCount.textContent = lobby ? "" : String(state.cardsRemaining);
    // Stays lit through the last flip and into results (cardsRemaining hits
    // 0 exactly there); only the deck's own size, or a fresh lobby, hides it.
    els.deckDouble.hidden = lobby || state.cardsRemaining > RUNOUT_CARDS;
    // Derived, so a reconnect mid-bonus-round lands dressed with no animation.
    els.table.classList.toggle("bonus", !lobby && state.cardsRemaining <= RUNOUT_CARDS);
    els.refSlot.replaceChildren();
    if (!lobby && state.reference) els.refSlot.append(cardEl(state.reference, "big"));
    const last = state.history[state.history.length - 1];
    const showPrice = state.phase === "reveal" && last && !last.runout;
    els.priceBadge.hidden = !showPrice;
    if (showPrice) {
      els.priceBadge.textContent = last.void ? "no trade" : `${SUIT_SYMBOLS[last.reference]} ${last.topBid}`;
      els.priceBadge.setAttribute("aria-label", last.void ? "no trade" : `winning bid ${last.topBid} on ${last.reference}`);
      els.priceBadge.classList.toggle("void", last.void);
    }
    if (lobby) renderLobbyCentre(els, state);
  }

  // The log above the table: one column per card flipped so far, one row
  // per player with either the bid they made while that card was the
  // reference or (toggled) what that auction paid them. The current
  // reference gets a pending column until its bids are revealed; in the
  // payouts view the column stays pending until the next card settles it.
  // The deal timeline empties the log so the first reference is not given
  // away before it is flipped.
  let logMode = "bids";
  function setLogMode(mode) {
    logMode = mode;
    els.logBidsBtn.setAttribute("aria-pressed", String(mode === "bids"));
    els.logPayoutsBtn.setAttribute("aria-pressed", String(mode === "payouts"));
    els.log.querySelector(".log-table").setAttribute("aria-label", mode === "bids" ? "Cards and bids so far" : "Cards and payouts so far");
    // A running timeline owns the log (the deal blanks it); the next full draw catches up.
    if (state && !anim.running()) renderLog();
  }
  function renderLog() {
    const show = state.phase !== "lobby";
    // Availability, not openness: whether the sheet is up is owned by
    // syncLogSheet, so a render can never reopen one the player closed.
    els.log.dataset.available = String(show);
    els.logBtn.disabled = !show;
    if (!show) return;
    const players = orderedPlayers(state);
    const cols = state.history.map((h) => ({ suit: h.reference, entry: h }));
    if (state.flipped.length > state.history.length) cols.push({ suit: state.flipped[state.flipped.length - 1], entry: null });
    els.logHead.replaceChildren();
    const corner = document.createElement("th");
    corner.className = "log-corner";
    corner.scope = "col";
    corner.textContent = "Card";
    els.logHead.append(corner);
    cols.forEach((col, i) => {
      const th = document.createElement("th");
      th.className = "log-card";
      th.scope = "col";
      if (i === cols.length - 1) th.classList.add("current");
      th.append(cardEl(col.suit, "mini"));
      els.logHead.append(th);
    });
    els.logBody.replaceChildren();
    for (const p of players) {
      const tr = document.createElement("tr");
      const name = document.createElement("th");
      name.className = "log-name";
      name.scope = "row";
      name.textContent = p.id === state.you ? "You" : p.name.length > 8 ? `${p.name.slice(0, 8)}…` : p.name;
      name.title = p.name;
      name.style.setProperty("--seat-color", seatColor(state.players.findIndex((x) => x.id === p.id)));
      if (p.id === state.you) name.classList.add("you");
      tr.append(name);
      cols.forEach((col, i) => {
        const cell = document.createElement("td");
        if (i === cols.length - 1) cell.classList.add("current");
        const entry = col.entry;
        if (entry && logMode === "bids") {
          if (entry.runout) {
            cell.textContent = "–";
            cell.classList.add("void");
          } else {
            cell.textContent = String(entry.bids[p.id]);
            if (entry.buyers.includes(p.id)) cell.classList.add("buyer");
          }
        } else if (entry && entry.deltas) {
          const d = entry.deltas[p.id] || 0;
          cell.textContent = fmtDelta(d);
          if (d > 0) cell.classList.add("pos");
          else if (d < 0) cell.classList.add("neg");
          else if (entry.void) cell.classList.add("void");
          if (entry.buyers.includes(p.id)) cell.classList.add("buyer");
        } else {
          cell.textContent = "·";
          cell.classList.add("pending");
        }
        tr.append(cell);
      });
      els.logBody.append(tr);
    }
    const scroller = els.log.querySelector(".log-scroll");
    scroller.scrollLeft = scroller.scrollWidth;
    const counts = countSuits(state.flipped);
    els.suitCounts.replaceChildren(...SUITS.map((suit) => {
      const chip = document.createElement("span");
      chip.className = `suit-chip ${suit}`;
      chip.textContent = `${SUIT_SYMBOLS[suit]} ${counts[suit]}`;
      return chip;
    }));
  }

  // The fan is only ever shown by the deal timeline (your cards, face up,
  // for the look). After the shuffle-back the cards are in the deck, so the
  // hand area shows a memo of what you were dealt instead.
  function renderHand() {
    els.handFan.replaceChildren();
    els.handMemo.replaceChildren();
    const cards = state.hand ? bySuit(state.hand) : [];
    const n = cards.length;
    // A two-player hand is ten cards, which at a fixed overlap (plus the
    // bulge the rotation adds) runs off a 360px screen and makes the whole
    // page scroll sideways. Fit the fan to the row it actually has.
    const CARD_W = 46;
    const BULGE = 26;
    const box = els.hand.clientWidth || document.documentElement.clientWidth;
    const step = n > 1 ? Math.max(12, Math.min(CARD_W - 8, (box - CARD_W - BULGE) / (n - 1))) : CARD_W;
    const tilt = Math.min(6, 42 / Math.max(1, n));
    els.handFan.style.setProperty("--step", `${step.toFixed(2)}px`);
    cards.forEach((suit, i) => {
      const c = cardEl(suit, "small");
      const offset = i - (n - 1) / 2;
      c.style.setProperty("--rot", `${(offset * tilt).toFixed(2)}deg`);
      c.style.setProperty("--lift", `${Math.abs(offset) * 3}px`);
      els.handFan.append(c);
    });
    const inGame = state.phase !== "lobby" && n > 0;
    els.handMemo.hidden = !inGame || state.phase === "dealing";
    if (!inGame) return;
    const label = document.createElement("span");
    label.className = "memo-label";
    label.textContent = "You were dealt";
    els.handMemo.append(label);
    const counts = countSuits(state.hand);
    for (const suit of SUITS) {
      const chip = document.createElement("span");
      chip.className = `suit-chip ${suit}`;
      chip.textContent = `${SUIT_SYMBOLS[suit]} ${counts[suit]}`;
      els.handMemo.append(chip);
    }
  }

  // ---------- dock (bidding) ----------
  function renderDock() {
    const bidding = state.phase === "bidding";
    els.dock.hidden = !bidding;
    els.bonusNote.hidden = !bidding || state.cardsRemaining > RUNOUT_CARDS;
    measureChrome();
    if (!bidding) {
      stopRing();
      renderBidStack();
      return;
    }
    if (resyncDraft || draft.auction !== state.auctionIndex) {
      resyncDraft = false;
      clearTimeout(bidSendTimer);
      draft = {
        auction: state.auctionIndex,
        amount: state.myBid ? state.myBid.amount : defaultBid(),
        locked: state.myBid ? state.myBid.locked : false
      };
      tenAnnounced = false;
      els.bidInput.value = draft.amount;
      els.bidRange.value = draft.amount;
      // The server scores a silent player at 0, so the default the dock
      // shows is sent as soon as the auction opens to make it the real bid.
      if (!state.myBid) scheduleBidSend(true);
    }
    ringTotal = Math.max(1, state.timing.bidMs);
    deadlineAt = performance.now() + state.remainingMs;
    paintLock();
    startRing();
    renderBidStack();
  }

  function paintLock() {
    els.lockBtn.textContent = draft.locked ? "Bid placed" : "Bid";
    els.lockBtn.classList.toggle("locked", draft.locked);
    els.ringArc.classList.toggle("locked", draft.locked);
  }

  // The dock stacks a chip for every 10 you bid, so the number has a size
  // you can see. It lives in the dock (not on your seat, where it used to
  // cover your own avatar); every non-bidding phase clears it.
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

  function tickRing() {
    const ms = Math.max(0, deadlineAt - performance.now());
    const fraction = Math.min(1, ms / ringTotal);
    els.ringArc.style.strokeDashoffset = String(RING_LENGTH * (1 - fraction));
    if (!tenAnnounced && ms > 0 && ms <= 10000) {
      tenAnnounced = true;
      announce("Ten seconds left");
    }
    const urgent = ms < 5000 && !draft.locked;
    els.ringArc.classList.toggle("urgent", urgent);
    const second = Math.ceil(ms / 1000);
    if (urgent && second !== lastTickSecond && second > 0) {
      lastTickSecond = second;
      audio.play("tick", 5 - second);
    }
    if (!urgent) lastTickSecond = -1;
  }
  function startRing() {
    tickRing();
    if (!ringTimer) ringTimer = setInterval(tickRing, 100);
  }
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
  }

  // The public prior for the reference suit: what a silent player bids.
  function defaultBid() {
    return priorValue(state.flipped || [], state.cardsRemaining || 0);
  }
  // Both controls always follow the draft, except the one the change came
  // from: rewriting the number input while it is being typed into would
  // fight the caret (and it holds focus for the whole auction, so testing
  // document.activeElement instead would freeze it on every slider drag).
  function setDraftAmount(raw, source) {
    let n = Math.round(Number(raw));
    if (!Number.isFinite(n)) n = defaultBid();
    n = Math.max(0, Math.min(100, n));
    draft.amount = n;
    draft.locked = false;
    if (source !== els.bidRange) els.bidRange.value = n;
    if (source !== els.bidInput) els.bidInput.value = n;
    paintLock();
    renderBidStack();
    scheduleBidSend(false);
  }
  function scheduleBidSend(immediate) {
    clearTimeout(bidSendTimer);
    const fire = () => send({ type: "bid", auction: draft.auction, amount: draft.amount, locked: draft.locked });
    if (immediate) fire();
    else bidSendTimer = setTimeout(fire, 150);
  }
  function lockBid() {
    draft.locked = !draft.locked;
    paintLock();
    audio.play(draft.locked ? "lock" : "tap");
    scheduleBidSend(true);
  }

  // ---------- results ----------
  function renderResults() {
    const show = state.phase === "results";
    els.results.hidden = !show;
    if (!show) return;
    const scores = {};
    for (const p of state.players) scores[p.id] = p.score;
    els.standings.replaceChildren();
    for (const row of rank(scores)) {
      const p = state.players.find((x) => x.id === row.id);
      const li = document.createElement("li");
      li.className = "standing" + (row.id === state.you ? " you" : "");
      const medal = document.createElement("span");
      if (row.rank <= 3) {
        medal.className = "medal";
        medal.textContent = MEDALS[row.rank - 1];
      } else {
        medal.className = "rank-num";
        medal.textContent = `#${row.rank}`;
      }
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      const hand = document.createElement("span");
      hand.className = "mini-hand";
      for (const suit of bySuit(p.hand || [])) hand.append(cardEl(suit, "mini"));
      const score = document.createElement("span");
      score.className = "score " + (row.score > 0 ? "pos" : row.score < 0 ? "neg" : "zero");
      score.textContent = fmtDelta(row.score);
      li.append(medal, name, hand, score);
      els.standings.append(li);
    }
    renderRecap();
  }

  // One cell per auction, in deck order. The bonus divider sits on the FINAL
  // auction, because that is where doubling starts: every card still to come
  // from there pays double. That cell keeps its buyer - it is a real auction,
  // and the first doubled card is exactly what it pays on.
  function renderRecap() {
    const nameOf = (id) => (state.players.find((p) => p.id === id) || { name: id }).name;
    const seatIndexOf = (id) => state.players.findIndex((p) => p.id === id);
    const deckSize = state.flipped.length + state.cardsRemaining;
    const bonusFrom = deckSize - RUNOUT_CARDS;
    els.recap.replaceChildren(...state.history.map((h) => {
      const li = document.createElement("li");
      li.className = "recap-cell" + (h.index === bonusFrom ? " bonus-start" : "");
      // There is no single "price": topBid only decides who buys. What the
      // buyer actually pays is every seller's own bid.
      const paid = h.buyers.length ? -(h.purchase[h.buyers[0]] || 0) : 0;
      const mine = (h.deltas && h.deltas[state.you]) || 0;
      const isDoubled = h.index + 1 > bonusFrom;

      const ref = cardEl(h.reference, "mini");
      const who = document.createElement("div");
      who.className = "recap-who";
      if (h.runout) who.textContent = "—";
      else if (h.void) { who.textContent = "void"; who.classList.add("void"); }
      else {
        // One chip per buyer, so a tie is not flattened into one name.
        for (const id of h.buyers) {
          const chip = document.createElement("span");
          chip.className = "buyer-chip";
          chip.style.background = seatColor(seatIndexOf(id));
          chip.textContent = (nameOf(id)[0] || "?").toUpperCase();
          who.append(chip);
        }
        const price = document.createElement("span");
        price.className = "recap-paid";
        price.textContent = String(paid);
        who.append(price);
      }
      const flip = cardEl(h.flipped, "mini");
      if (isDoubled) flip.classList.add("doubled");
      const delta = document.createElement("span");
      delta.className = "recap-delta " + (mine > 0 ? "pos" : mine < 0 ? "neg" : "zero");
      delta.textContent = fmtDelta(mine);

      for (const el of [ref, who, flip, delta]) el.setAttribute("aria-hidden", "true");
      li.append(ref, who, flip, delta);
      li.setAttribute("aria-label",
        `Round ${h.index}, ${h.reference}: ` +
        (h.runout ? "bonus round, no auction"
          : h.void ? "no trade"
          : `${h.buyers.map(nameOf).join(" and ")} bought for ${paid}`) +
        `, flipped ${h.flipped}${isDoubled ? ", paying double" : ""}` +
        `, you ${mine >= 0 ? "plus" : "minus"} ${Math.abs(mine)}`);
      return li;
    }));
  }

  // ---------- public ----------
  function render(next, p) {
    state = next;
    if (p.kind === "update") {
      if (anim.running()) patchLive();
      else drawAll();
      return;
    }
    anim.cancelAll();
    resetTransient();
    if (p.kind === "hydrate") resyncDraft = true;
    drawAll();
    // A dealing snapshot drawn as its final frame (no time left to animate).
    if (state.phase === "dealing" && p.kind !== "deal") els.handMemo.hidden = false;
    switch (p.kind) {
      case "deal":
        announce("Dealing");
        els.logHead.replaceChildren();
        els.logBody.replaceChildren();
        els.suitCounts.replaceChildren();
        runTimeline((ctx) => dealTimeline(ctx, handle, next));
        break;
      case "bonusBidding":
        // drawAll() has already shown the dock, and patchLive() can re-render
        // it mid-timeline, so the banner gets its beat only if the dock is
        // explicitly held back. The draft and the automatic default bid are
        // unaffected: a silent player is still scored.
        els.dock.classList.add("pending");
        els.dock.inert = true;
        audio.play("dealin");
        runTimeline((ctx) => bonusRoundTimeline(ctx, handle, next).finally(() => {
          // Always release the dock, but only take focus if this timeline is
          // still the current one: cancellation runs finally() too.
          els.dock.classList.remove("pending");
          els.dock.inert = false;
          if (ctx.alive()) els.bidInput.focus({ preventScroll: true });
        }));
        break;
      case "bidding":
        els.dock.classList.remove("in");
        void els.dock.offsetWidth;
        els.dock.classList.add("in");
        audio.play("dealin");
        {
          const active = document.activeElement;
          const busy = active && (active.tagName === "INPUT" || active.tagName === "BUTTON") && active !== els.lockBtn;
          if (!busy) els.bidInput.focus({ preventScroll: true });
        }
        break;
      case "revealBids":
        runTimeline((ctx) => revealBidsTimeline(ctx, handle, next));
        break;
      case "revealCard":
        runTimeline((ctx) => revealCardTimeline(ctx, handle, next));
        break;
      case "results":
        runTimeline((ctx) => resultsTimeline(ctx, handle, next));
        break;
      case "lobby":
        announce("Back in the lobby");
        break;
      default:
        break;
    }
  }

  function setConnected(ok) {
    connected = ok;
    for (const id of ["bidInput", "bidRange", "bidDownBtn", "bidUpBtn", "lockBtn"]) els[id].disabled = !ok;
    if (!ok) clearTimeout(bidSendTimer);
    else resyncDraft = true;
  }

  function dispose() {
    stopRing();
    clearTimeout(bidSendTimer);
    ringObserver.disconnect();
    chromeObserver.disconnect();
    teardown.abort();
    if (els.logSheet.open) els.logSheet.close();
    anim.cancelAll();
    resetTransient();
  }

  initLobbyControls(els, { send, roomCode, toast });
  // Same teardown as the log sheet: these sit on static DOM that outlives the
  // table, so without the signal a rejoin would leave a second set attached
  // and every bid or Play again would be sent twice.
  els.bidInput.addEventListener("input", (event) => setDraftAmount(event.target.value, els.bidInput), on);
  els.bidRange.addEventListener("input", (event) => setDraftAmount(event.target.value, els.bidRange), on);
  const step = (delta) => {
    audio.play("tap");
    setDraftAmount(draft.amount + delta);
  };
  els.bidDownBtn.addEventListener("click", () => step(-1), on);
  els.bidUpBtn.addEventListener("click", () => step(1), on);
  els.lockBtn.addEventListener("click", lockBid, on);
  els.logBidsBtn.addEventListener("click", () => setLogMode("bids"), on);
  els.logPayoutsBtn.addEventListener("click", () => setLogMode("payouts"), on);
  els.playAgainBtn.addEventListener("click", () => send({ type: "return-to-lobby" }), on);

  return { render, dispose, setConnected, els, seatEl: (id) => seatEls.get(id) || null, orderedPlayers, isConnected: () => connected };
}
