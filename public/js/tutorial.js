import { cardEl } from "./table.js";
import { createAnim } from "./anim.js";
import { holdSpot, setAside, besideSpot, COMPARE_MS, SLIDE_MS } from "./timelines.js";

const { settle, SUIT_SYMBOLS, SUITS, POOL_PER_SUIT } = window.GameCore;
const { seatPositions } = window.SeatLayout;
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
    seat.innerHTML = `<div class="bid-tag" hidden></div><div class="avatar" style="--seat-color: var(--seat-${i + 1})">${name[0]}</div><div class="seat-stack"></div><div class="seat-name">${name}</div><div class="seat-score"><span class="score-num">0</span></div>`;
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
  const flash = document.createElement("div");
  flash.className = "rail-flash";
  table.append(seats, centre, keep, sprites, flash);
  return {
    table, seatEls, sprites, keep, flash,
    deck: centre.querySelector(".deck"),
    deckCount: centre.querySelector(".deck-count"),
    refSlot: centre.querySelector(".ref-slot"),
    price: centre.querySelector(".price-badge"),
    tag: (i) => seatEls[i].querySelector(".bid-tag"),
    avatar: (i) => seatEls[i].querySelector(".avatar"),
    stack: (i) => seatEls[i].querySelector(".seat-stack"),
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

// Turn the top card of the deck over onto the reference slot, then let the
// slot's own card take over. With `compare`, the card lands beside the
// slot first (the callback runs there, for the match/miss flash), holds,
// then slides onto the slot.
async function turnReference(ctx, m, suit, ms = 600, compare = null) {
  const deck = ctx.centre(m.deck);
  const slot = ctx.centre(m.refSlot);
  const top = ctx.spawn("card big down");
  ctx.put(top, deck);
  const landing = compare ? besideSpot(slot) : slot;
  await ctx.turn(top, deck, landing, ms, () => {
    top.className = `card big ${suit}`;
    top.textContent = SUIT_SYMBOLS[suit];
  });
  if (compare) {
    compare();
    await ctx.wait(COMPARE_MS);
    await ctx.fly(top, landing, slot, SLIDE_MS);
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

const POOL = SUITS.length * POOL_PER_SUIT;
const SLIDES = [
  {
    caption: "Each round you bet on whether the next card matches the suit on top. Win the bet and every other player pays you 100. Most chips when the deck runs out wins.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("spades", "big"));
      await ctx.wait(500);
      await turnReference(ctx, m, "spades", 550, () => {
        m.flash.className = "rail-flash good";
        ctx.animate(m.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
      });
      await Promise.all([chips(ctx, m, 1, 0), chips(ctx, m, 2, 0)]);
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
    caption: "Everyone bids 0 to 100 in secret. The highest bid buys the bet from everyone else at that price.",
    async run(ctx, m) {
      m.refSlot.replaceChildren(cardEl("spades", "big"));
      await ctx.wait(300);
      await showTag(ctx, m, 2, 20, false);
      await ctx.wait(250);
      await showTag(ctx, m, 1, 50, false);
      await ctx.wait(250);
      await showTag(ctx, m, 0, 80, true);
      m.price.hidden = false;
      m.price.textContent = "80";
      await ctx.animate(m.price, [{ transform: "translateX(-50%) scale(0.3)", opacity: 0 }, { transform: "translateX(-50%) scale(1)", opacity: 1 }], { duration: 220 });
      await ctx.wait(1200);
    }
  },
  {
    caption: "Match: each other player pays the buyer 100. Miss: the buyer keeps nothing.",
    controls: true,
    async run(ctx, m, opts) {
      const matched = opts.matched;
      m.refSlot.replaceChildren(cardEl("spades", "big"));
      for (const [i, v] of [[0, 80], [1, 50], [2, 20]]) {
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(v);
      }
      m.seatEls[0].classList.add("buyer");
      m.price.hidden = false;
      m.price.textContent = "80";
      m.score(0, 0);
      m.score(1, 0);
      m.score(2, 0);
      await ctx.wait(400);
      await Promise.all([chips(ctx, m, 0, 1), chips(ctx, m, 0, 2)]);
      m.score(0, -160);
      m.score(1, 80);
      m.score(2, 80);
      await ctx.wait(500);
      const suit = matched ? "spades" : "hearts";
      await turnReference(ctx, m, suit, 550, () => {
        m.flash.className = `rail-flash ${matched ? "good" : "bad"}`;
        ctx.animate(m.flash, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 500 }).catch(() => {});
      });
      if (matched) {
        await Promise.all([chips(ctx, m, 1, 0), chips(ctx, m, 2, 0)]);
        m.score(0, 40);
        m.score(1, -20);
        m.score(2, -20);
      }
      // End on the same floating net-delta badges live play shows.
      const deltas = matched ? [40, -20, -20] : [-160, 80, 80];
      const badges = deltas.map((d, i) => {
        const badge = document.createElement("div");
        badge.className = "delta-badge " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        badge.textContent = fmt(d);
        m.seatEls[i].append(badge);
        ctx.animate(badge, [{ transform: "translate(-50%, 0)", opacity: 1 }, { transform: "translate(-50%, -30px)", opacity: 0 }], { duration: 1400, easing: "ease-out", fill: "forwards" }).catch(() => {});
        return badge;
      });
      try {
        await ctx.wait(1400);
      } finally {
        for (const b of badges) b.remove();
      }
    }
  },
  {
    caption: "Move the bids. Notice who wins the auction and who wins the money.",
    calculator: true
  }
];

export function createTutorial(dialog, { audio }) {
  dialog.innerHTML = `
    <div class="tut">
      <button type="button" class="icon-btn tut-close" aria-label="Close">×</button>
      <div class="tut-stage"></div>
      <div class="tut-controls" hidden>
        <button type="button" class="chip-btn small" data-outcome="match" aria-pressed="true">Match</button>
        <button type="button" class="chip-btn small" data-outcome="miss" aria-pressed="false">Miss</button>
      </div>
      <p class="tut-caption" aria-live="polite"></p>
      <div class="tut-nav">
        <button type="button" class="chip-btn tut-back">Back</button>
        <div class="tut-dots"></div>
        <button type="button" class="chip-btn primary tut-next">Next</button>
      </div>
    </div>`;
  const stage = dialog.querySelector(".tut-stage");
  const caption = dialog.querySelector(".tut-caption");
  const controls = dialog.querySelector(".tut-controls");
  const dots = dialog.querySelector(".tut-dots");
  const back = dialog.querySelector(".tut-back");
  const next = dialog.querySelector(".tut-next");
  let index = 0;
  let opener = null;
  let anim = null;
  let matched = true;

  for (let i = 0; i < SLIDES.length; i++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "tut-dot";
    dot.setAttribute("aria-label", `Step ${i + 1}`);
    dot.addEventListener("click", () => show(i));
    dots.append(dot);
  }

  // Last slide: the mini table stays on screen and reflects the sliders live
  // (buyer glow, bid tags, price badge, scores), with the calculator below.
  function renderCalculator(m) {
    const wrap = document.createElement("div");
    wrap.className = "calc";
    m.refSlot.replaceChildren(cardEl("spades", "big"));
    const rows = NAMES.map((name, i) => {
      const row = document.createElement("div");
      row.className = "calc-row";
      row.innerHTML = `<span class="calc-name">${name}</span><input type="range" min="0" max="100" value="${[80, 50, 20][i]}" aria-label="${name} bid"><span class="calc-bid mono"></span><span class="calc-delta mono"></span>`;
      wrap.append(row);
      return row;
    });
    const outcome = document.createElement("div");
    outcome.className = "tut-controls";
    outcome.innerHTML = `<button type="button" class="chip-btn small" data-outcome="match" aria-pressed="true">Match</button><button type="button" class="chip-btn small" data-outcome="miss" aria-pressed="false">Miss</button>`;
    const note = document.createElement("p");
    note.className = "calc-note mono";
    wrap.append(outcome, note);
    let calcMatched = true;
    const update = () => {
      const bids = {};
      rows.forEach((row, i) => {
        bids[NAMES[i]] = Number(row.querySelector("input").value);
        row.querySelector(".calc-bid").textContent = String(bids[NAMES[i]]);
      });
      const r = settle(bids, calcMatched);
      rows.forEach((row, i) => {
        const d = r.deltas[NAMES[i]];
        const cell = row.querySelector(".calc-delta");
        cell.textContent = fmt(d);
        cell.className = "calc-delta mono " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero");
        const buyer = r.buyers.includes(NAMES[i]);
        row.classList.toggle("buyer", buyer);
        m.seatEls[i].classList.toggle("buyer", buyer);
        const tag = m.tag(i);
        tag.hidden = false;
        tag.textContent = String(bids[NAMES[i]]);
        m.score(i, d);
      });
      m.price.hidden = false;
      m.price.textContent = r.void ? "no trade" : String(r.price);
      m.price.classList.toggle("void", r.void);
      note.textContent = r.void ? "no trade" : `${r.buyers.join(" & ")} ${r.buyers.length > 1 ? "buy" : "buys"} at ${r.price}`;
    };
    for (const row of rows) row.querySelector("input").addEventListener("input", update);
    for (const btn of outcome.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        calcMatched = btn.dataset.outcome === "match";
        for (const b of outcome.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
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
    controls.hidden = !slide.controls;
    back.disabled = index === 0;
    next.textContent = index === SLIDES.length - 1 ? "Done" : "Next";
    [...dots.children].forEach((d, k) => d.setAttribute("aria-current", String(k === index)));
    const m = miniTable();
    stage.append(m.table);
    if (slide.calculator) {
      stage.append(renderCalculator(m));
      return;
    }
    anim = createAnim(m.sprites);
    anim.run((ctx) => slide.run(ctx, m, { matched })).catch((err) => {
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
  for (const btn of controls.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      matched = btn.dataset.outcome === "match";
      for (const b of controls.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
      show(index);
    });
  }
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
