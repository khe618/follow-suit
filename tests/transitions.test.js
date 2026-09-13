const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, displayScores, payoutBaseline, paymentStreams, transitionKey, DEAL_TIMELINE_MS } = require("../public/transitions.js");

const players = [{ id: "a", score: 0 }, { id: "b", score: 0 }, { id: "c", score: 0 }];
function snap(over) {
  return { matchId: 1, phase: "bidding", revealStep: null, auctionIndex: 1, remainingMs: 20000, players, history: [], ...over };
}
const kinds = (seq, meta = {}) => {
  let prev = null;
  return seq.map((s) => {
    const p = plan(prev, s, meta);
    prev = s;
    return p.kind;
  });
};

test("keys and duplicate snapshots", () => {
  assert.equal(transitionKey(snap({ phase: "reveal", revealStep: "card", auctionIndex: 3 })), "1:reveal:card:3");
  assert.equal(transitionKey(snap({ phase: "dealing", auctionIndex: null })), "1:dealing::0");
  const dealing = snap({ phase: "dealing", auctionIndex: null, remainingMs: 9500 });
  assert.deepEqual(kinds([dealing, dealing]), ["deal", "update"]);
  const bids = snap({ phase: "reveal", revealStep: "bids" });
  assert.deepEqual(kinds([snap(), bids, bids]), ["bidding", "revealBids", "update"]);
});

test("hydration draws the final frame whatever the phase", () => {
  const card = snap({ phase: "reveal", revealStep: "card" });
  assert.equal(plan(null, card, { hydrate: true }).kind, "hydrate");
  assert.equal(plan(snap(), card, { hydrate: true }).kind, "hydrate");
  assert.equal(plan(null, snap({ phase: "dealing", auctionIndex: null, remainingMs: 9500 }), { hydrate: true }).kind, "hydrate");
});

test("a first snapshot without hydrate is a real transition (quick play lands in dealing)", () => {
  assert.equal(plan(null, snap({ phase: "dealing", auctionIndex: null, remainingMs: 9500 }), { hydrate: false }).kind, "deal");
  assert.equal(plan(null, snap({ phase: "lobby", matchId: 0, auctionIndex: null }), { hydrate: false }).kind, "lobby");
});

test("a lobby roster change is a transition, not an update", () => {
  const a = snap({ phase: "lobby", matchId: 0, auctionIndex: null, players: [{ id: "a", score: 0 }] });
  const b = snap({ phase: "lobby", matchId: 0, auctionIndex: null, players: [{ id: "a", score: 0 }, { id: "b", score: 0 }] });
  assert.deepEqual(kinds([a, a, b]), ["lobby", "update", "lobby"]);
});

test("dealing without enough time left is drawn, not animated", () => {
  assert.equal(plan(snap({ phase: "lobby" }), snap({ phase: "dealing", auctionIndex: null, remainingMs: DEAL_TIMELINE_MS }), {}).kind, "deal");
  assert.equal(plan(snap({ phase: "lobby" }), snap({ phase: "dealing", auctionIndex: null, remainingMs: DEAL_TIMELINE_MS - 1 }), {}).kind, "hydrate");
});

test("every phase transition maps to its kind, including skipped steps and a new match", () => {
  const seq = [
    snap({ phase: "lobby", matchId: 0, auctionIndex: null }),
    snap({ phase: "dealing", auctionIndex: null, remainingMs: 9500 }),
    snap(),
    snap({ phase: "reveal", revealStep: "card" }),
    snap({ auctionIndex: 2 }),
    snap({ phase: "results", auctionIndex: null }),
    snap({ phase: "lobby", auctionIndex: null }),
    snap({ phase: "dealing", matchId: 2, auctionIndex: null, remainingMs: 9500 })
  ];
  assert.deepEqual(kinds(seq), ["lobby", "deal", "bidding", "revealCard", "bidding", "results", "lobby", "deal"]);
});

const entry = (over) => ({ index: 1, reference: "spades", bids: { a: 80, b: 50, c: 20 }, buyers: ["a"], price: 80, void: false, flipped: null, matched: null, deltas: null, ...over });

test("displayScores applies the purchase leg only during reveal/bids", () => {
  const raw = { a: 10, b: 20, c: 30 };
  const ps = players.map((p) => ({ ...p, score: raw[p.id] }));
  assert.deepEqual(displayScores(snap({ players: ps, phase: "bidding" })), raw);
  const bids = snap({ players: ps, phase: "reveal", revealStep: "bids", history: [entry()] });
  assert.deepEqual(displayScores(bids), { a: 10 - 160, b: 20 + 80, c: 30 + 80 });
  const tie = snap({
    players: [{ id: "a", score: 0 }, { id: "b", score: 0 }, { id: "c", score: 0 }, { id: "d", score: 0 }],
    phase: "reveal", revealStep: "bids",
    history: [entry({ bids: { a: 60, b: 60, c: 30, d: 10 }, buyers: ["a", "b"], price: 60 })]
  });
  assert.deepEqual(displayScores(tie), { a: -120, b: -120, c: 120, d: 120 });
  const voided = snap({ players: ps, phase: "reveal", revealStep: "bids", history: [entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], price: 0, void: true })] });
  assert.deepEqual(displayScores(voided), raw);
  // After the card step the server has applied the net delta: purchase + payout.
  const after = snap({ players: ps.map((p) => ({ ...p, score: raw[p.id] + { a: 40, b: -20, c: -20 }[p.id] })), phase: "reveal", revealStep: "card", history: [entry({ flipped: "spades", matched: true, deltas: { a: 40, b: -20, c: -20 } })] });
  assert.deepEqual(displayScores(after), { a: 50, b: 0, c: 10 });
});

test("paymentStreams: purchase leg at bids, payout leg at card, nothing for void or zero", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(paymentStreams(entry(), ids, "bids"), [{ from: "a", to: "b", amount: 80 }, { from: "a", to: "c", amount: 80 }]);
  assert.deepEqual(paymentStreams(entry({ flipped: "spades", matched: true }), ids, "card"), [{ from: "b", to: "a", amount: 100 }, { from: "c", to: "a", amount: 100 }]);
  assert.deepEqual(paymentStreams(entry({ flipped: "hearts", matched: false }), ids, "card"), []);
  assert.deepEqual(paymentStreams(entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], price: 0, void: true }), ids, "bids"), []);
  assert.deepEqual(paymentStreams(entry({ bids: { a: 5, b: 0, c: 0 }, buyers: ["a"], price: 0 }), ids, "bids"), [], "price 0 sends no chips");
  const tie = entry({ bids: { a: 60, b: 60, c: 30 }, buyers: ["a", "b"], price: 60 });
  assert.deepEqual(paymentStreams(tie, ids, "bids"), [{ from: "a", to: "c", amount: 60 }, { from: "b", to: "c", amount: 60 }]);
  assert.deepEqual(paymentStreams({ ...tie, matched: true }, ids, "card"), [{ from: "c", to: "a", amount: 100 }, { from: "c", to: "b", amount: 100 }]);
});

test("payoutBaseline recovers the post-purchase scores from a card snapshot alone", () => {
  // Raw scores before the auction were 10/20/30; the server has applied +40/-20/-20.
  const ps = [{ id: "a", score: 50 }, { id: "b", score: 0 }, { id: "c", score: 10 }];
  const card = snap({ players: ps, phase: "reveal", revealStep: "card", history: [entry({ flipped: "spades", matched: true, deltas: { a: 40, b: -20, c: -20 } })] });
  assert.deepEqual(payoutBaseline(card), { a: 10 - 160, b: 20 + 80, c: 30 + 80 });
  // Adding the payout leg lands exactly on the server scores.
  const streams = paymentStreams(card.history[0], ["a", "b", "c"], "card");
  const landed = payoutBaseline(card);
  for (const s of streams) {
    landed[s.from] -= s.amount;
    landed[s.to] += s.amount;
  }
  assert.deepEqual(landed, { a: 50, b: 0, c: 10 });
  // A miss: no payout leg, so the baseline already equals the server scores.
  const miss = snap({ players: [{ id: "a", score: -150 }, { id: "b", score: 100 }, { id: "c", score: 110 }], phase: "reveal", revealStep: "card", history: [entry({ flipped: "hearts", matched: false, deltas: { a: -160, b: 80, c: 80 } })] });
  assert.deepEqual(payoutBaseline(miss), { a: -150, b: 100, c: 110 });
  // Void: nothing moved.
  const voided = snap({ players: ps, phase: "reveal", revealStep: "card", history: [entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], price: 0, void: true, flipped: "spades", matched: true, deltas: { a: 0, b: 0, c: 0 } })] });
  assert.deepEqual(payoutBaseline(voided), { a: 50, b: 0, c: 10 });
  // Outside reveal/card it is just displayScores.
  assert.deepEqual(payoutBaseline(snap({ players: ps })), { a: 50, b: 0, c: 10 });
});
