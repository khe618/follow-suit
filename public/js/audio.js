// Every sound is synthesized on the fly with the Web Audio API. One context
// per document, created on the first user gesture (unlock) and resumed on
// every later gesture.
const SFX_KEY = "followsuit:sfx";
const PENTATONIC = [1046.5, 1174.66, 1318.51, 1567.98, 1760]; // C6 D6 E6 G6 A6

function read(key) {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}
function write(key, on) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}

let sfxOn = read(SFX_KEY);
let ctx = null;
let sfxBus = null;
let noiseBuffer = null;

function ensure() {
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxOn ? 1 : 0;
  sfxBus.connect(master);
  const len = ctx.sampleRate;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

// ---------- primitives ----------
function envelope(gain, t, attack, decay, peak) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function tone({ type = "sine", freq, t, attack = 0.005, decay = 0.1, peak = 0.3, glideTo = null, bus = sfxBus }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
  const gain = ctx.createGain();
  envelope(gain, t, attack, decay, peak);
  osc.connect(gain).connect(bus);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}
function noise({ t, attack = 0.005, decay = 0.1, peak = 0.3, filter = "bandpass", freq = 2000, q = 1, bus = sfxBus }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const gain = ctx.createGain();
  envelope(gain, t, attack, decay, peak);
  src.connect(f).connect(gain).connect(bus);
  src.start(t);
  src.stop(t + attack + decay + 0.05);
}
const vary = (base, pct = 0.1) => base * (1 - pct + Math.random() * 2 * pct);

// ---------- sound effects ----------
const SFX = {
  deal: (t) => noise({ t, attack: 0.012, decay: 0.09, peak: 0.16, freq: vary(1400), q: 0.6 }),
  flip: (t) => {
    tone({ type: "sine", freq: 2000, t, attack: 0.002, decay: 0.03, peak: 0.15 });
    noise({ t: t + 0.02, attack: 0.01, decay: 0.15, peak: 0.22, freq: 1500, q: 0.8 });
  },
  shuffle: (t) => {
    for (let i = 0; i < 12; i++) noise({ t: t + i * 0.02 + i * i * 0.004, attack: 0.004, decay: 0.05, peak: 0.16, freq: 2200 });
  },
  chip: (t) => tone({ type: "triangle", freq: PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)], t, attack: 0.003, decay: 0.08, peak: 0.2 }),
  lock: (t) => {
    noise({ t, attack: 0.005, decay: 0.12, peak: 0.3, filter: "lowpass", freq: 300, q: 0.7 });
    tone({ type: "triangle", freq: 1046.5, t: t + 0.03, attack: 0.003, decay: 0.1, peak: 0.2 });
  },
  tag: (t) => tone({ type: "sine", freq: 900, t, attack: 0.002, decay: 0.05, peak: 0.12 }),
  tick: (t, step = 0) => tone({ type: "sine", freq: 800 + step * 120, t, attack: 0.002, decay: 0.04, peak: 0.15 }),
  rise: (t) => tone({ type: "triangle", freq: 660, t, attack: 0.01, decay: 0.15, peak: 0.2, glideTo: 990 }),
  match: (t) => {
    tone({ type: "triangle", freq: 659.25, t, attack: 0.01, decay: 0.35, peak: 0.28 });
    tone({ type: "triangle", freq: 987.77, t: t + 0.14, attack: 0.01, decay: 0.5, peak: 0.28 });
  },
  miss: (t) => tone({ type: "sine", freq: 160, t, attack: 0.01, decay: 0.4, peak: 0.35, glideTo: 70 }),
  win: (t) => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ type: "triangle", freq: f, t: t + i * 0.13, attack: 0.01, decay: 0.4, peak: 0.3 })),
  end: (t) => [392, 493.88, 587.33].forEach((f) => tone({ type: "triangle", freq: f, t, attack: 0.05, decay: 1.2, peak: 0.2 })),
  tap: (t) => tone({ type: "sine", freq: 1200, t, attack: 0.001, decay: 0.02, peak: 0.1 }),
  dealin: (t) => noise({ t, attack: 0.01, decay: 0.2, peak: 0.15, freq: 1200, q: 0.6 })
};

function play(name, arg) {
  if (!sfxOn || !ensure()) return;
  const fn = SFX[name];
  if (fn) fn(ctx.currentTime, arg);
}

export const audio = {
  unlock() {
    ensure();
  },
  play,
  sfxEnabled: () => sfxOn,
  setSfx(on) {
    sfxOn = Boolean(on);
    write(SFX_KEY, sfxOn);
    if (sfxBus) sfxBus.gain.value = sfxOn ? 1 : 0;
  }
};
