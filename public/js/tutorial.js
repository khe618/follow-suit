import { cardEl } from "./table.js";
import { createAnim } from "./anim.js";
import { holdSpot, COMPARE_MS } from "./timelines.js";

const { SUIT_SYMBOLS, SUITS } = window.GameCore;
const { seatPositions, podFace } = window.SeatLayout;
const NAMES = ["You", "A", "B"];
const fmt = (n) => (n > 0 ? `+${n}` : String(n));

// A three-seat mini table sharing the live table's seat, card, and chip CSS.
function miniTable() {
  const table = document.createElement("div");
  table.className = "table mini-table";
  const seats = document.createElement("div");
  seats.className = "seats";
  const positions = seatPositions(3);
  const seatEls = NAMES.map((name, i) => {
    const seat = document.createElement("div");
    seat.className = "seat" + (i === 0 ? " you" : "");
    seat.style.left = `${positions[i].x}%`;
    seat.style.top = `${positions[i].y}%`;
    // Same rule as the live table: cards fan toward the middle.
    seat.dataset.face = podFace(positions[i]);
    seat.innerHTML = `<div class="bid-tag" hidden></div><div class="avatar" style="--seat-color: var(--seat-${i + 1})">${name[0]}</div><div class="seat-name">${name}</div><div class="seat-score"><span class="score-num">0</span></div><div class="seat-stakes"></div>`;
    seats.append(seat);
    return seat;
  });
  const centre = document.createElement("div");
  centre.className = "centre";
  centre.innerHTML = `<div class="deck"><span class="deck-count"></span></div><div class="ref-slot"></div><div class="price-badge" hidden></div>`;
  const sprites = document.createElement("div");
  sprites.className = "sprite-layer";
  // Sprites a slide wants to outlive its animation run move here: same
  // origin as the sprite layer, above the seats and the centre.
  const keep = document.createElement("div");
  keep.className = "keep-layer";
  table.append(seats, centre, keep, sprites);
  return {
    table, seatEls, sprites, keep,
    deck: centre.querySelector(".deck"),
    deckCount: centre.querySelector(".deck-count"),
    refSlot: centre.querySelector(".ref-slot"),
    price: centre.querySelector(".price-badge"),
    tag: (i) => seatEls[i].querySelector(".bid-tag"),
    avatar: (i) => seatEls[i].querySelector(".avatar"),
    stakes: (i) => seatEls[i].querySelector(".seat-stakes"),
    score: (i, v) => {
      const el = seatEls[i].querySelector(".score-num");
      el.textContent = fmt(v);
      el.parentElement.classList.toggle("pos", v > 0);
      el.parentElement.classList.toggle("neg", v < 0);
    }
  };
}

// Deals `count` cards to each seat: the bots' land face down beside their
// avatars, yours face up in a row beside yours. `onCard` fires per card dealt,
// for a caller that wants to count along.
async function dealTo(ctx, m, count, mySuits, onCard = () => {}) {
  const deck = ctx.centre(m.deck);
  const sprites = [];
  const mineSpot = holdSpot(ctx, m.avatar(0), m.table);
  for (let round = 0; round < count; round++) {
    for (let i = 1; i < 3; i++) {
      const card = ctx.spawn("card small down");
      ctx.put(card, deck);
      const stackTarget = holdSpot(ctx, m.avatar(i), m.table, round);
      onCard();
      ctx.fly(card, deck, stackTarget, 300, { spin: 360 });
      // Bake the resting position into the sprite's inline transform now
      // (it stays invisible under the running WAAPI animation) so the card
      // holds its place once the run ends and cancels every tracked
      // animation — including this fly — rather than snapping back to the
      // deck, its last inline-styled position.
      ctx.put(card, stackTarget);
      sprites.push(card);
      await ctx.wait(80);
    }
    const mine = ctx.spawn("card small down");
    ctx.put(mine, deck);
    const mineTarget = { x: mineSpot.x + round * (mine.offsetWidth + 4), y: mineSpot.y };
    onCard();
    ctx.fly(mine, deck, mineTarget, 300).then(() => {
      if (!ctx.alive()) return;
      mine.className = `card small ${mySuits[round]}`;
      mine.textContent = SUIT_SYMBOLS[mySuits[round]];
    });
    ctx.put(mine, mineTarget);
    sprites.push({ el: mine, suit: mySuits[round] });
    await ctx.wait(80);
  }
  await ctx.wait(320);
  // Your faces are set here too, so a run that ends before the last flight's
  // callback (slide 1 reparents its sprites) still shows them face up.
  return sprites.map((s) => {
    if (s.el) {
      s.el.className = `card small ${s.suit}`;
      s.el.textContent = SUIT_SYMBOLS[s.suit];
      return s.el;
    }
    return s;
  });
}

// Turn the top card of the deck over onto the reference slot, covering the
// card already there, then let the slot's own card take over. With
// `compare`, the callback runs as the card lands (the match/miss flash) and
// the new suit holds on the slot long enough to read.
async function turnReference(ctx, m, suit, ms = 600, compare = null) {
  const deck = ctx.centre(m.deck);
  const slot = ctx.centre(m.refSlot);
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  await ctx.turn(top, deck, slot, ms, () => {
    top.className = `card big ${suit}`;
    top.textContent = SUIT_SYMBOLS[suit];
  });
  if (compare) {
    compare();
    await ctx.wait(COMPARE_MS);
  }
  m.refSlot.replaceChildren(cardEl(suit, "big"));
  top.remove();
}

async function chips(ctx, m, from, to, count = 5) {
  const a = ctx.centre(m.avatar(from));
  const b = ctx.centre(m.avatar(to));
  for (let i = 0; i < count; i++) {
    const chip = ctx.spawn("chip-sprite");
    ctx.fly(chip, a, b, 450, { arc: 30, spin: 180 }).then(() => ctx.alive() && chip.remove());
    await ctx.wait(70);
  }
  await ctx.wait(450);
}

async function showTag(ctx, m, i, value, gold) {
  const tag = m.tag(i);
  tag.hidden = false;
  tag.textContent = String(value);
  m.seatEls[i].classList.toggle("buyer", gold);
  await ctx.animate(tag, [{ transform: "scale(0.3)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "ease-out" });
}

// One stack of owned cards per suit, the same shape the live table builds.
function stakeStack(suit, count) {
  const stack = document.createElement("div");
  stack.className = "stake-stack";
  stack.dataset.suit = suit;
  stack.dataset.count = String(count);
  const edges = Math.min(4, count);
  for (let i = 0; i < edges; i++) {
    const card = document.createElement("div");
    card.className = `stake-card ${suit}`;
    card.style.left = `calc(var(--stake-w) * ${(i * 0.7).toFixed(2)})`;
    card.textContent = i === edges - 1 ? SUIT_SYMBOLS[suit] : "";
    stack.append(card);
  }
  stack.style.width = `calc(var(--stake-w) * ${(1 + (edges - 1) * 0.7).toFixed(2)})`;
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "stake-count";
    badge.textContent = String(count);
    stack.append(badge);
  }
  return stack;
}

// A bought suit lands on a seat's stake row, the way the live table shows it.
async function landStake(ctx, m, i, suit) {
  const stack = stakeStack(suit, 1);
  m.stakes(i).replaceChildren(stack);
  await ctx.animate(stack, [{ transform: "scale(0.3)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.7 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "ease-out" });
}

// The same local feedback the live table gives: the paying stacks pulse.
function flashPay(ctx, m) {
  for (const seat of m.seatEls) {
    const stack = seat.querySelector(".stake-stack");
    if (!stack) continue;
    ctx.animate(stack, [
      { transform: "scale(1)" },
      { transform: "scale(1.18)", offset: 0.4 },
      { transform: "scale(1)" }
    ], { duration: 600, easing: "ease-out" }).catch(() => {});
  }
}

// One later heart: the card turns over and 10 flies from each seller to the
// owner (seat 0). `quick` skips the comparison beat for replays.
async function heartPays(ctx, m, quick) {
  if (quick) {
    await turnReference(ctx, m, "hearts", 350);
    flashPay(ctx, m);
  } else {
    await turnReference(ctx, m, "hearts", 550, () => flashPay(ctx, m));
  }
  await Promise.all([chips(ctx, m, 1, 0, quick ? 3 : 5), chips(ctx, m, 2, 0, quick ? 3 : 5)]);
}

const SLIDES = [
  {
    caption: "Each round you bid for the suit on top. Own it, and every later flip of that suit pays you 10 from each player who sold it to you. Most chips when the deck runs out wins.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await ctx.wait(400);
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      await heartPays(ctx, m, false);
      await ctx.wait(300);
      await heartPays(ctx, m, true);
      await ctx.wait(1200);
    }
  },
  {
    caption: "Everyone is dealt a hand, every card equally likely to be any of the four suits. You see only your own.",
    async run(ctx, m) {
      // dealTo's cards live in the anim run's sprite group, which is torn
      // down (and removed from the DOM) as soon as this timeline settles —
      // success or not. Slides 3 and 5 already replace their sprites with
      // persistent nodes before they finish; this slide has no such
      // replacement step, so the dealt hand moves to the keep layer (above
      // the seats) instead of vanishing for the rest of the slide's hold.
      m.deckCount.textContent = "";
      const sprites = await dealTo(ctx, m, 2, ["spades", "hearts"]);
      m.keep.append(...sprites);
      await ctx.wait(1200);
    }
  },
  {
    caption: "Those hands are shuffled together into the deck. Nothing else goes in, so what you hold is a big slice of what is still to come.",
    async run(ctx, m) {
      m.deckCount.textContent = "";
      const sprites = await dealTo(ctx, m, 2, ["spades", "hearts"]);
      const deck = ctx.centre(m.deck);
      m.deck.classList.add("empty");
      await ctx.wait(600);
      let inDeck = 0;
      for (const card of sprites.reverse()) {
        card.className = "card small down";
        card.textContent = "";
        ctx.fly(card, ctx.centre(card), deck, 300, { spin: 180 }).then(() => {
          if (!ctx.alive()) return;
          card.remove();
          inDeck += 1;
          m.deck.classList.remove("empty");
          m.deckCount.textContent = String(inDeck);
        });
        await ctx.wait(40);
      }
      await ctx.wait(350);
      m.deck.classList.remove("empty");
      m.deckCount.textContent = String(sprites.length);
      const left = ctx.spawn("card small down");
      const right = ctx.spawn("card small down");
      ctx.put(left, deck);
      ctx.put(right, deck);
      const base = left.style.transform;
      for (let i = 0; i < 2; i++) {
        ctx.animate(left, [{ transform: base }, { transform: `${base} translateX(-26px) rotate(-10deg)`, offset: 0.5 }, { transform: base }], { duration: 400, easing: "ease-in-out" }).catch(() => {});
        await ctx.animate(right, [{ transform: base }, { transform: `${base} translateX(26px) rotate(10deg)`, offset: 0.5 }, { transform: base }], { duration: 400, easing: "ease-in-out" });
      }
      left.remove();
      right.remove();
      await turnReference(ctx, m, "spades");
      m.deckCount.textContent = String(sprites.length - 1);
      await ctx.wait(1000);
    }
  },
  {
    caption: "Everyone bids 0 to 100 in secret. The highest bid wins the suit and pays each other player the price that player bid. If two tie at the top, both buy.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await ctx.wait(300);
      await showTag(ctx, m, 2, 20, false);
      await ctx.wait(250);
      await showTag(ctx, m, 1, 50, false);
      await ctx.wait(250);
      await showTag(ctx, m, 0, 80, true);
      m.price.hidden = false;
      m.price.textContent = `${SUIT_SYMBOLS.hearts} 80`;
      await ctx.animate(m.price, [{ transform: "translateX(-50%) scale(0.3)", opacity: 0 }, { transform: "translateX(-50%) scale(1)", opacity: 1 }], { duration: 220 });
      await ctx.wait(1200);
    }
  },
  {
    caption: "You pay each player their own bid. Every later heart then pays you 10 from each of them — so the more hearts still to come, the more the suit is worth.",
    async run(ctx, m) {
      const n = 2;
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      for (const [i, v] of [[0, 80], [1, 50], [2, 20]]) {
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(v);
      }
      m.seatEls[0].classList.add("buyer");
      m.price.hidden = false;
      m.price.textContent = `${SUIT_SYMBOLS.hearts} 80`;
      let scores = [0, 0, 0];
      const paint = () => scores.forEach((v, i) => m.score(i, v));
      paint();
      await ctx.wait(400);
      await Promise.all([chips(ctx, m, 0, 1), chips(ctx, m, 0, 2)]);
      scores = [-70, 50, 20];
      paint();
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      for (let i = 0; i < n; i++) {
        await heartPays(ctx, m, i > 0);
        scores = [scores[0] + 20, scores[1] - 10, scores[2] - 10];
        paint();
        await ctx.wait(i > 0 ? 150 : 400);
      }
      // End on the same net-delta badges live play shows.
      const badges = scores.map((d, i) => {
        const badge = document.createElement("div");
        badge.className = "delta-badge " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        badge.textContent = fmt(d);
        m.seatEls[i].append(badge);
        ctx.animate(badge, [{ transform: "translate(-50%, -50%) scale(0.6)", opacity: 0 }, { transform: "translate(-50%, -50%) scale(1)", opacity: 1 }], { duration: 150, easing: "ease-out" }).catch(() => {});
        return badge;
      });
      try {
        await ctx.wait(1600);
      } finally {
        for (const b of badges) b.remove();
      }
    }
  },
  {
    caption: "The last five cards are the bonus round: no auction, and every payout doubles. Suits you already own keep paying — twice as much.",
    async run(ctx, m) {
      m.table.classList.add("bonus");
      m.refSlot.replaceChildren(cardEl("hearts", "big"));
      await ctx.wait(300);
      await landStake(ctx, m, 0, "hearts");
      await ctx.wait(400);
      await heartPays(ctx, m, false);
      await ctx.wait(1400);
    }
  }
];

export function createTutorial(dialog, { audio }) {
  dialog.innerHTML = `
    <div class="tut">
      <button type="button" class="icon-btn tut-close" aria-label="Close">×</button>
      <div class="tut-stage"></div>
      <p class="tut-caption" aria-live="polite"></p>
      <div class="tut-nav">
        <button type="button" class="chip-btn tut-back">Back</button>
        <div class="tut-dots"></div>
        <button type="button" class="chip-btn primary tut-next">Next</button>
      </div>
    </div>`;
  const stage = dialog.querySelector(".tut-stage");
  const caption = dialog.querySelector(".tut-caption");
  const dots = dialog.querySelector(".tut-dots");
  const back = dialog.querySelector(".tut-back");
  const next = dialog.querySelector(".tut-next");
  let index = 0;
  let opener = null;
  let anim = null;

  for (let i = 0; i < SLIDES.length; i++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "tut-dot";
    dot.setAttribute("aria-label", `Step ${i + 1}`);
    dot.addEventListener("click", () => show(i));
    dots.append(dot);
  }

  function show(i) {
    index = Math.max(0, Math.min(SLIDES.length - 1, i));
    const slide = SLIDES[index];
    if (anim) anim.cancelAll();
    stage.replaceChildren();
    caption.textContent = slide.caption;
    back.disabled = index === 0;
    next.textContent = index === SLIDES.length - 1 ? "Done" : "Next";
    [...dots.children].forEach((d, k) => d.setAttribute("aria-current", String(k === index)));
    const m = miniTable();
    stage.append(m.table);
    anim = createAnim(m.sprites);
    anim.run((ctx) => slide.run(ctx, m)).catch((err) => {
      console.error("[tutorial] slide failed:", err);
    });
  }

  function open(openerEl) {
    opener = openerEl || null;
    audio.unlock();
    if (!dialog.open) dialog.showModal();
    show(0);
    dialog.querySelector(".tut-next").focus();
  }
  function close() {
    if (anim) anim.cancelAll();
    if (dialog.open) dialog.close();
    if (opener && typeof opener.focus === "function") opener.focus();
  }

  back.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => (index === SLIDES.length - 1 ? close() : show(index + 1)));
  dialog.querySelector(".tut-close").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") show(index + 1);
    if (event.key === "ArrowLeft") show(index - 1);
  });
  let touchX = null;
  dialog.addEventListener("pointerdown", (event) => {
    touchX = event.pointerType === "touch" ? event.clientX : null;
  });
  dialog.addEventListener("pointerup", (event) => {
    if (touchX === null) return;
    const dx = event.clientX - touchX;
    touchX = null;
    if (dx < -40) show(index + 1);
    else if (dx > 40) show(index - 1);
  });

  window.openTutorial = open;
  return { open, close };
}
