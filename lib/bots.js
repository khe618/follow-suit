"use strict";
const { fairValue } = require("./fair-value.js");

const BOT_NAMES = [
  "Ada", "Bao", "Cyrus", "Dara", "Eli", "Femi", "Gus", "Hana", "Ivo", "Juno",
  "Kai", "Lena", "Milo", "Nia", "Omar", "Pia", "Quin", "Remy", "Sana", "Theo",
  "Uma", "Vik", "Wes", "Xia", "Yuri", "Zara", "Amir", "Bea", "Cleo", "Dax",
  "Esme", "Finn", "Gia", "Hugo", "Ines", "Joss", "Kira", "Leo", "Mira", "Nico"
];
const BOT_PROFILES = [
  { key: "careful", shade: 0.85, sigma: 2 },
  { key: "fair", shade: 0.93, sigma: 2 },
  { key: "keen", shade: 1.0, sigma: 3 },
  { key: "wild", shade: 1.08, sigma: 6 }
];
const BOT_MIN_DELAY_MS = 1500;
const BOT_MAX_DELAY_MS = 6000;

// Standard normal via Box-Muller. With sigma 0 the caller gets exactly
// round(fair * shade), which the tests rely on.
function gaussian(random) {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function defaultRandomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

// A random free name. Null only when every name is taken, which a 6-seat
// room can never do.
function pickBotName(takenNames, randomInt = defaultRandomInt) {
  const free = BOT_NAMES.filter((name) => !takenNames.includes(name));
  if (free.length === 0) return null;
  return free[randomInt(free.length)];
}

function botProfile(botIndex) {
  return BOT_PROFILES[botIndex % BOT_PROFILES.length];
}

function computeBotBid({ profile, hand, flips, playerCount, reference }, random = Math.random) {
  const fair = fairValue({ hand, flips, playerCount, reference });
  const noise = profile.sigma === 0 ? 0 : gaussian(random) * profile.sigma;
  const raw = Math.round(fair * profile.shade + noise);
  return Math.max(0, Math.min(100, raw));
}

function botDelayMs(bidMs, random = Math.random) {
  const hi = Math.min(BOT_MAX_DELAY_MS, Math.floor(bidMs / 2));
  const lo = Math.min(BOT_MIN_DELAY_MS, hi);
  return lo + Math.floor(random() * (hi - lo + 1));
}

module.exports = { BOT_NAMES, BOT_PROFILES, pickBotName, botProfile, computeBotBid, botDelayMs };
