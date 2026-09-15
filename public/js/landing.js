const $ = (id) => document.getElementById(id);
const { seatPositions } = window.SeatLayout;
const { MAX_PLAYERS } = window.GameCore;

function shake(input) {
  input.focus();
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
}

// No name is asked for here: quick play seats you as "You", and a friends
// room drops you on the same join card everyone else sees.
export function initLanding({ onQuick, onFriends }) {
  $("quickBtn").addEventListener("click", onQuick);
  $("friendsBtn").addEventListener("click", onFriends);
}

export function initJoin({ nameStore, onSit }) {
  const input = $("joinNameInput");
  input.value = nameStore.get();
  $("joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      shake(input);
      return;
    }
    nameStore.set(name);
    onSit(name);
  });
}

// Blurred table behind the join card with as many discs as players seated.
export function setJoinState(visitor) {
  const inPlay = visitor.phase !== "lobby";
  $("sitBtn").hidden = inPlay;
  $("inPlayPip").hidden = !inPlay;
  const backdrop = $("joinBackdrop");
  backdrop.replaceChildren();
  const table = document.createElement("div");
  table.className = "table";
  const positions = seatPositions(MAX_PLAYERS);
  for (let i = 0; i < Math.min(MAX_PLAYERS, visitor.playerCount); i++) {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.style.left = `${positions[i].x}%`;
    seat.style.top = `${positions[i].y}%`;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.setProperty("--seat-color", `var(--seat-${(i % 6) + 1})`);
    seat.append(avatar);
    table.append(seat);
  }
  backdrop.append(table);
}
