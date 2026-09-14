const { SUIT_SYMBOLS, SUITS, POOL_PER_SUIT, RUNOUT_CARDS } = window.GameCore;
const POOL = SUITS.length * POOL_PER_SUIT;
const { paymentStreams, legBaseline } = window.Transitions;

// Worst case (2 players: 20 cards, 10 of them yours): 20*70 + 350 + (10*50 + 400)
// + 2000 + 400 + 400 + (20*18 + 350) + 800 + 620 + 250 ≈ 7900 ms.
// Transitions.DEAL_TIMELINE_MS (8500) must stay above this sum.
const CARD_MS = 350;
const SET_ASIDE_MS = 400;
const DEAL_GAP_MS = 70;
const LOOK_MS = 2000;
const LOOK_STAGGER_MS = 50;
const BIDS_PAUSE_MS = 1400;
const GATHER_MS = 800;
const SHUFFLE_MS = 800;
const FLIP_MS = 400;
const TURN_MS = 620;
const COMPARE_MS = 800;
const HAND_MS = 250;
const CHIPS_PER_STREAM = 6;
const CHIP_GAP_MS = 60;
const CHIP_MS = 500;
const DELTA_IN_MS = 150;
const DELTA_HOLD_MS = 1300;
const DELTA_OUT_MS = 250;

function fmtDelta(n) {
  return n > 0 ? `+${n}` : String(n);
}
function suitName(suit) {
  return suit[0].toUpperCase() + suit.slice(1);
}
function rawScores(state) {
  const out = {};
  for (const p of state.players) out[p.id] = p.score;
  return out;
}

// Where a seat's dealt cards rest: beside the avatar, on the side facing
// the middle of the table, so the avatar and name stay readable. Later
// rounds stack a little up and out. The top seat's cards are kept inside
// the table rather than poking above it.
export function holdSpot(ctx, avatarEl, tableEl, round = 0) {
  const c = ctx.centre(avatarEl);
  const t = ctx.centre(tableEl);
  const side = c.x < t.x + 1 ? 1 : -1;
  return { x: c.x + side * (c.w * 0.75 + round * 2), y: Math.max(c.y - c.h * 0.55, c.h * 0.85) - round * 2 };
}

// The pool that was not dealt is set aside unseen: a few card backs slide
// off the deck and out of the table, and the deck fades until the hands
// come back to rebuild it. Shared with the tutorial's second slide.
export async function setAside(ctx, deckEl, deckCountEl, tableEl, count) {
  const deck = ctx.centre(deckEl);
  const table = ctx.centre(tableEl);
  const gone = { x: table.x - table.w / 2 - deck.w, y: deck.y };
  deckCountEl.textContent = "";
  deckEl.classList.add("empty");
  const n = Math.min(5, count);
  const flights = [];
  for (let i = 0; i < n; i++) {
    const card = ctx.spawn("card small down");
    ctx.put(card, deck);
    ctx.animate(card, [{ opacity: 1 }, { opacity: 0 }], { duration: SET_ASIDE_MS, easing: "ease-in", fill: "forwards" }).catch(() => {});
    flights.push(ctx.fly(card, deck, gone, SET_ASIDE_MS, { spin: -20 }).then(() => ctx.alive() && card.remove()));
    await ctx.wait(30);
  }
  await ctx.until(Promise.all(flights.map((p) => p.catch(() => {}))));
}

export { COMPARE_MS };

// Six chips per buyer→seller (or seller→buyer) pair, all streams in parallel,
// each arrival ticking both seats' displayed scores. Lands exactly on `to`.
async function payStreams(ctx, t, streams, from, to) {
  const ids = Object.keys(to);
  const current = { ...from };
  for (const id of ids) t.showScore(id, Math.round(current[id]));
  const flights = streams.map(async (s) => {
    const a = ctx.centre(t.seatEl(s.from).querySelector(".avatar"));
    const b = ctx.centre(t.seatEl(s.to).querySelector(".avatar"));
    const perChip = s.amount / CHIPS_PER_STREAM;
    for (let i = 0; i < CHIPS_PER_STREAM; i++) {
      const chip = ctx.spawn("chip-sprite");
      ctx.fly(chip, a, b, CHIP_MS, { arc: 40, spin: 180 }).then(() => {
        if (!ctx.alive()) return;
        chip.remove();
        t.audio.play("chip");
        current[s.from] -= perChip;
        current[s.to] += perChip;
        t.showScore(s.from, Math.round(current[s.from]));
        t.showScore(s.to, Math.round(current[s.to]));
      });
      await ctx.wait(CHIP_GAP_MS);
    }
    await ctx.wait(CHIP_MS);
  });
  await ctx.until(Promise.all(flights));
  for (const id of ids) t.showScore(id, to[id]);
}

async function pop(ctx, el) {
  el.style.visibility = "";
  await ctx.animate(el, [{ transform: "scale(0.3)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.7 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "ease-out", composite: "add" });
}

export async function dealTimeline(ctx, t, state) {
  const { els, audio } = t;
  const players = t.orderedPlayers(state);
  const n = state.hand.length;
  const deck = ctx.centre(els.deck);
  els.handFan.style.visibility = "hidden";
  els.handMemo.hidden = true;
  els.refSlot.style.visibility = "hidden";
  const handCards = [...els.handFan.children];
  // Deal order per round: the seat to your left, on round to your right, then you.
  const targets = [];
  for (let round = 0; round < n; round++) {
    for (let i = 1; i < players.length; i++) targets.push({ kind: "seat", id: players[i].id, round });
    targets.push({ kind: "me", index: round });
  }
  // Everything is dealt face down; your cards are shown on the real hand
  // fan once the deal is over, so nothing has to be read mid-flight.
  // The deck starts as the full pool and counts down as hands leave it.
  const total = n * players.length;
  let inPool = POOL;
  els.deck.classList.remove("empty");
  els.deckCount.textContent = String(inPool);
  const sprites = [];
  const mine = [];
  for (const target of targets) {
    const card = ctx.spawn("card small down");
    ctx.put(card, deck);
    inPool -= 1;
    els.deckCount.textContent = String(inPool);
    sprites.push(card);
    let to;
    if (target.kind === "seat") {
      to = holdSpot(ctx, t.seatEl(target.id).querySelector(".avatar"), els.table, target.round);
    } else {
      to = ctx.centre(handCards[target.index]);
      mine.push(card);
    }
    audio.play("deal");
    ctx.fly(card, deck, to, CARD_MS, { spin: target.kind === "me" ? 0 : 360 });
    await ctx.wait(DEAL_GAP_MS);
  }
  await ctx.wait(CARD_MS);

  // The look: your sprites give way to the hand fan, which flips face up
  // one card at a time and holds while the bots glance at their cards.
  for (const card of mine) card.remove();
  for (const c of handCards) c.classList.add("down");
  els.handFan.style.visibility = "visible";
  const flipUp = handCards.map(async (c, i) => {
    await ctx.wait(i * LOOK_STAGGER_MS);
    audio.play("flip");
    await ctx.flip(c, FLIP_MS, () => c.classList.remove("down"));
  });
  await ctx.until(Promise.all(flipUp.map((p) => p.catch(() => {}))));
  for (const p of players.slice(1)) t.seatEl(p.id).querySelector(".avatar").classList.add("peek");
  await ctx.wait(LOOK_MS);
  for (const p of players.slice(1)) t.seatEl(p.id).querySelector(".avatar").classList.remove("peek");

  // The rest of the pool is set aside unseen, then your cards flip face
  // down and become sprites again, and only the hands gather back into
  // the deck.
  await setAside(ctx, els.deck, els.deckCount, els.table, inPool);
  await ctx.until(Promise.all(handCards.map((c) => ctx.flip(c, FLIP_MS, () => c.classList.add("down")).catch(() => {}))));
  const returning = handCards.map((c) => {
    const s = ctx.spawn("card small down");
    ctx.put(s, ctx.centre(c));
    return s;
  });
  els.handFan.style.visibility = "hidden";
  for (const c of handCards) c.classList.remove("down");
  const all = sprites.filter((s) => !mine.includes(s)).concat(returning);
  audio.play("shuffle");
  all.reverse();
  const gatherGap = Math.max(8, Math.floor((GATHER_MS - CARD_MS) / all.length));
  let inDeck = 0;
  for (const card of all) {
    ctx.fly(card, ctx.centre(card), deck, CARD_MS, { spin: 180 }).then(() => {
      if (!ctx.alive()) return;
      card.remove();
      inDeck += 1;
      els.deck.classList.remove("empty");
      els.deckCount.textContent = String(inDeck);
    });
    await ctx.wait(gatherGap);
  }
  await ctx.wait(CARD_MS);
  els.deck.classList.remove("empty");
  els.deckCount.textContent = String(total);

  // Riffle: two half stacks part and merge, twice.
  if (!ctx.reduced()) {
    audio.play("shuffle");
    const left = ctx.spawn("card small down");
    const right = ctx.spawn("card small down");
    ctx.put(left, deck);
    ctx.put(right, deck);
    const base = left.style.transform;
    const half = SHUFFLE_MS / 2;
    for (let i = 0; i < 2; i++) {
      ctx.animate(left, [{ transform: base }, { transform: `${base} translateX(-30px) rotate(-10deg)`, offset: 0.5 }, { transform: base }], { duration: half, easing: "ease-in-out" }).catch(() => {});
      await ctx.animate(right, [{ transform: base }, { transform: `${base} translateX(30px) rotate(10deg)`, offset: 0.5 }, { transform: base }], { duration: half, easing: "ease-in-out" });
    }
    left.remove();
    right.remove();
  } else {
    await ctx.wait(150);
  }

  // Turn the top card over into the reference slot.
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  const slot = ctx.centre(els.refSlot);
  audio.play("flip");
  await ctx.turn(top, deck, slot, TURN_MS, () => {
    top.className = `card big ${state.reference}`;
    top.textContent = SUIT_SYMBOLS[state.reference];
  });
  els.refSlot.style.visibility = "";
  top.remove();
  els.deckCount.textContent = String(total - 1);

  // Your cards are in the deck now; a memo of what you saw takes their place.
  els.handMemo.hidden = false;
  await ctx.animate(els.handMemo, [{ transform: "translateY(12px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: HAND_MS, easing: "ease-out" });
  t.announce("Cards dealt");
}

export async function revealBidsTimeline(ctx, t, state) {
  const { els, audio } = t;
  const last = state.history[state.history.length - 1];
  const players = t.orderedPlayers(state);
  const ids = state.players.map((p) => p.id);
  // The server has applied the purchase: chips fly from the pre-purchase
  // baseline onto the snapshot scores.
  const fromScores = legBaseline(state);
  const toScores = rawScores(state);
  const tags = new Map(players.map((p) => [p.id, t.seatEl(p.id).querySelector(".bid-tag")]));
  for (const tag of tags.values()) tag.style.visibility = "hidden";
  els.priceBadge.style.visibility = "hidden";
  // The state layer already drew the buyer's new stake chip; hold it back
  // until the purchase lands.
  const newChips = last.void ? [] : last.buyers.map((id) => t.seatEl(id).querySelector(`.stake-chip.${last.reference}`)).filter(Boolean);
  for (const chip of newChips) chip.style.visibility = "hidden";
  for (const id of ids) t.showScore(id, fromScores[id]);

  const order = players.slice().sort((a, b) => last.bids[a.id] - last.bids[b.id]);
  for (const p of order) {
    audio.play("tag");
    pop(ctx, tags.get(p.id)).catch(() => {});
    await ctx.wait(120);
  }
  audio.play(last.void ? "tap" : "rise");
  await pop(ctx, els.priceBadge);
  const nameOf = (id) => state.players.find((p) => p.id === id).name;
  t.announce(last.void ? "No trade" : `${last.buyers.map(nameOf).join(" and ")} ${last.buyers.length > 1 ? "buy" : "buys"} ${last.reference}`);
  if (last.void) return;
  // Let the bids sink in before the chips move.
  await ctx.wait(BIDS_PAUSE_MS);
  await payStreams(ctx, t, paymentStreams(last, "bids"), fromScores, toScores);
  // Awaited: the sequencer cancels every tracked animation the moment the
  // timeline returns, so an un-awaited pop would never be seen.
  if (newChips.length) audio.play("tag");
  await ctx.until(Promise.all(newChips.map((chip) => pop(ctx, chip).catch(() => {}))));
}

export async function revealCardTimeline(ctx, t, state) {
  const { els, audio } = t;
  const last = state.history[state.history.length - 1];
  const ids = state.players.map((p) => p.id);
  // Baseline from the snapshot itself, never from what the DOM showed: the
  // bids snapshot may have been skipped or its animation interrupted.
  const fromScores = legBaseline(state);
  const toScores = rawScores(state);
  const payoutDelta = (id) => ((last.deltas && last.deltas[id]) || 0) - ((last.purchase && last.purchase[id]) || 0);
  const hit = (last.hits || 0) > 0;
  const streams = paymentStreams(last, "card");
  // The first runout card: the last five cards pay double from here on.
  const deckSize = state.flipped.length + state.cardsRemaining;
  const firstRunout = state.flipped.length === deckSize - RUNOUT_CARDS + 1;
  for (const id of ids) t.showScore(id, fromScores[id]);

  // Flip: the state layer already shows the new reference. Hide it, stand in
  // the old reference as a sprite so the slot never goes empty, and turn the
  // top card of the deck over directly onto it. The new suit covers the old
  // one as it lands, holds through the match/miss flash, and then the state
  // layer takes over.
  els.refSlot.style.visibility = "hidden";
  const deck = ctx.centre(els.deck);
  const slot = ctx.centre(els.refSlot);
  const old = ctx.spawn(`card big ${last.reference}`, SUIT_SYMBOLS[last.reference]);
  ctx.put(old, slot);
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  await ctx.wait(120);
  audio.play("flip");
  await ctx.turn(top, deck, slot, TURN_MS, () => {
    top.className = `card big ${last.flipped}`;
    top.textContent = SUIT_SYMBOLS[last.flipped];
  });
  const myPayout = payoutDelta(state.you);
  audio.play(myPayout > 0 ? "match" : myPayout < 0 ? "miss" : "tap");
  if (hit) {
    els.flash.className = "rail-flash pay";
    ctx.animate(els.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
  }
  const collectors = state.players.filter((p) => payoutDelta(p.id) > 0).map((p) => `${p.name} collects ${payoutDelta(p.id)}`);
  const mine = (last.deltas && last.deltas[state.you]) || 0;
  const you = mine === 0 ? "You break even" : `You ${mine > 0 ? "plus" : "minus"} ${Math.abs(mine)}`;
  t.announce(`${firstRunout ? "Final five cards, payouts double. " : ""}${suitName(last.flipped)}. ${!hit ? "No stakes" : streams.length === 0 ? "Payments cancel" : collectors.length ? collectors.join(", ") : "Payments cancel"}. ${you}`);
  await ctx.wait(COMPARE_MS);
  els.refSlot.style.visibility = "";
  top.remove();
  old.remove();
  if (firstRunout) {
    audio.play("rise");
    await pop(ctx, els.deckDouble);
  }

  // Payout leg: every stake on the flipped suit, netted per pair. Then the
  // net round delta on every seat: a badge that pops in, holds still long
  // enough to read, and fades.
  if (streams.length) await payStreams(ctx, t, streams, fromScores, toScores);
  else for (const id of ids) t.showScore(id, toScores[id]);
  const badges = [];
  for (const id of ids) {
    const d = (last.deltas && last.deltas[id]) || 0;
    const badge = document.createElement("div");
    badge.className = "delta-badge " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
    badge.textContent = fmtDelta(d);
    t.seatEl(id).append(badge);
    badges.push(badge);
    ctx.animate(badge, [{ transform: "translate(-50%, 0) scale(0.6)", opacity: 0 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1 }], { duration: DELTA_IN_MS, easing: "ease-out" }).catch(() => {});
  }
  try {
    await ctx.wait(DELTA_IN_MS + DELTA_HOLD_MS);
    await ctx.until(Promise.all(badges.map((b) => ctx.animate(b, [{ opacity: 1 }, { opacity: 0 }], { duration: DELTA_OUT_MS, fill: "forwards" }).catch(() => {}))));
  } finally {
    for (const b of badges) b.remove();
  }

  // Buyer glow, bid tags, and the price badge fade before the next auction.
  // The fade is a tracked animation (undone at teardown), so pin the end
  // state inline; resetTransient clears it on the next non-update render.
  const fading = [els.priceBadge, ...ids.map((id) => t.seatEl(id).querySelector(".bid-tag")), ...ids.filter((id) => last.buyers.includes(id)).map((id) => t.seatEl(id).querySelector(".avatar"))];
  await ctx.until(Promise.all(fading.map((el) => ctx.animate(el, [{ opacity: 1 }, { opacity: 0.25 }], { duration: 300 }).catch(() => {}))));
  for (const el of fading) el.style.opacity = "0.25";
}

export async function resultsTimeline(ctx, t, state) {
  const winner = state.players.reduce((a, b) => (b.score > a.score ? b : a), state.players[0]);
  const youWon = winner.score === state.players.find((p) => p.id === state.you).score;
  t.audio.play(youWon ? "win" : "end");
  t.announce("Game over");
  const row = t.els.standings.querySelector(".standing");
  if (!row || ctx.reduced()) return;
  const glyphs = ["♠", "♥", "♦", "♣"];
  const bits = [];
  for (let i = 0; i < 18; i++) {
    const bit = document.createElement("span");
    bit.className = "confetti " + (i % 2 ? "red" : "black");
    bit.textContent = glyphs[i % 4];
    bit.style.left = `${5 + Math.random() * 90}%`;
    row.append(bit);
    bits.push(bit);
    ctx.animate(bit, [{ transform: "translateY(-10px) rotate(0)", opacity: 1 }, { transform: `translateY(${40 + Math.random() * 30}px) rotate(${180 + Math.random() * 360}deg)`, opacity: 0 }], { duration: 900 + Math.random() * 500, easing: "ease-in", fill: "forwards" }).catch(() => {});
  }
  try {
    await ctx.wait(1500);
  } finally {
    for (const b of bits) b.remove();
  }
}
