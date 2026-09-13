(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Transitions = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Worst-case length of the deal timeline in timelines.js (24 cards at 70 ms
  // plus the last flight, peek, gather, riffle, flip, and hand slide: about
  // 5.7 s), rounded up. A dealing snapshot with less time left than this is
  // drawn as its final frame instead. Keep in step with timelines.js.
  const DEAL_TIMELINE_MS = 6000;
  const PAYOUT = 100;

  function transitionKey(s) {
    return `${s.matchId}:${s.phase}:${s.revealStep || ""}:${s.auctionIndex || 0}`;
  }

  // The server broadcasts more snapshots than there are transitions (one
  // from onChange, one after each message handler), so snapshots are state,
  // not events: the same key twice is an idempotent update.
  function plan(prev, next, meta = {}) {
    const key = transitionKey(next);
    if (meta.hydrate) return { key, kind: "hydrate" };
    if (prev && transitionKey(prev) === key) return { key, kind: "update" };
    switch (next.phase) {
      case "dealing":
        return { key, kind: next.remainingMs >= DEAL_TIMELINE_MS ? "deal" : "hydrate" };
      case "bidding":
        return { key, kind: "bidding" };
      case "reveal":
        return { key, kind: next.revealStep === "card" ? "revealCard" : "revealBids" };
      case "results":
        return { key, kind: "results" };
      default:
        return { key, kind: "lobby" };
    }
  }

  function sellersOf(entry, ids) {
    return ids.filter((id) => !entry.buyers.includes(id));
  }

  // The server applies one net delta at the card step. Between the two legs
  // the client shows the score after the purchase leg.
  function displayScores(state) {
    const out = {};
    for (const p of state.players) out[p.id] = p.score;
    if (state.phase !== "reveal" || state.revealStep !== "bids") return out;
    const last = state.history[state.history.length - 1];
    if (!last || last.void || last.deltas) return out;
    const ids = state.players.map((p) => p.id);
    const sellers = sellersOf(last, ids);
    for (const id of last.buyers) out[id] -= last.price * sellers.length;
    for (const id of sellers) out[id] += last.price * last.buyers.length;
    return out;
  }

  // Scores at the start of the card step, derived from the card snapshot
  // itself: undo the net delta the server applied, then apply the purchase
  // leg. The DOM is never the source of truth for a baseline, because the
  // bids snapshot may have been skipped or its animation interrupted.
  function payoutBaseline(state) {
    if (state.phase !== "reveal" || state.revealStep !== "card") return displayScores(state);
    const last = state.history[state.history.length - 1];
    const out = {};
    for (const p of state.players) out[p.id] = p.score - ((last && last.deltas && last.deltas[p.id]) || 0);
    if (!last || last.void) return out;
    const ids = state.players.map((p) => p.id);
    const sellers = sellersOf(last, ids);
    for (const id of last.buyers) out[id] -= last.price * sellers.length;
    for (const id of sellers) out[id] += last.price * last.buyers.length;
    return out;
  }

  // Chip streams for one leg of the gross settlement. Buyers pay `price` to
  // every seller at the bids reveal; on a match every seller pays 100 to
  // every buyer at the card reveal. Zero-amount streams are omitted.
  function paymentStreams(entry, ids, step) {
    if (entry.void) return [];
    const sellers = sellersOf(entry, ids);
    const out = [];
    if (step === "bids") {
      if (entry.price === 0) return out;
      for (const b of entry.buyers) for (const s of sellers) out.push({ from: b, to: s, amount: entry.price });
    } else if (entry.matched) {
      for (const s of sellers) for (const b of entry.buyers) out.push({ from: s, to: b, amount: PAYOUT });
    }
    return out;
  }

  return { DEAL_TIMELINE_MS, transitionKey, plan, displayScores, payoutBaseline, paymentStreams };
});
