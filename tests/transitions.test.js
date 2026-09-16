const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, legDeltas, legBaseline, paymentStreams, transitionKey, DEAL_TIMELINE_MS, CARD_TIMELINE_MS } = require("../public/transitions.js");
const { readConfig } = require("../lib/config.js");

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

test("consecutive runout steps are distinct transitions, keyed by auctionIndex", () => {
  const step16 = snap({ phase: "reveal", revealStep: "card", auctionIndex: 16 });
  const step17 = snap({ phase: "reveal", revealStep: "card", auctionIndex: 17 });
  assert.deepEqual(kinds([step16, step17]), ["revealCard", "revealCard"]);
  assert.deepEqual(kinds([step17, step17]), ["revealCard", "update"]);
});

const entry = (over) => ({
  index: 1, reference: "hearts", bids: { a: 80, b: 50, c: 20 }, buyers: ["a"], sellers: ["b", "c"], topBid: 80, void: false,
  purchase: { a: -70, b: 50, c: 20 }, flipped: null, hits: null, payouts: null, deltas: null, ...over
});
const withScores = (scores) => players.map((p) => ({ ...p, score: scores[p.id] }));

test("legDeltas splits a round into its two legs and never nets them", () => {
  // Auction leg only: the flip has not settled, so the card leg is null -
  // which the UI must not render as a zero.
  assert.deepEqual(legDeltas(entry(), "a"), { purchase: -70, payout: null });
  assert.deepEqual(legDeltas(entry(), "b"), { purchase: 50, payout: null });

  // Settled, with legs that settleFlip could really produce: b pays a 30, so
  // a's card leg is +30 and b's is -30. a bought at -70 and the card paid 30
  // back, for a round of -40; both legs and the round stay zero-sum.
  const settled = entry({ flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 30 }], deltas: { a: -40, b: 20, c: 20 } });
  assert.deepEqual(legDeltas(settled, "a"), { purchase: -70, payout: 30 });
  assert.deepEqual(legDeltas(settled, "b"), { purchase: 50, payout: -30 });
  assert.deepEqual(legDeltas(settled, "c"), { purchase: 20, payout: 0 });
  // The card legs mirror the payout streams they came from.
  assert.equal(["a", "b", "c"].reduce((sum, id) => sum + legDeltas(settled, id).payout, 0), 0);
  // The two legs still add back up to the round the server settled.
  for (const id of ["a", "b", "c"]) {
    const { purchase, payout } = legDeltas(settled, id);
    assert.equal(purchase + payout, settled.deltas[id], id);
  }

  // A runout round has no auction: the card leg carries the whole round.
  const runout = entry({ runout: true, purchase: { a: 0, b: 0, c: 0 }, flipped: "hearts", deltas: { a: 40, b: -20, c: -20 } });
  assert.deepEqual(legDeltas(runout, "a"), { purchase: 0, payout: 40 });

  assert.deepEqual(legDeltas(null, "a"), { purchase: null, payout: null });
  assert.deepEqual(legDeltas(settled, "nobody"), { purchase: 0, payout: 0 });
});

test("legBaseline undoes the purchase at bids, the payout at card, nothing elsewhere", () => {
  const raw = { a: 10, b: 20, c: 30 };
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "bidding" })), raw);
  // Server scores after the purchase: 10-70, 20+50, 30+20.
  const bids = snap({ players: withScores({ a: -60, b: 70, c: 50 }), phase: "reveal", revealStep: "bids", history: [entry()] });
  assert.deepEqual(legBaseline(bids), raw);
  // Card step after a heart: payout +20/-10/-10 on top of the purchase.
  const card = snap({
    players: withScores({ a: -40, b: 60, c: 40 }), phase: "reveal", revealStep: "card",
    history: [entry({ flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }], deltas: { a: -50, b: 40, c: 10 } })]
  });
  assert.deepEqual(legBaseline(card), { a: -60, b: 70, c: 50 });
  // Adding the payout streams lands exactly on the server scores.
  const landed = legBaseline(card);
  for (const s of paymentStreams(card.history[0], "card")) {
    landed[s.from] -= s.amount;
    landed[s.to] += s.amount;
  }
  assert.deepEqual(landed, { a: -40, b: 60, c: 40 });
  // Void at bids: identity. Void at card with an older stake paying: undone.
  const voidEntry = entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], sellers: [], topBid: 0, void: true, purchase: { a: 0, b: 0, c: 0 } });
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "reveal", revealStep: "bids", history: [voidEntry] })), raw);
  const voidCard = snap({
    players: withScores({ a: 30, b: 10, c: 20 }), phase: "reveal", revealStep: "card",
    history: [{ ...voidEntry, flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }], deltas: { a: 20, b: -10, c: -10 } }]
  });
  assert.deepEqual(legBaseline(voidCard), raw);
  // Results and lobby: identity, even with history present.
  assert.deepEqual(legBaseline(snap({ players: withScores(raw), phase: "results", history: [entry()] })), raw);
});

test("paymentStreams: sellers' bids at the purchase, netted payouts at the card", () => {
  assert.deepEqual(paymentStreams(entry(), "bids"), [{ from: "a", to: "b", amount: 50 }, { from: "a", to: "c", amount: 20 }]);
  const tie = entry({ bids: { a: 60, b: 60, c: 30, d: 10 }, buyers: ["a", "b"], sellers: ["c", "d"], topBid: 60, purchase: { a: -40, b: -40, c: 60, d: 20 } });
  assert.deepEqual(paymentStreams(tie, "bids"), [
    { from: "a", to: "c", amount: 30 }, { from: "a", to: "d", amount: 10 },
    { from: "b", to: "c", amount: 30 }, { from: "b", to: "d", amount: 10 }
  ]);
  assert.deepEqual(paymentStreams(entry({ bids: { a: 5, b: 0, c: 0 }, topBid: 5, purchase: { a: 0, b: 0, c: 0 } }), "bids"), [], "zero bids send no chips");
  assert.deepEqual(paymentStreams(entry({ bids: { a: 0, b: 0, c: 0 }, buyers: [], sellers: [], topBid: 0, void: true }), "bids"), []);
  const payouts = [{ from: "b", to: "a", amount: 10 }, { from: "c", to: "a", amount: 10 }];
  const card = entry({ flipped: "hearts", hits: 1, payouts, deltas: { a: -50, b: 40, c: 10 } });
  assert.deepEqual(paymentStreams(card, "card"), payouts);
  assert.notEqual(paymentStreams(card, "card")[0], payouts[0], "streams are copies");
  assert.deepEqual(paymentStreams(entry({ flipped: "clubs", hits: 0, payouts: [], deltas: { a: -70, b: 50, c: 20 } }), "card"), []);
  assert.deepEqual(paymentStreams(entry(), "card"), [], "before the flip there are no payouts");
  const voidCard = entry({
    bids: { a: 0, b: 0, c: 0 }, buyers: [], sellers: [], topBid: 0, void: true, purchase: { a: 0, b: 0, c: 0 },
    flipped: "hearts", hits: 1, payouts: [{ from: "b", to: "a", amount: 10 }], deltas: { a: 10, b: -10, c: 0 }
  });
  assert.deepEqual(paymentStreams(voidCard, "card"), [{ from: "b", to: "a", amount: 10 }], "a void auction still pays an older stake at the card step");
});

test("the reveal-card timeline fits inside the configured step", () => {
  assert.ok(CARD_TIMELINE_MS <= readConfig({}).game.revealCardMs, `${CARD_TIMELINE_MS} > revealCardMs`);
});

test("the bonus round gets its own bidding kind, exactly once", () => {
  // cardsRemaining === RUNOUT_CARDS is the final auction: from here every
  // card left pays double.
  const bonus = snap({ auctionIndex: 16, cardsRemaining: 5 });
  assert.equal(plan(null, bonus).kind, "bonusBidding");
  // The same snapshot twice is an idempotent update, never a replay.
  assert.deepEqual(kinds([bonus, bonus]), ["bonusBidding", "update"]);
  // A reconnect mid-bonus-round draws the final frame, no cinematic.
  assert.equal(plan(null, bonus, { hydrate: true }).kind, "hydrate");
});

test("ordinary auctions are unaffected by the bonus kind", () => {
  assert.equal(plan(null, snap({ cardsRemaining: 12 })).kind, "bidding");
  assert.equal(plan(null, snap({ cardsRemaining: 6 })).kind, "bidding");
  // Only bidding; the runout's own flips are reveal steps.
  assert.equal(plan(null, snap({ phase: "reveal", revealStep: "card", cardsRemaining: 5 })).kind, "revealCard");
});
