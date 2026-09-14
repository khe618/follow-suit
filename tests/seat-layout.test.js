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

const { fitRadii, podFace } = require("../public/seat-layout.js");

// Every pod corner must sit inside the felt ellipse for every seat count.
function allInside({ tableW, tableH, podW, podH, railPx }, { rx, ry }, counts = [2, 3, 4]) {
  const a = tableW / 2 - railPx, b = tableH / 2 - railPx;
  const cx = tableW / 2, cy = tableH / 2;
  return counts.every((n) => seatPositions(n, { rx, ry }).every((p) => {
    const px = (p.x / 100) * tableW, py = (p.y / 100) * tableH;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const dx = px + sx * podW / 2 - cx, dy = py + sy * podH / 2 - cy;
      if ((dx * dx) / (a * a) + (dy * dy) / (b * b) > 1.0001) return false;
    }
    return true;
  }));
}

const BOXES = {
  phone360: { tableW: 336, tableH: 437, podW: 92, podH: 52, railPx: 15 },
  phone414: { tableW: 390, tableH: 507, podW: 92, podH: 52, railPx: 15 },
  tablet768: { tableW: 744, tableH: 465, podW: 112, podH: 64, railPx: 15 },
  desktop900: { tableW: 900, tableH: 562, podW: 112, podH: 64, railPx: 15 }
};

test("seatPositions takes explicit radii and defaults to the originals", () => {
  assert.equal(Math.round(seatPositions(4)[0].y), 92);
  const tight = seatPositions(4, { rx: 30, ry: 25 });
  assert.equal(Math.round(tight[0].y), 75);
  assert.equal(Math.round(tight[1].x), 20);
});

test("fitRadii keeps every pod corner inside the felt at every breakpoint", () => {
  for (const [name, box] of Object.entries(BOXES)) {
    const r = fitRadii(box);
    assert.ok(r.rx > 0 && r.ry > 0, `${name} produced a usable ring`);
    assert.ok(allInside(box, r), `${name}: pods inside the felt`);
  }
});

test("fitRadii is maximal: nudging either radius pushes a pod out", () => {
  const box = BOXES.phone360;
  const r = fitRadii(box);
  assert.ok(!allInside(box, { rx: r.rx + 0.5, ry: r.ry }), "rx is at the limit");
  assert.ok(!allInside(box, { rx: r.rx, ry: r.ry + 0.5 }), "ry is at the limit");
});

// Pinned so the coordinate-ascent order cannot drift silently.
test("fitRadii returns the reviewed values", () => {
  assert.deepEqual(fitRadii(BOXES.phone360), { rx: 31.47, ry: 28.85 });
  assert.deepEqual(fitRadii(BOXES.tablet768), { rx: 39.93, ry: 31.08 });
});

test("fitRadii survives a pod larger than the felt", () => {
  const r = fitRadii({ tableW: 200, tableH: 200, podW: 400, podH: 400, railPx: 15 });
  assert.equal(r.rx, 0);
  assert.equal(r.ry, 0);
});

test("podFace points a seat's cards at the centre", () => {
  assert.equal(podFace({ x: 50, y: 80 }), "up");
  assert.equal(podFace({ x: 50, y: 20 }), "down");
  assert.equal(podFace({ x: 19, y: 50 }), "right");
  assert.equal(podFace({ x: 81, y: 50 }), "left");
  assert.equal(podFace({ x: 23, y: 36 }), "right");
  assert.equal(podFace({ x: 77, y: 36 }), "left");
});
