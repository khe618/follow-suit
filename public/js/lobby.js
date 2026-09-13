// Lobby-only parts of the table: empty seats that add bots, the Deal and
// Invite buttons in the centre, and the seat counter.
const { MAX_PLAYERS, MIN_PLAYERS } = window.GameCore;

export function emptySeat(position, disabled, send) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "seat empty";
  btn.textContent = "Add bot";
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
  // Invite always copies the room link; the toast confirms it. If the
  // clipboard is unavailable (insecure context, denied permission), the
  // toast shows the link itself so it can still be copied by hand.
  els.inviteBtn.addEventListener("click", async () => {
    const url = `${location.origin}/${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(url);
    }
  });
}
