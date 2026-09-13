(function () {
  "use strict";

  const { SUITS, SUIT_SYMBOLS, countSuits, rank } = window.GameCore;
  // Must match SEAT_TAKEN_OVER_CODE in lib/rooms.js. Never auto-reconnect on
  // it: reconnecting would take the seat straight back and two tabs would
  // trade it forever.
  const SEAT_TAKEN_OVER_CODE = 4000;
  const NAME_KEY = "followsuit:name";
  const roomCode = (location.pathname.match(/^\/([a-z]{4})$/) || [])[1] || "";
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  };
  const tokenKey = () => `followsuit:token:${roomCode}`;

  let socket = null;
  let state = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 1000;
  let takenOver = false;
  let deadlineAt = 0; // performance.now() at which the bidding window ends
  let draft = { auction: null, amount: 0, locked: false };
  let resyncDraft = true; // after every (re)connect, trust the server's stored bid over the local draft
  let bidSendTimer = null;
  let toastTimer = null;
  let lastRevealKey = ""; // which auction's card step has already been animated

  // ---------- small helpers ----------
  function show(viewId) {
    for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== viewId;
  }
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function cardEl(suit, size) {
    const node = el("div", `card ${suit} ${size || ""}`.trim(), SUIT_SYMBOLS[suit]);
    node.setAttribute("aria-label", suit);
    return node;
  }
  function bySuit(cards) {
    return cards.slice().sort((a, b) => SUITS.indexOf(a) - SUITS.indexOf(b));
  }
  function playerName(id) {
    const p = state && state.players.find((x) => x.id === id);
    return p ? p.name : id;
  }
  function isHost() {
    return Boolean(state && state.you && state.hostId === state.you);
  }
  function fmtDelta(n) {
    return n > 0 ? `+${n}` : String(n);
  }
  function saveName() {
    store.set(NAME_KEY, $("nameInput").value.trim());
  }

  // ---------- landing / name view ----------
  function initLanding() {
    $("nameInput").value = store.get(NAME_KEY);
    if (roomCode) {
      $("landingActions").hidden = true;
      $("roomActions").hidden = false;
      $("joinRoomCode").textContent = roomCode.toUpperCase();
      $("roomBadge").textContent = roomCode.toUpperCase();
      $("roomBadge").hidden = false;
    }
    $("createBtn").addEventListener("click", async () => {
      saveName();
      try {
        const res = await fetch("/api/new-room", { cache: "no-store" });
        const data = await res.json();
        if (res.ok && data.room) location.href = `/${data.room}`;
        else toast("No room available right now, try again.");
      } catch {
        toast("Could not reach the server.");
      }
    });
    $("joinCodeBtn").addEventListener("click", () => {
      saveName();
      const code = $("codeInput").value.trim().toLowerCase();
      if (/^[a-z]{4}$/.test(code)) location.href = `/${code}`;
      else toast("Room codes are 4 letters.");
    });
    $("nameForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveName();
      if (!roomCode) {
        const code = $("codeInput").value.trim().toLowerCase();
        if (/^[a-z]{4}$/.test(code)) location.href = `/${code}`;
        else $("createBtn").click();
        return;
      }
      const name = $("nameInput").value.trim();
      if (!name) {
        toast("Please enter a name.");
        return;
      }
      send({ type: "join", name, resumeToken: store.get(tokenKey()) });
    });
  }

  // ---------- socket ----------
  function connect() {
    if (!roomCode || takenOver) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws?room=${roomCode}`);
    socket.addEventListener("open", () => {
      reconnectDelayMs = 1000;
      resyncDraft = true;
      $("connBadge").hidden = true;
      setBidControlsEnabled(true);
      const token = store.get(tokenKey());
      if (token) send({ type: "resume", resumeToken: token });
    });
    socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "joined") {
        store.set(tokenKey(), msg.resumeToken);
      } else if (msg.type === "state") {
        state = msg;
        render();
      } else if (msg.type === "error") {
        toast(msg.message);
        if (msg.code === "game_in_progress") store.del(tokenKey());
      }
    });
    socket.addEventListener("close", (event) => {
      socket = null;
      clearTimeout(bidSendTimer);
      setBidControlsEnabled(false);
      if (event.code === SEAT_TAKEN_OVER_CODE) {
        takenOver = true;
        show("takenOverView");
        return;
      }
      $("connBadge").hidden = false;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
        reconnectDelayMs = Math.min(5000, reconnectDelayMs * 1.5);
      }
    });
  }
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      toast("Reconnecting, try again in a moment.");
      return;
    }
    socket.send(JSON.stringify(payload));
  }
  function setBidControlsEnabled(enabled) {
    for (const id of ["bidInput", "bidRange", "lockBtn"]) $(id).disabled = !enabled;
  }

  // ---------- rendering ----------
  function render() {
    if (!state) return;
    if (!state.you) {
      show("nameView");
      const n = state.playerCount;
      $("roomPreview").textContent = state.phase === "lobby" ? (n ? `${n} in the lobby` : "Nobody here yet, you will be host") : "Game in progress";
      return;
    }
    if (state.phase === "lobby") {
      show("lobbyView");
      renderLobby();
    } else if (state.phase === "results") {
      show("resultsView");
      renderResults();
    } else {
      show("gameView");
      renderGame();
    }
  }

  function renderLobby() {
    const list = $("lobbyPlayers");
    list.replaceChildren();
    for (const p of state.players) {
      const row = el("li", "player-row" + (p.connected ? "" : " away"));
      row.append(el("span", "player-name", p.name));
      if (p.isBot) row.append(el("span", "badge", "bot"));
      if (p.id === state.hostId) row.append(el("span", "badge host", "host"));
      if (p.id === state.you) row.append(el("span", "badge you", "you"));
      if (!p.connected) row.append(el("span", "badge", "away"));
      if (p.isBot && isHost()) {
        const btn = el("button", "link-btn", "remove");
        btn.type = "button";
        btn.addEventListener("click", () => send({ type: "remove-bot", playerId: p.id }));
        row.append(btn);
      }
      list.append(row);
    }
    $("roomLink").value = `${location.origin}/${roomCode}`;
    $("lobbyCount").textContent = `${state.players.length} of ${state.maxPlayers} seats filled`;
    $("lobbyHandInfo").textContent = state.handSize
      ? `With ${state.players.length} players everyone gets ${state.handSize} cards and the deck holds ${(state.players.length + 1) * state.handSize}.`
      : "Need at least 2 players to start.";
    const host = isHost();
    $("hostControls").hidden = !host;
    $("guestNote").hidden = host;
    $("addBotBtn").disabled = state.players.length >= state.maxPlayers;
    $("startBtn").disabled = state.players.length < state.minPlayers;
  }

  function renderGame() {
    const total = state.flipped.length + state.cardsRemaining;
    const inCardStep = state.phase === "reveal" && state.revealStep === "card";
    $("refCard").replaceChildren(cardEl(state.reference, "big"));
    $("refLabel").textContent = inCardStep
      ? `New reference: ${SUIT_SYMBOLS[state.reference]}`
      : `Will the next card be ${SUIT_SYMBOLS[state.reference]}?`;
    $("deckInfo").textContent = `${state.cardsRemaining} of ${total} cards left, ${state.hiddenCount} were never seen by anyone`;

    const strip = $("flipStrip");
    strip.replaceChildren();
    state.flipped.forEach((suit, i) => {
      const c = cardEl(suit, "mini");
      if (i === state.flipped.length - 1) c.classList.add("current");
      strip.append(c);
    });
    strip.scrollLeft = strip.scrollWidth;

    const counts = countSuits(state.flipped);
    $("flipCounts").replaceChildren(...SUITS.map((suit) => el("span", `chip ${suit}`, `${SUIT_SYMBOLS[suit]} ${counts[suit]}`)));

    const hand = $("hand");
    hand.replaceChildren();
    for (const suit of bySuit(state.hand)) hand.append(cardEl(suit, "small"));

    const auctionNo = state.auctionIndex || state.history.length;
    $("auctionLabel").textContent = `Auction ${auctionNo} of ${total - 1}`;

    const bidding = state.phase === "bidding";
    $("bidPanel").hidden = !bidding;
    $("revealPanel").hidden = bidding;
    $("timer").hidden = !bidding;
    // Animate the card and the score deltas once per auction, not on every
    // state message that happens to arrive during the card step.
    let animate = false;
    if (inCardStep) {
      const key = `${state.matchId}:${state.auctionIndex}`;
      animate = key !== lastRevealKey;
      lastRevealKey = key;
    }
    if (bidding) renderBidPanel();
    else renderRevealPanel(animate);
    renderScoreboard(animate);
  }

  function renderScoreboard(animate) {
    const last = state.history[state.history.length - 1];
    const showDeltas = state.phase === "reveal" && state.revealStep === "card" && last && last.deltas;
    const buyers = state.phase === "reveal" && last ? last.buyers : [];
    const board = $("scoreboard");
    board.replaceChildren();
    for (const p of state.players) {
      const row = el("li", "score-row" + (p.id === state.you ? " you" : "") + (buyers.includes(p.id) ? " buyer" : "") + (p.connected ? "" : " away"));
      row.append(el("span", "player-name", p.name));
      if (state.phase === "bidding") row.append(el("span", "lock" + (p.locked ? " on" : ""), p.locked ? "locked" : "thinking"));
      if (showDeltas) {
        const d = last.deltas[p.id] || 0;
        row.append(el("span", "delta " + (d > 0 ? "pos" : d < 0 ? "neg" : "zero") + (animate ? " pop" : ""), fmtDelta(d)));
      }
      row.append(el("span", "score", String(p.score)));
      board.append(row);
    }
  }

  function renderBidPanel() {
    if (resyncDraft || draft.auction !== state.auctionIndex) {
      resyncDraft = false;
      draft = {
        auction: state.auctionIndex,
        amount: state.myBid ? state.myBid.amount : 0,
        locked: state.myBid ? state.myBid.locked : false
      };
      $("bidInput").value = draft.amount;
      $("bidRange").value = draft.amount;
    }
    deadlineAt = performance.now() + state.remainingMs;
    updateTimer();
    paintLockButton();
  }

  function paintLockButton() {
    const btn = $("lockBtn");
    btn.textContent = draft.locked ? "Locked (tap to change)" : "Lock in bid";
    btn.classList.toggle("locked", draft.locked);
    $("bidHint").textContent = draft.locked
      ? "Waiting for the others. Your bid still counts if time runs out."
      : "Price you pay each opponent. You collect 100 from each if the card follows suit.";
  }

  function updateTimer() {
    const ms = Math.max(0, deadlineAt - performance.now());
    const node = $("timer");
    node.textContent = `${Math.ceil(ms / 1000)}s`;
    node.classList.toggle("urgent", ms < 5000);
  }
  setInterval(() => {
    if (state && state.phase === "bidding") updateTimer();
  }, 200);

  function setDraftAmount(raw) {
    let n = Math.round(Number(raw));
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(100, n));
    draft.amount = n;
    draft.locked = false;
    $("bidRange").value = n;
    if (document.activeElement !== $("bidInput")) $("bidInput").value = n;
    paintLockButton();
    scheduleBidSend(false);
  }

  function scheduleBidSend(immediate) {
    clearTimeout(bidSendTimer);
    const fire = () => send({ type: "bid", auction: draft.auction, amount: draft.amount, locked: draft.locked });
    if (immediate) fire();
    else bidSendTimer = setTimeout(fire, 150);
  }

  function lockBid() {
    draft.locked = !draft.locked;
    paintLockButton();
    scheduleBidSend(true);
  }

  function renderRevealPanel(animate) {
    const last = state.history[state.history.length - 1];
    if (!last) return;
    const list = $("revealBids");
    list.replaceChildren();
    const rows = Object.entries(last.bids).sort((a, b) => b[1] - a[1]);
    for (const [id, amount] of rows) {
      const row = el("li", "bid-row" + (last.buyers.includes(id) ? " buyer" : "") + (id === state.you ? " you" : ""));
      row.append(el("span", "player-name", playerName(id)));
      row.append(el("span", "amount", String(amount)));
      list.append(row);
    }
    $("revealSummary").textContent = last.void
      ? `Everyone bid ${last.price}. No trade this card.`
      : `${last.buyers.map(playerName).join(" and ")} ${last.buyers.length > 1 ? "buy" : "buys"} at ${last.price}`;
    const outcome = $("revealOutcome");
    outcome.replaceChildren();
    if (state.revealStep === "card") {
      outcome.append(cardEl(last.flipped, animate ? "big flip-in" : "big"));
      outcome.append(el("p", "outcome-text " + (last.matched ? "match" : "miss"), last.matched ? "Follows suit!" : "No match"));
    } else {
      outcome.append(el("p", "outcome-text pending", "Flipping the next card"));
    }
  }

  function renderResults() {
    const scores = {};
    for (const p of state.players) scores[p.id] = p.score;
    const standings = $("standings");
    standings.replaceChildren();
    for (const row of rank(scores)) {
      const p = state.players.find((x) => x.id === row.id);
      const li = el("li", "standing" + (row.id === state.you ? " you" : ""));
      li.append(el("span", "rank", `#${row.rank}`));
      li.append(el("span", "player-name", p.name));
      const hand = el("span", "mini-hand");
      for (const suit of bySuit(p.hand || [])) hand.append(cardEl(suit, "mini"));
      li.append(hand);
      li.append(el("span", "score " + (row.score > 0 ? "pos" : row.score < 0 ? "neg" : "zero"), fmtDelta(row.score)));
      standings.append(li);
    }
    $("historyLegend").textContent = `Bids and score changes are listed in this order: ${state.players.map((p) => p.name).join(", ")}.`;
    const tbody = $("historyBody");
    tbody.replaceChildren();
    for (const h of state.history) {
      const tr = el("tr");
      tr.append(el("td", "", String(h.index)));
      tr.append(el("td", `suit ${h.reference}`, SUIT_SYMBOLS[h.reference]));
      tr.append(el("td", "", state.players.map((p) => h.bids[p.id]).join(" / ")));
      tr.append(el("td", "", h.void ? `void @ ${h.price}` : `${h.buyers.map(playerName).join(", ")} @ ${h.price}`));
      tr.append(el("td", `suit ${h.flipped}`, `${SUIT_SYMBOLS[h.flipped]}${h.matched ? " match" : ""}`));
      tr.append(el("td", "", state.players.map((p) => fmtDelta((h.deltas && h.deltas[p.id]) || 0)).join(" / ")));
      tbody.append(tr);
    }
    $("playAgainBtn").hidden = !isHost();
    $("resultsGuestNote").hidden = isHost();
  }

  // ---------- init ----------
  function init() {
    initLanding();
    $("copyLinkBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("roomLink").value);
        toast("Link copied");
      } catch {
        $("roomLink").select();
      }
    });
    $("addBotBtn").addEventListener("click", () => send({ type: "add-bot" }));
    $("startBtn").addEventListener("click", () => send({ type: "start-game" }));
    $("bidInput").addEventListener("input", (event) => setDraftAmount(event.target.value));
    $("bidRange").addEventListener("input", (event) => setDraftAmount(event.target.value));
    $("lockBtn").addEventListener("click", lockBid);
    $("playAgainBtn").addEventListener("click", () => send({ type: "return-to-lobby" }));
    $("reloadBtn").addEventListener("click", () => location.reload());
    show("nameView");
    connect();
  }

  init();
})();
