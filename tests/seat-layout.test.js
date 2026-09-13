const test = require("node:test");
const assert = require("node:assert/strict");
const { seatPositions } = require("../public/seat-layout.js");

test("index 0 is the viewer at bottom centre for every table size", () => {
  for (let n = 1; n <= 6; n++) {
    const p = seatPositions(n)[0];
    assert.deepEqual({ x: Math.round(p.x), y: Math.round(p.y), angle: p.angle }, { x: 50, y: 92, angle: 0 }, `${n} players`);
  }
});

test("seats are distinct, inside the box, and evenly spaced clockwise", () => {
  for (let n = 2; n <= 6; n++) {
    const seats = seatPositions(n);
    assert.equal(seats.length, n);
    const keys = new Set(seats.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    assert.equal(keys.size, n, `${n} players are at distinct spots`);
    for (const s of seats) assert.ok(s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 100);
    for (let i = 1; i < n; i++) assert.equal(seats[i].angle - seats[i - 1].angle, 360 / n);
  }
});

test("two players sit opposite; seat 1 is to the viewer's left", () => {
  const two = seatPositions(2);
  assert.ok(two[1].y < 20, "opposite seat is at the top");
  assert.equal(Math.round(two[1].x), 50);
  const four = seatPositions(4);
  assert.ok(four[1].x < 20, "clockwise from the bottom goes left first");
  assert.ok(four[3].x > 80, "and ends on the right");
});

test("rejects unsupported counts", () => {
  assert.throws(() => seatPositions(0), RangeError);
  assert.throws(() => seatPositions(7), RangeError);
});
