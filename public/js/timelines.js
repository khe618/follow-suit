const { SUIT_SYMBOLS } = window.GameCore;
const { paymentStreams, displayScores, payoutBaseline } = window.Transitions;

// Worst case (24 cards, 8 of them yours): 24*70 + 350 + (8*50 + 400) + 2000 + 400
// + (24*18 + 350) + 800 + 620 + 250 ≈ 8100 ms.
// Transitions.DEAL_TIMELINE_MS (8500) must stay above this sum.
const CARD_MS = 350;
const DEAL_GAP_MS = 70;
const LOOK_MS = 2000;
const LOOK_STAGGER_MS = 50;
const BIDS_PAUSE_MS = 1400;
const GATHER_MS = 800;
const SHUFFLE_MS = 800;
const FLIP_MS = 400;
const TURN_MS = 620;
const HAND_MS = 250;
const CHIPS_PER_STREAM = 6;
const CHIP_GAP_MS = 60;
const CHIP_MS = 500;

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
  const sprites = [];
  const mine = [];
  for (const target of targets) {
    const card = ctx.spawn("card small down");
    ctx.put(card, deck);
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

  // Your cards flip face down and become sprites again, then everything
  // gathers back into the deck.
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
  for (const card of all) {
    ctx.fly(card, ctx.centre(card), deck, CARD_MS, { spin: 180 }).then(() => {
      if (ctx.alive()) card.remove();
    });
    await ctx.wait(gatherGap);
  }
  await ctx.wait(CARD_MS);

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
  // In reveal/bids the server scores are still pre-auction: the purchase leg
  // starts from them and lands on displayScores (post-purchase).
  const fromScores = rawScores(state);
  const tags = new Map(players.map((p) => [p.id, t.seatEl(p.id).querySelector(".bid-tag")]));
  for (const tag of tags.values()) tag.style.visibility = "hidden";
  els.priceBadge.style.visibility = "hidden";
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
  t.announce(last.void ? "No trade" : `${last.buyers.map(nameOf).join(" and ")} ${last.buyers.length > 1 ? "buy" : "buys"} at ${last.price}`);
  if (last.void) return;
  // Let the bids sink in before the chips move.
  await ctx.wait(BIDS_PAUSE_MS);
  await payStreams(ctx, t, paymentStreams(last, ids, "bids"), fromScores, displayScores(state));
}

export async function revealCardTimeline(ctx, t, state) {
  const { els, audio } = t;
  const last = state.history[state.history.length - 1];
  const ids = state.players.map((p) => p.id);
  // Baseline from the snapshot itself, never from what the DOM showed: the
  // bids snapshot may have been skipped or its animation interrupted.
  const fromScores = payoutBaseline(state);
  for (const id of ids) t.showScore(id, fromScores[id]);

  // Flip: the state layer already shows the new reference. Hide it, stand in
  // the old reference as a sprite so the slot never goes empty, and turn the
  // top card of the deck over onto it; the state layer takes over on landing.
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
  els.refSlot.style.visibility = "";
  top.remove();
  old.remove();
  els.flash.className = `rail-flash ${last.matched ? "good" : "bad"}`;
  audio.play(last.matched ? "match" : "miss");
  t.announce(`${suitName(last.flipped)}, ${last.matched ? "match" : "miss"}`);
  await ctx.animate(els.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 });

  // Payout leg (match only), then the net delta badges on every seat.
  const to = displayScores(state);
  const streams = paymentStreams(last, ids, "card");
  if (streams.length) await payStreams(ctx, t, streams, fromScores, to);
  else for (const id of ids) t.showScore(id, to[id]);
  const badges = [];
  for (const id of ids) {
    const d = (last.deltas && last.deltas[id]) || 0;
    const badge = document.createElement("div");
    badge.className = "delta-badge " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
    badge.textContent = fmtDelta(d);
    t.seatEl(id).append(badge);
    badges.push(badge);
    ctx.animate(badge, [{ transform: "translate(-50%, 0)", opacity: 1 }, { transform: "translate(-50%, -34px)", opacity: 0 }], { duration: 1200, easing: "ease-out", fill: "forwards" }).catch(() => {});
  }
  const mine = (last.deltas && last.deltas[state.you]) || 0;
  t.announce(mine === 0 ? "You break even" : `You ${mine > 0 ? "plus" : "minus"} ${Math.abs(mine)}`);
  try {
    await ctx.wait(1200);
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
