(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SeatLayout = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RX = 44; // horizontal radius, percent of the table box
  const RY = 42; // vertical radius

  // Seat i sits at angle 360*i/count clockwise from the bottom, so index 0
  // (the viewer) is bottom centre, index 1 is to their left, and the last
  // index is to their right. Coordinates are percentages of the table box.
  function seatPositions(count, { rx = RX, ry = RY } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 6) throw new RangeError(`unsupported seat count: ${count}`);
    const out = [];
    for (let i = 0; i < count; i++) {
      const angle = (360 * i) / count;
      const rad = (angle * Math.PI) / 180;
      out.push({ x: 50 - rx * Math.sin(rad), y: 50 + ry * Math.cos(rad), angle });
    }
    return out;
  }

  // The largest seat ring that keeps every corner of every pod inside the
  // felt ellipse, for every seat count the table supports — so the ring does
  // not jump when a player joins or leaves. rx and ry trade off against each
  // other, so "largest" needs an objective: coordinate ascent, rx first, four
  // rounds. A test pins the values so the ascent order cannot drift.
  function fitRadii({ tableW, tableH, podW, podH, railPx, counts = [2, 3, 4], maxRx = 46, maxRy = 46 }) {
    const a = tableW / 2 - railPx;
    const b = tableH / 2 - railPx;
    const cx = tableW / 2;
    const cy = tableH / 2;
    if (!(a > 0) || !(b > 0)) return { rx: 0, ry: 0 };
    const fits = (rx, ry) => counts.every((n) => seatPositions(n, { rx, ry }).every((p) => {
      const px = (p.x / 100) * tableW;
      const py = (p.y / 100) * tableH;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const dx = px + sx * (podW / 2) - cx;
          const dy = py + sy * (podH / 2) - cy;
          if ((dx * dx) / (a * a) + (dy * dy) / (b * b) > 1) return false;
        }
      }
      return true;
    }));
    const climb = (other, axis) => {
      let lo = 0;
      let hi = axis === "rx" ? maxRx : maxRy;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        if (axis === "rx" ? fits(mid, other) : fits(other, mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    let rx = 0;
    let ry = 0;
    for (let round = 0; round < 4; round++) {
      rx = climb(ry, "rx");
      ry = climb(rx, "ry");
    }
    return { rx: Number(rx.toFixed(2)), ry: Number(ry.toFixed(2)) };
  }

  // Which way a seat's owned cards fan: always toward the middle of the
  // table, chosen by dominant axis so diagonal seats are defined too.
  function podFace({ x, y }) {
    const dx = 50 - x;
    const dy = 50 - y;
    if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "down" : "up";
    return dx >= 0 ? "right" : "left";
  }

  return { seatPositions, fitRadii, podFace };
});
