(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Transitions = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Worst-case length of the deal timeline in timelines.js (24 cards at 70 ms
  // plus the last flight, the staggered flip-up, the look, the flip-down,
  // gather, riffle, reference flip, and memo fade: about 8.1 s), rounded up.
  // A dealing snapshot with less time left than this is drawn as its final
  // frame instead. Keep in step with timelines.js.
  const DEAL_TIMELINE_MS = 8500;
  // Worst case of the reveal-card timeline in timelines.js: turn, compare
  // beat, slide, payout streams, badge pop/hold/fade, tag fade. Keep in step
  // with timelines.js; a Node test checks it against the config default.
  const CARD_TIMELINE_MS = 4800;

  function transitionKey(s) {
    let key = `${s.matchId}:${s.phase}:${s.revealStep || ""}:${s.auctionIndex || 0}`;
    if (s.phase === "lobby") key += ":" + s.players.map((p) => p.id).join(",");
    return key;
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

  // Scores at the start of the leg the current reveal step animates: before
  // the purchase chips at reveal/bids, before the payout chips at
  // reveal/card. Derived from the snapshot alone, never from the DOM. The
  // server has already applied each leg when its snapshot is built.
  function legBaseline(state) {
    const out = {};
    for (const p of state.players) out[p.id] = p.score;
    if (state.phase !== "reveal") return out;
    const last = state.history[state.history.length - 1];
    if (!last) return out;
    if (state.revealStep === "bids") {
      for (const id of Object.keys(out)) out[id] -= (last.purchase && last.purchase[id]) || 0;
    } else if (state.revealStep === "card" && last.deltas) {
      for (const id of Object.keys(out)) out[id] -= (last.deltas[id] || 0) - ((last.purchase && last.purchase[id]) || 0);
    }
    return out;
  }

  // Chip streams for one leg. At the bids reveal every buyer pays every
  // seller that seller's bid; at the card reveal the server's netted payouts
  // fly as they are. Zero-amount streams are omitted.
  function paymentStreams(entry, step) {
    if (step === "bids") {
      if (entry.void) return [];
      const out = [];
      for (const b of entry.buyers) for (const s of entry.sellers) if (entry.bids[s] > 0) out.push({ from: b, to: s, amount: entry.bids[s] });
      return out;
    }
    return entry.payouts ? entry.payouts.map((p) => ({ ...p })) : [];
  }

  return { DEAL_TIMELINE_MS, CARD_TIMELINE_MS, transitionKey, plan, legBaseline, paymentStreams };
});
