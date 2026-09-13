// DOM adapter over the sequencer: sprite groups, FLIP-style flights with the
// Web Animations API, and card flips. Every animation is registered with
// ctx.track, so the sequencer cancels it synchronously on cancelAll and at
// the end of a finished run; the sprite group is the run's cleanup. Timelines
// therefore only ever write to their own group and to tracked animations.
const { createSequencer } = window.Sequencer;

export function createAnim(layer) {
  const seq = createSequencer();
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reducedQuery.matches;
  let active = 0;

  // Centre of `el` in sprite-layer coordinates.
  function centre(el) {
    const r = el.getBoundingClientRect();
    const L = layer.getBoundingClientRect();
    return { x: r.left - L.left + r.width / 2, y: r.top - L.top + r.height / 2, w: r.width, h: r.height };
  }

  // Reduced motion: keep only the opacity keyframes (or fade in), 150 ms.
  function reducedFrames(frames) {
    const withOpacity = frames.filter((f) => "opacity" in f);
    if (withOpacity.length < 2) return [{ opacity: 0 }, { opacity: 1 }];
    return frames.filter((f) => "opacity" in f).map((f) => (f.offset === undefined ? { opacity: f.opacity } : { opacity: f.opacity, offset: f.offset }));
  }

  function run(timeline) {
    const g = document.createElement("div");
    g.className = "sprites";
    layer.append(g);
    active += 1;
    const cleanup = () => {
      g.remove();
      active -= 1;
    };
    return seq.run((sctx) => {
      const settled = (animation) => sctx.track(animation).finished.catch(() => {});
      const ctx = {
        g,
        centre,
        reduced,
        wait: sctx.wait,
        until: sctx.until,
        alive: sctx.alive,
        track: sctx.track,
        spawn(className, text = "") {
          const el = document.createElement("div");
          el.className = className;
          el.textContent = text;
          el.style.position = "absolute";
          el.style.left = "0";
          el.style.top = "0";
          el.style.willChange = "transform";
          g.append(el);
          return el;
        },
        // Flies a sprite so its centre travels from `from` to `to`. Resolves
        // when the flight lands or is cancelled; never rejects, so a
        // fire-and-forget `.then` must check ctx.alive() itself. Reduced
        // motion: appear at `to` with a fade.
        fly(el, from, to, ms, { arc = 0, spin = 0, easing = "cubic-bezier(.22,.8,.36,1)" } = {}) {
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          const at = (p, deg) => `translate(${p.x - w / 2}px, ${p.y - h / 2}px) rotate(${deg}deg)`;
          if (reduced()) {
            el.style.transform = at(to, 0);
            return settled(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: "forwards" }));
          }
          const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - arc };
          const frames = arc
            ? [{ transform: at(from, 0) }, { transform: at(mid, spin / 2), offset: 0.5 }, { transform: at(to, spin) }]
            : [{ transform: at(from, 0) }, { transform: at(to, spin) }];
          return settled(el.animate(frames, { duration: ms, easing, fill: "forwards" }));
        },
        // Places a sprite at a centre without motion.
        put(el, p) {
          el.style.transform = `translate(${p.x - el.offsetWidth / 2}px, ${p.y - el.offsetHeight / 2}px)`;
        },
        // A one-off animation, always awaited: resolves only while the run is
        // current and throws the cancellation sentinel otherwise, so nothing
        // after an `await ctx.animate(...)` runs for a cancelled timeline.
        animate(el, frames, options = {}) {
          if (reduced()) return sctx.until(settled(el.animate(reducedFrames(frames), { ...options, duration: 150 })));
          return sctx.until(settled(el.animate(frames, options)));
        },
        // Flip in place: rotate to the edge, call onHalf (swap face), rotate back.
        async flip(el, ms, onHalf) {
          if (reduced()) {
            onHalf();
            await sctx.wait(150);
            return;
          }
          const a = sctx.track(el.animate([{ transform: "perspective(600px) rotateY(0deg)" }, { transform: "perspective(600px) rotateY(90deg)" }], { duration: ms / 2, easing: "ease-in", fill: "forwards", composite: "add" }));
          await sctx.until(a.finished.catch(() => {}));
          onHalf();
          const b = sctx.track(el.animate([{ transform: "perspective(600px) rotateY(-90deg)" }, { transform: "perspective(600px) rotateY(0deg)" }], { duration: ms / 2, easing: "ease-out", composite: "add" }));
          a.cancel();
          await sctx.until(b.finished.catch(() => {}));
        },
        // Turn a card over on the way from `from` to `to`, the way a dealer
        // flips the top card of the deck onto the table: it lifts, travels,
        // and rotates edge-on at the midpoint, where onHalf swaps its face,
        // then settles face up at `to`. Never mirrors the face (the second
        // half rotates from -90 back to 0). Awaited; cancellation-safe like
        // ctx.animate. Reduced motion: appear at `to` with the new face.
        async turn(el, from, to, ms, onHalf, { lift = 1.12 } = {}) {
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          const at = (p, deg, s) => `translate(${p.x - w / 2}px, ${p.y - h / 2}px) perspective(600px) rotateY(${deg}deg) scale(${s})`;
          if (reduced()) {
            onHalf();
            el.style.transform = at(to, 0, 1);
            await sctx.until(settled(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: "forwards" })));
            return;
          }
          const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 8 };
          const a = sctx.track(el.animate([{ transform: at(from, 0, 1) }, { transform: at(mid, 90, lift) }], { duration: ms / 2, easing: "ease-in", fill: "forwards" }));
          await sctx.until(a.finished.catch(() => {}));
          onHalf();
          const b = sctx.track(el.animate([{ transform: at(mid, -90, lift) }, { transform: at(to, 0, 1) }], { duration: ms / 2, easing: "ease-out", fill: "forwards" }));
          a.cancel();
          await sctx.until(b.finished.catch(() => {}));
          el.style.transform = at(to, 0, 1);
        }
      };
      return timeline(ctx);
    }, { cleanup });
  }

  return { run, cancelAll: () => seq.cancelAll(), reduced, centre, running: () => active > 0 };
}
