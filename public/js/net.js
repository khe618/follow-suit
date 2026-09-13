// WebSocket lifecycle for one room. Reconnects with backoff on every close
// except the seat-takeover code, and marks the first seated snapshot after
// each open as hydration unless this socket itself asked to be seated.
const SEAT_TAKEN_OVER_CODE = 4000;

export function createNet({ roomCode, store, onOpen, onState, onJoined, onError, onTakenOver, onConnection }) {
  const tokenKey = `followsuit:token:${roomCode}`;
  let socket = null;
  let reconnectTimer = null;
  let delayMs = 1000;
  let stopped = false;
  let hydrate = true;

  const token = () => store.get(tokenKey);

  function connect() {
    if (stopped || socket) return;
    hydrate = true;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${roomCode}`);
    socket = ws;
    ws.addEventListener("open", () => {
      delayMs = 1000;
      onConnection(true);
      if (token()) send({ type: "resume", resumeToken: token() });
      onOpen();
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "joined") {
        store.set(tokenKey, msg.resumeToken);
        onJoined(msg);
      } else if (msg.type === "state") {
        let meta = { hydrate: false };
        if (msg.you) {
          meta = { hydrate };
          hydrate = false;
        }
        onState(msg, meta);
      } else if (msg.type === "error") {
        if (msg.code === "game_in_progress") store.del(tokenKey);
        onError(msg);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket === ws) socket = null;
      if (event.code === SEAT_TAKEN_OVER_CODE) {
        stopped = true;
        onTakenOver();
        return;
      }
      if (stopped) return;
      onConnection(false);
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delayMs);
        delayMs = Math.min(5000, delayMs * 1.5);
      }
    });
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // A socket that seats itself is not resuming: its first snapshot is a
    // real transition (quick play must animate the deal).
    if (payload.type === "join" || payload.type === "quick-play") hydrate = false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function close() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) socket.close();
    socket = null;
  }

  return { connect, send, close, token, hasToken: () => Boolean(token()) };
}
