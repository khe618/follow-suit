const $ = (id) => document.getElementById(id);
const { seatPositions } = window.SeatLayout;

function shake(input) {
  input.focus();
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
}

export function initLanding({ nameStore, onQuick, onFriends }) {
  const input = $("nameInput");
  input.value = nameStore.get();
  const nameOrShake = () => {
    const name = input.value.trim();
    if (!name) {
      shake(input);
      return null;
    }
    nameStore.set(name);
    return name;
  };
  $("quickBtn").addEventListener("click", () => {
    const name = nameOrShake();
    if (name) onQuick(name);
  });
  $("friendsBtn").addEventListener("click", () => {
    const name = nameOrShake();
    if (name) onFriends(name);
  });
  $("landingForm").addEventListener("submit", (event) => {
    event.preventDefault();
    $("quickBtn").click();
  });
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
  const positions = seatPositions(6);
  for (let i = 0; i < Math.min(6, visitor.playerCount); i++) {
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
