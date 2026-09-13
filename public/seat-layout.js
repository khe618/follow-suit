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
  function seatPositions(count) {
    if (!Number.isInteger(count) || count < 1 || count > 6) throw new RangeError(`unsupported seat count: ${count}`);
    const out = [];
    for (let i = 0; i < count; i++) {
      const angle = (360 * i) / count;
      const rad = (angle * Math.PI) / 180;
      out.push({ x: 50 - RX * Math.sin(rad), y: 50 + RY * Math.cos(rad), angle });
    }
    return out;
  }

  return { seatPositions };
});
