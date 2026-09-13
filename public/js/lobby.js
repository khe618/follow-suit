// Lobby-only parts of the table: empty seats that add bots, the Deal and
// Invite buttons in the centre, and the seat counter.
const { MAX_PLAYERS, MIN_PLAYERS } = window.GameCore;

export function emptySeat(position, disabled, send) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "seat empty";
  btn.setAttribute("aria-label", "Add a bot");
  btn.textContent = "+";
  btn.style.left = `${position.x}%`;
  btn.style.top = `${position.y}%`;
  btn.disabled = disabled;
  btn.addEventListener("click", () => send({ type: "add-bot" }));
  return btn;
}

export function renderLobbyCentre(els, state) {
  const n = state.players.length;
  els.lobbyCentre.hidden = false;
  els.dealBtn.disabled = n < MIN_PLAYERS;
  els.dealBtn.classList.toggle("pulse", n >= MIN_PLAYERS);
}

export function initLobbyControls(els, { send, roomCode, toast }) {
  els.dealBtn.addEventListener("click", () => send({ type: "start-game" }));
  els.inviteBtn.addEventListener("click", async () => {
    const url = `${location.origin}/${roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Follow Suit", url });
        return;
      } catch {
        // user dismissed the sheet; fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(url);
    }
  });
}
