import { emptySeat, renderLobbyCentre, initLobbyControls } from "./lobby.js";
import { createAnim } from "./anim.js";
import { dealTimeline, revealBidsTimeline, revealCardTimeline, resultsTimeline } from "./timelines.js";

const { SUITS, SUIT_SYMBOLS, countSuits, rank, MAX_PLAYERS } = window.GameCore;
const { seatPositions } = window.SeatLayout;
const { displayScores } = window.Transitions;
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
    seats: $("seats"), deck: $("deck"), deckCount: $("deckCount"), hiddenBadge: $("hiddenBadge"), refSlot: $("refSlot"),
    priceBadge: $("priceBadge"), lobbyCentre: $("lobbyCentre"), dealBtn: $("dealBtn"), seatCount: $("seatCount"), inviteBtn: $("inviteBtn"),
    sprites: $("sprites"), river: $("river"), suitCounts: $("suitCounts"), hand: $("hand"), dock: $("dock"), bidInput: $("bidInput"),
    bidRange: $("bidRange"), lockBtn: $("lockBtn"), ringArc: $("ringArc"), results: $("resultsView"), standings: $("standings"),
    historyBody: $("historyBody"), playAgainBtn: $("playAgainBtn"), auctionPill: $("auctionPill"), table: $("table")
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
  // The rail flash is an overlay whose opacity animates (transform/opacity
  // only, per spec); box-shadow itself never animates.
  els.flash = document.createElement("div");
  els.flash.className = "rail-flash";
  els.table.append(els.flash);

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
    els.hand.style.visibility = "";
    els.refSlot.style.visibility = "";
    els.priceBadge.style.visibility = "";
    els.priceBadge.style.opacity = "";
    els.flash.className = "rail-flash";
    for (const el of seatEls.values()) {
      const tag = el.querySelector(".bid-tag");
      tag.style.visibility = "";
      tag.style.opacity = "";
      const avatar = el.querySelector(".avatar");
      avatar.classList.remove("peek");
      avatar.style.opacity = "";
      for (const b of el.querySelectorAll(".delta-badge")) b.remove();
    }
    els.sprites.replaceChildren();
  }
  const handle = { els, audio, seatEl: (id) => seatEls.get(id) || null, orderedPlayers, showScore, announce };

  function drawAll() {
    renderTopbar();
    renderSeats();
    renderCentre();
    renderRiver();
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
    renderTopbar();
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
    const stack = document.createElement("div");
    stack.className = "seat-stack";
    const name = document.createElement("div");
    name.className = "seat-name";
    const score = document.createElement("div");
    score.className = "seat-score";
    const num = document.createElement("span");
    num.className = "score-num";
    score.append(num);
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
    el.append(tag, avatar, stack, name, score, status, remove);
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

  function renderSeats() {
    const players = orderedPlayers(state);
    const lobby = state.phase === "lobby";
    const positions = seatPositions(lobby ? MAX_PLAYERS : Math.max(1, players.length));
    const scores = displayScores(state);
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
      el.classList.toggle("you", p.id === state.you);
      el.classList.toggle("away", !p.connected);
      el.classList.toggle("buyer", Boolean(inReveal && last.buyers.includes(p.id)));
      const nameEl = el.querySelector(".seat-name");
      nameEl.textContent = p.name.length > 10 ? `${p.name.slice(0, 10)}…` : p.name;
      nameEl.title = p.name;
      setScore(el, scores[p.id]);
      const status = el.querySelector(".seat-status");
      status.className = "seat-status" + (state.phase === "bidding" && p.connected ? (p.locked ? " locked" : " thinking") : "");
      const tag = el.querySelector(".bid-tag");
      tag.hidden = !inReveal;
      if (inReveal) tag.textContent = String(last.bids[p.id]);
      const remove = el.querySelector(".seat-remove");
      remove.hidden = !(lobby && p.isBot);
      remove.setAttribute("aria-label", `Remove ${p.name}`);
      // Away wins over locked: the server reports a disconnected human as locked.
      const statusText = !p.connected ? "away" : state.phase === "bidding" ? (p.locked ? "locked" : "thinking") : "";
      el.setAttribute("aria-label", `${p.name}, ${scores[p.id]} points${statusText ? ", " + statusText : ""}${p.isBot ? ", bot" : ""}`);
    });
    for (const [id, el] of seatEls) {
      if (!keep.has(id)) {
        el.remove();
        seatEls.delete(id);
      }
    }
    for (const e of els.seats.querySelectorAll(".seat.empty")) e.remove();
    if (lobby) {
      for (let i = players.length; i < MAX_PLAYERS; i++) els.seats.append(emptySeat(positions[i], false, send));
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
    els.deck.style.boxShadow = deckShadow(lobby ? 24 : state.cardsRemaining);
    els.deckCount.textContent = lobby ? "" : String(state.cardsRemaining);
    els.hiddenBadge.textContent = lobby ? "" : `? ${state.hiddenCount}`;
    els.hiddenBadge.hidden = lobby;
    els.refSlot.replaceChildren();
    if (!lobby && state.reference) els.refSlot.append(cardEl(state.reference, "big"));
    const last = state.history[state.history.length - 1];
    const showPrice = state.phase === "reveal" && last;
    els.priceBadge.hidden = !showPrice;
    if (showPrice) {
      els.priceBadge.textContent = last.void ? "no trade" : String(last.price);
      els.priceBadge.classList.toggle("void", last.void);
    }
    if (lobby) renderLobbyCentre(els, state);
  }

  function renderRiver() {
    els.river.replaceChildren();
    if (state.phase === "lobby") {
      els.suitCounts.replaceChildren();
      return;
    }
    state.flipped.forEach((suit, i) => {
      const c = cardEl(suit, "mini");
      if (i === state.flipped.length - 1) c.classList.add("current");
      els.river.append(c);
    });
    els.river.scrollLeft = els.river.scrollWidth;
    const counts = countSuits(state.flipped);
    els.suitCounts.replaceChildren(...SUITS.map((suit) => {
      const chip = document.createElement("span");
      chip.className = `suit-chip ${suit}`;
      chip.textContent = `${SUIT_SYMBOLS[suit]} ${counts[suit]}`;
      return chip;
    }));
  }

  function renderHand() {
    els.hand.replaceChildren();
    const cards = state.hand ? bySuit(state.hand) : [];
    const n = cards.length;
    cards.forEach((suit, i) => {
      const c = cardEl(suit, "small");
      const offset = i - (n - 1) / 2;
      c.style.setProperty("--rot", `${offset * 6}deg`);
      c.style.setProperty("--lift", `${Math.abs(offset) * 3}px`);
      els.hand.append(c);
    });
  }

  function renderTopbar() {
    if (state.phase === "lobby" || state.phase === "results") {
      els.auctionPill.hidden = true;
      return;
    }
    const total = state.flipped.length + state.cardsRemaining - 1;
    const k = state.auctionIndex || state.history.length || 1;
    els.auctionPill.hidden = false;
    els.auctionPill.textContent = `${k} / ${total}`;
  }

  // ---------- dock (bidding) ----------
  function renderDock() {
    const bidding = state.phase === "bidding";
    els.dock.hidden = !bidding;
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
        amount: state.myBid ? state.myBid.amount : 0,
        locked: state.myBid ? state.myBid.locked : false
      };
      tenAnnounced = false;
      els.bidInput.value = draft.amount;
      els.bidRange.value = draft.amount;
    }
    ringTotal = Math.max(1, state.timing.bidMs);
    deadlineAt = performance.now() + state.remainingMs;
    paintLock();
    startRing();
    renderBidStack();
  }

  function paintLock() {
    els.lockBtn.textContent = draft.locked ? "Locked" : "Lock";
    els.lockBtn.classList.toggle("locked", draft.locked);
    els.ringArc.classList.toggle("locked", draft.locked);
  }

  // Your seat shows your current bid as a chip stack that grows with the
  // slider (spec 3.2). Only ever touches your own .seat-stack; every other
  // phase clears it.
  function renderBidStack() {
    const el = seatEls.get(state.you);
    if (!el) return;
    const stack = el.querySelector(".seat-stack");
    stack.replaceChildren();
    if (state.phase !== "bidding") return;
    const count = Math.ceil(draft.amount / 10);
    for (let i = 0; i < count; i++) {
      const chip = document.createElement("div");
      chip.className = "chip-sprite stack-chip";
      chip.style.transform = `translateY(${-i * 3}px)`;
      stack.append(chip);
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

  function setDraftAmount(raw) {
    let n = Math.round(Number(raw));
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(100, n));
    draft.amount = n;
    draft.locked = false;
    els.bidRange.value = n;
    if (document.activeElement !== els.bidInput) els.bidInput.value = n;
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
    const nameOf = (id) => (state.players.find((p) => p.id === id) || { name: id }).name;
    els.historyBody.replaceChildren();
    for (const h of state.history) {
      const tr = document.createElement("tr");
      const cells = [
        ["", String(h.index)],
        [`suit ${h.reference}`, SUIT_SYMBOLS[h.reference]],
        ["", state.players.map((p) => h.bids[p.id]).join(" / ")],
        ["", h.void ? `void @ ${h.price}` : `${h.buyers.map(nameOf).join(", ")} @ ${h.price}`],
        [`suit ${h.flipped}`, `${SUIT_SYMBOLS[h.flipped]}${h.matched ? " match" : ""}`],
        ["", state.players.map((p) => fmtDelta((h.deltas && h.deltas[p.id]) || 0)).join(" / ")]
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = text;
        tr.append(td);
      }
      els.historyBody.append(tr);
    }
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
    switch (p.kind) {
      case "deal":
        announce("Dealing");
        runTimeline((ctx) => dealTimeline(ctx, handle, next));
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
    for (const id of ["bidInput", "bidRange", "lockBtn"]) els[id].disabled = !ok;
    if (!ok) clearTimeout(bidSendTimer);
    else resyncDraft = true;
  }

  function dispose() {
    stopRing();
    clearTimeout(bidSendTimer);
    anim.cancelAll();
    resetTransient();
  }

  initLobbyControls(els, { send, roomCode, toast });
  els.bidInput.addEventListener("input", (event) => setDraftAmount(event.target.value));
  els.bidRange.addEventListener("input", (event) => setDraftAmount(event.target.value));
  els.lockBtn.addEventListener("click", lockBid);
  els.playAgainBtn.addEventListener("click", () => send({ type: "return-to-lobby" }));

  return { render, dispose, setConnected, els, seatEl: (id) => seatEls.get(id) || null, orderedPlayers, isConnected: () => connected };
}
