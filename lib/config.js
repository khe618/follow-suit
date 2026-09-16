"use strict";

function envInt(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Every tunable the server reads, with its production default.
function readConfig(env = process.env) {
  return {
    port: envInt(env, "PORT", 3000),
    game: {
      dealMs: envInt(env, "DEAL_MS", 9500),
      bidMs: envInt(env, "BID_MS", 60000),
      revealBidsMs: envInt(env, "REVEAL_BIDS_MS", 6000),
      revealCardMs: envInt(env, "REVEAL_CARD_MS", 6000)
    },
    resumeTtlMs: envInt(env, "RESUME_TTL_MS", 10 * 60 * 1000),
    heartbeatMs: envInt(env, "HEARTBEAT_MS", 30000)
  };
}

module.exports = { readConfig };
