// Audio service. This file is the interface; Task 11 fills in the synthesis.
const SFX_KEY = "followsuit:sfx";
const MUSIC_KEY = "followsuit:music";

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
let musicOn = read(MUSIC_KEY);

export const audio = {
  unlock() {},
  play(_name) {},
  sfxEnabled: () => sfxOn,
  musicEnabled: () => musicOn,
  setSfx(on) {
    sfxOn = Boolean(on);
    write(SFX_KEY, sfxOn);
  },
  setMusic(on) {
    musicOn = Boolean(on);
    write(MUSIC_KEY, musicOn);
  },
  musicPause() {},
  musicResume() {}
};
