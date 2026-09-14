import { cardEl } from "./table.js";
import { createAnim } from "./anim.js";
import { holdSpot, setAside, COMPARE_MS } from "./timelines.js";

const { settlePurchase, settleFlip, SUIT_SYMBOLS, SUITS, POOL_PER_SUIT, CARD_PAYOUT, RUNOUT_MULTIPLIER } = window.GameCore;
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
// avatars, yours face up in a row beside yours. `onCard` fires per card
// dealt (slide 1 counts the pool down with it).
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
export function stakeStack(suit, count) {
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

const POOL = SUITS.length * POOL_PER_SUIT;
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
    caption: `Everyone is dealt a hand from a ${POOL}-card deck, ${POOL_PER_SUIT} of each suit. You see only your own.`,
    async run(ctx, m) {
      // dealTo's cards live in the anim run's sprite group, which is torn
      // down (and removed from the DOM) as soon as this timeline settles —
      // success or not. Slides 3 and 5 already replace their sprites with
      // persistent nodes before they finish; this slide has no such
      // replacement step, so the dealt hand moves to the keep layer (above
      // the seats) instead of vanishing for the rest of the slide's hold.
      let left = POOL;
      m.deckCount.textContent = String(left);
      const sprites = await dealTo(ctx, m, 2, ["spades", "hearts"], () => {
        left -= 1;
        m.deckCount.textContent = String(left);
      });
      m.keep.append(...sprites);
      await ctx.wait(1200);
    }
  },
  {
    caption: "The hands are shuffled together into a new deck. The cards nobody was dealt are set aside.",
    async run(ctx, m) {
      let inPool = POOL;
      m.deckCount.textContent = String(inPool);
      const sprites = await dealTo(ctx, m, 2, ["spades", "hearts"], () => {
        inPool -= 1;
        m.deckCount.textContent = String(inPool);
      });
      const deck = ctx.centre(m.deck);
      await ctx.wait(400);
      await setAside(ctx, m.deck, m.deckCount, m.table, inPool);
      await ctx.wait(200);
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
    caption: "You pay each player their own bid. Every later heart then pays you 10 from each of them. The dock stacks a chip for every 10 you bid.",
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
        ctx.animate(badge, [{ transform: "translate(-50%, 0) scale(0.6)", opacity: 0 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1 }], { duration: 150, easing: "ease-out" }).catch(() => {});
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
    caption: "Drag a bid and watch who wins the suit — and who wins the money.",
    instruction: "Drag any bid.",
    calculator: { sliders: true }
  },
  {
    caption: "The more hearts still to come, the more the suit is worth. Bid above that and you have overpaid.",
    instruction: "Set how many hearts are still to come.",
    calculator: { stepper: true }
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

  // Last slide: the mini table stays on screen and reflects the sliders live
  // (buyer glow, bid tags, winning-bid badge, stake chip, scores), with the
  // calculator below. Net = purchase + N later hearts, N from the stepper.
  function renderCalculator(m, opts) {
    const wrap = document.createElement("div");
    wrap.className = "calc";
    m.refSlot.replaceChildren(cardEl("hearts", "big"));
    const showSliders = Boolean(opts.sliders);
    const rows = NAMES.map((name, i) => {
      const row = document.createElement("div");
      row.className = "calc-row";
      const bid = [80, 50, 20][i];
      row.innerHTML = showSliders
        ? `<span class="calc-name">${name}</span><input type="range" min="0" max="100" value="${bid}" aria-label="${name} bid"><span class="calc-bid mono"></span><span class="calc-delta mono"></span>`
        : `<span class="calc-name">${name}</span><span class="calc-fixed mono">bid ${bid}</span><span class="calc-bid mono"></span><span class="calc-delta mono"></span>`;
      row.dataset.bid = String(bid);
      wrap.append(row);
      return row;
    });
    const stepper = document.createElement("label");
    stepper.className = "tut-stepper";
    stepper.innerHTML = `hearts still to come <button type="button" class="step-btn" data-step="-1" aria-label="One fewer heart">−</button><output>4</output><button type="button" class="step-btn" data-step="1" aria-label="One more heart">+</button>`;
    const note = document.createElement("p");
    note.className = "calc-note mono";
    note.setAttribute("aria-live", "polite");
    if (opts.stepper) wrap.append(stepper);
    wrap.append(note);
    let later = 4;
    const update = () => {
      const bids = {};
      rows.forEach((row, i) => {
        const input = row.querySelector("input");
        bids[NAMES[i]] = Number(input ? input.value : row.dataset.bid);
        row.querySelector(".calc-bid").textContent = String(bids[NAMES[i]]);
      });
      const r = settlePurchase(bids);
      const stakes = r.void ? [] : [{ auction: 1, suit: "hearts", buyers: r.buyers, sellers: r.sellers }];
      const flip = settleFlip(stakes, "hearts", NAMES);
      rows.forEach((row, i) => {
        const name = NAMES[i];
        const d = r.deltas[name] + later * flip.deltas[name];
        const cell = row.querySelector(".calc-delta");
        cell.textContent = fmt(d);
        cell.className = "calc-delta mono " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        const buyer = r.buyers.includes(name);
        row.classList.toggle("buyer", buyer);
        m.seatEls[i].classList.toggle("buyer", buyer);
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(bids[name]);
        m.stakes(i).replaceChildren();
        if (buyer) m.stakes(i).append(stakeStack("hearts", 1));
        m.score(i, d);
      });
      m.price.hidden = false;
      m.price.textContent = r.void ? "no trade" : `${SUIT_SYMBOLS.hearts} ${r.topBid}`;
      m.price.classList.toggle("void", r.void);
      // A buyer pays every seller that seller's own bid, and then collects
      // CARD_PAYOUT from each of them per later heart. Break-even is the
      // cost divided by that per-card total - not by CARD_PAYOUT alone.
      const cost = r.sellers.reduce((sum, name) => sum + bids[name], 0);
      const perCard = CARD_PAYOUT * r.sellers.length;
      if (r.void) {
        note.textContent = "Everyone bid the same, so there is no trade.";
      } else if (showSliders) {
        const breakEven = perCard > 0 ? Math.ceil(cost / perCard) : 0;
        // "You" takes the second person however many buyers there are.
        const verb = r.buyers.length > 1 || r.buyers.includes("You") ? "buy" : "buys";
        note.textContent = `${r.buyers.join(" & ")} ${verb} hearts for ${cost}. `
          + `Each later heart pays ${perCard}, so ${breakEven} heart${breakEven === 1 ? "" : "s"} break${breakEven === 1 ? "s" : ""} even.`;
      } else {
        const worth = later * perCard;
        note.textContent = `${later} heart${later === 1 ? "" : "s"} to come × ${perCard} = the suit is worth ${worth} to ${r.buyers.join(" & ")}, who paid ${cost}.`;
      }
    };
    for (const row of rows) {
      const input = row.querySelector("input");
      if (input) input.addEventListener("input", update);
    }
    const out = stepper.querySelector("output");
    for (const btn of stepper.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        later = Math.max(0, Math.min(9, later + Number(btn.dataset.step)));
        out.value = String(later);
        update();
      });
    }
    update();
    return wrap;
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
    if (slide.calculator) {
      if (slide.instruction) {
        const tip = document.createElement("p");
        tip.className = "tut-instruction";
        tip.textContent = slide.instruction;
        stage.append(tip);
      }
      stage.append(renderCalculator(m, slide.calculator));
      return;
    }
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
    if (event.target.tagName === "INPUT") return;
    if (event.key === "ArrowRight") show(index + 1);
    if (event.key === "ArrowLeft") show(index - 1);
  });
  let touchX = null;
  dialog.addEventListener("pointerdown", (event) => {
    touchX = event.pointerType === "touch" ? event.clientX : null;
  });
  dialog.addEventListener("pointerup", (event) => {
    if (touchX === null || event.target.tagName === "INPUT") return;
    const dx = event.clientX - touchX;
    touchX = null;
    if (dx < -40) show(index + 1);
    else if (dx > 40) show(index - 1);
  });

  window.openTutorial = open;
  return { open, close };
}
