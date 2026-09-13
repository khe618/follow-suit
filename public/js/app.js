import { createNet } from "./net.js";
import { initLanding, initJoin, setJoinState } from "./landing.js";
import { createTable } from "./table.js";
import { audio } from "./audio.js";
import { createTutorial } from "./tutorial.js";

const { plan } = window.Transitions;
const $ = (id) => document.getElementById(id);
const NAME_KEY = "followsuit:name";
const SEAT_WAIT_MS = 1500;

const store = {
  get(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};
const nameStore = { get: () => store.get(NAME_KEY), set: (v) => store.set(NAME_KEY, v) };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let roomCode = "";
let net = null;
let table = null;
let state = null;
let intent = null; // "quick" | "sit" | null, held in memory only
let pendingName = "";
let awaitingSeat = false;
let seatedSinceOpen = false; // did a seated snapshot arrive on the current socket?
let seatWaitTimer = null;
let startingRoom = false; // guards double clicks on the landing buttons
let toastTimer = null;

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function showView(id) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== id;
  if (id !== "tableView") $("resultsView").hidden = true;
  $("leaveBtn").hidden = id === "landingView";
}
function showSplash(code) {
  $("splashCode").textContent = code.toUpperCase();
  $("splash").hidden = false;
}
function hideSplash() {
  $("splash").hidden = true;
}

async function newRoom() {
  const res = await fetch("/api/new-room", { cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.room) throw new Error("no_room");
  return data.room;
}

async function startFromLanding(kind, name) {
  if (startingRoom) return;
  startingRoom = true;
  $("quickBtn").disabled = true;
  $("friendsBtn").disabled = true;
  audio.unlock();
  let code;
  try {
    code = await newRoom();
  } catch {
    toast("Could not reach the server.");
    startingRoom = false;
    $("quickBtn").disabled = false;
    $("friendsBtn").disabled = false;
    return;
  }
  intent = kind;
  pendingName = name;
  history.pushState({ room: code }, "", `/${code}`);
  enterRoom(code);
}

// Shown when the current socket has not produced a seated snapshot: the
// player has no seat here (fresh link, expired token, or a swept seat).
function showJoinScreen() {
  state = null;
  if (table) table.dispose();
  showView("joinView");
}

function onState(msg, meta) {
  if (!msg.you) {
    setJoinState(msg);
    if (!awaitingSeat) showJoinScreen();
    return;
  }
  awaitingSeat = false;
  seatedSinceOpen = true;
  clearTimeout(seatWaitTimer);
  hideSplash();
  const p = plan(state, msg, { hydrate: meta.hydrate, reducedMotion });
  state = msg;
  showView("tableView");
  table.render(msg, p);
}

function enterRoom(code) {
  // Only one room per document. A second call (never expected, but cheap to
  // guard) tears the first down so stale callbacks cannot act on it.
  if (net) net.close();
  if (table) table.dispose();
  roomCode = code;
  state = null;
  $("roomPill").textContent = code.toUpperCase();
  $("roomPill").hidden = false;
  const myTable = createTable({ send: (payload) => myNet.send(payload), roomCode: code, toast, audio });
  const myNet = createNet({
    roomCode: code,
    store,
    onOpen() {
      if (myNet !== net) return;
      seatedSinceOpen = false;
      if (intent === "quick") {
        awaitingSeat = true;
        myNet.send({ type: "quick-play", name: pendingName, resumeToken: myNet.token() });
        showSplash(code);
      } else if (intent === "sit") {
        awaitingSeat = true;
        myNet.send({ type: "join", name: pendingName, resumeToken: myNet.token() });
      } else if (myNet.hasToken()) {
        // resume was sent by net; give the seated snapshot a moment before
        // falling back to the join screen (an expired token gets no reply).
        awaitingSeat = true;
        clearTimeout(seatWaitTimer);
        seatWaitTimer = setTimeout(() => {
          awaitingSeat = false;
          if (!seatedSinceOpen) showJoinScreen();
        }, SEAT_WAIT_MS);
      }
      intent = null;
    },
    onState(msg, meta) {
      if (myNet === net) onState(msg, meta);
    },
    onJoined() {},
    onError(msg) {
      if (myNet !== net) return;
      awaitingSeat = false;
      hideSplash();
      toast(msg.message);
      if (!seatedSinceOpen) showJoinScreen();
    },
    onTakenOver() {
      if (myNet !== net) return;
      myTable.dispose();
      showView("takenOverView");
    },
    onConnection(ok) {
      if (myNet !== net) return;
      $("connPill").hidden = ok;
      myTable.setConnected(ok);
    }
  });
  net = myNet;
  table = myTable;
  showView(intent || myNet.hasToken() ? "tableView" : "joinView");
  myNet.connect();
}

function initTopbar() {
  const paint = () => {
    $("sfxBtn").setAttribute("aria-pressed", String(audio.sfxEnabled()));
    $("sfxBtn").setAttribute("aria-label", audio.sfxEnabled() ? "Sound effects on" : "Sound effects off");
  };
  paint();
  $("sfxBtn").addEventListener("click", () => { audio.unlock(); audio.setSfx(!audio.sfxEnabled()); audio.play("tap"); paint(); });
  $("leaveBtn").addEventListener("click", () => location.assign("/"));
  $("leaveResultsBtn").addEventListener("click", () => location.assign("/"));
  $("reloadBtn").addEventListener("click", () => location.reload());
  $("helpBtn").addEventListener("click", () => { audio.unlock(); if (window.openTutorial) window.openTutorial($("helpBtn")); });
  document.addEventListener("pointerdown", () => audio.unlock(), { passive: true });
}

function route() {
  const m = location.pathname.match(/^\/([a-z]{4})$/);
  if (m) {
    enterRoom(m[1]);
    return;
  }
  showView("landingView");
  $("roomPill").hidden = true;
  if (location.pathname === "/how-to-play" && window.openTutorial) window.openTutorial(null);
}

function init() {
  createTutorial($("tutorial"), { audio });
  initTopbar();
  initLanding({
    nameStore,
    onQuick: (name) => startFromLanding("quick", name),
    onFriends: (name) => startFromLanding("sit", name)
  });
  initJoin({
    nameStore,
    onSit(name) {
      audio.unlock();
      awaitingSeat = true;
      net.send({ type: "join", name, resumeToken: net.token() });
    }
  });
  window.addEventListener("popstate", () => location.reload());
  route();
}

init();
