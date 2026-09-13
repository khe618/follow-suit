const { SUIT_SYMBOLS } = window.GameCore;
const { paymentStreams, displayScores, payoutBaseline } = window.Transitions;

// Worst case (24 cards): 24*70 + 350 + 1200 + (24*18 + 350) + 200 + 800 + 250 + 400 + 250 ≈ 5910 ms.
// Transitions.DEAL_TIMELINE_MS (6000) must stay above this sum.
const CARD_MS = 350;
const DEAL_GAP_MS = 70;
const PEEK_MS = 1200;
const GATHER_MS = 800;
const SHUFFLE_MS = 800;
const FLIP_MS = 400;
const REF_FLIGHT_MS = 250;
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
  const hiddenSpot = { x: deck.x - 70, y: deck.y + 30 };
  els.hand.style.visibility = "hidden";
  els.refSlot.style.visibility = "hidden";
  const handCards = [...els.hand.children];
  const mySuits = handCards.map((c) => c.getAttribute("aria-label"));
  // Deal order per round: the seat to your left, on round to your right, then you, then a hidden card.
  const targets = [];
  for (let round = 0; round < n; round++) {
    for (let i = 1; i < players.length; i++) targets.push({ kind: "seat", id: players[i].id, round });
    targets.push({ kind: "me", index: round });
    targets.push({ kind: "hidden", round });
  }
  const sprites = [];
  const mine = [];
  for (const target of targets) {
    const card = ctx.spawn("card small down");
    ctx.put(card, deck);
    sprites.push(card);
    let to;
    if (target.kind === "seat") {
      const c = ctx.centre(t.seatEl(target.id).querySelector(".seat-stack"));
      to = { x: c.x + target.round * 2, y: c.y - target.round * 2 };
    } else if (target.kind === "me") {
      to = ctx.centre(handCards[target.index]);
      mine.push(card);
    } else {
      to = { x: hiddenSpot.x + target.round * 2, y: hiddenSpot.y - target.round * 2 };
    }
    audio.play("deal");
    ctx.fly(card, deck, to, CARD_MS, { spin: target.kind === "me" ? 0 : 360 }).then(() => {
      if (!ctx.alive() || target.kind !== "me") return;
      const suit = mySuits[target.index];
      // Flip face up on arrival. flip() throws the cancel sentinel if the run
      // has moved on; swallow it here because this branch is not awaited.
      ctx.flip(card, 200, () => {
        card.className = `card small ${suit}`;
        card.textContent = SUIT_SYMBOLS[suit];
      }).catch(() => {});
    });
    await ctx.wait(DEAL_GAP_MS);
  }
  await ctx.wait(CARD_MS);

  // Peek: nothing moves; bots glance at their cards.
  for (const p of players.slice(1)) t.seatEl(p.id).querySelector(".avatar").classList.add("peek");
  await ctx.wait(PEEK_MS);
  for (const p of players.slice(1)) t.seatEl(p.id).querySelector(".avatar").classList.remove("peek");

  // Your cards flip face down, then everything gathers back into the deck.
  await ctx.until(Promise.all(mine.map((card) => ctx.flip(card, 200, () => {
    card.className = "card small down";
    card.textContent = "";
  }).catch(() => {}))));
  audio.play("shuffle");
  sprites.reverse();
  const gatherGap = Math.max(8, Math.floor((GATHER_MS - CARD_MS) / sprites.length));
  for (const card of sprites) {
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

  // Flip the top card into the reference slot.
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  const slot = ctx.centre(els.refSlot);
  await ctx.until(ctx.fly(top, deck, slot, REF_FLIGHT_MS));
  audio.play("flip");
  await ctx.flip(top, FLIP_MS, () => {
    top.className = `card big ${state.reference}`;
    top.textContent = SUIT_SYMBOLS[state.reference];
  });
  els.refSlot.style.visibility = "";
  top.remove();

  // Your hand comes back up from the bottom edge (a fade under reduced motion).
  els.hand.style.visibility = "";
  await ctx.animate(els.hand, [{ transform: "translateY(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: HAND_MS, easing: "ease-out" });
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
  await ctx.wait(300);
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

  // Flip: the state layer already shows the new reference; hide it and fly a
  // face-down sprite from the deck into the slot, flipping it on arrival.
  els.refSlot.style.visibility = "hidden";
  const deck = ctx.centre(els.deck);
  const slot = ctx.centre(els.refSlot);
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  await ctx.until(ctx.fly(top, deck, slot, REF_FLIGHT_MS));
  audio.play("flip");
  await ctx.flip(top, FLIP_MS, () => {
    top.className = `card big ${last.flipped}`;
    top.textContent = SUIT_SYMBOLS[last.flipped];
  });
  els.refSlot.style.visibility = "";
  top.remove();
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
