import assert from "node:assert/strict";
import test from "node:test";

import { project, rubberband, verdictFor, COMMIT_RATIO } from "../shared/deck-physics.mjs";

// A typical deck in the suggestion panel.
const WIDTH = 400;
const THRESHOLD = WIDTH * COMMIT_RATIO;   // 112px

test("a flick that barely moved still commits, because it was thrown", () => {
  // 40px of travel — a third of the distance threshold — released at 1.2 px/ms.
  // The old rule looked only at distance and would have sprung this home, which
  // is the single behaviour this whole change exists to fix.
  const dx = 40;
  assert.ok(Math.abs(dx) < THRESHOLD, "precondition: under the distance bar");
  assert.equal(verdictFor(dx, 1.2, WIDTH), "like");
});

test("a slow crawl past the distance bar still commits", () => {
  // Distance alone remains sufficient: someone who deliberately drags the card
  // most of the way across has answered, however slowly they did it.
  assert.equal(verdictFor(-140, -0.01, WIDTH), "pass");
});

test("a slow, short drag springs home", () => {
  assert.equal(verdictFor(50, 0.05, WIDTH), null);
});

test("pulling back at release cancels the travel and springs the card home", () => {
  // Dragged 90px right, but moving left at the moment of release. The
  // projection eats the travel, so the card returns rather than committing to
  // a direction the hand had already changed its mind about.
  assert.equal(verdictFor(90, -0.6, WIDTH), null);
});

test("pulling back hard enough commits the other way", () => {
  // Same 90px of rightward travel, thrown left at 1.5 px/ms. Velocity sign
  // decides, not the distance already covered — reversing mid-gesture is a
  // real answer, not a cancelled one.
  assert.equal(verdictFor(90, -1.5, WIDTH), "pass");
});

test("projection is the exponential-decay form, not v squared over 2a", () => {
  // At the shipped deceleration a 1 px/ms release projects 199px.
  assert.equal(Math.round(project(1)), 199);
  // Linear in velocity — doubling the throw doubles the distance. The textbook
  // form would quadruple it, which is how flicks end up overshooting.
  assert.equal(Math.round(project(2)), Math.round(project(1) * 2));
  assert.equal(project(0), 0);
});

test("projection is signed", () => {
  assert.ok(project(-1) < 0);
  assert.equal(project(-1), -project(1));
});

test("rubber-banding resists more the further past the boundary you drag", () => {
  const height = 400;
  const near = rubberband(20, height);
  const far = rubberband(200, height);

  // It always follows a little, never nothing.
  assert.ok(near > 0 && far > 0);
  // But it always follows less than the finger moved.
  assert.ok(near < 20);
  assert.ok(far < 200);
  // And the ratio worsens with distance — that is what "resistance" means here,
  // as opposed to a constant fraction, which just feels like slow tracking.
  assert.ok(far / 200 < near / 20);
});

test("rubber-banding is symmetric and passes through zero", () => {
  assert.equal(rubberband(0, 400), 0);
  assert.equal(rubberband(-60, 400), -rubberband(60, 400));
});

test("the deck's width sets the bar, so a narrow deck is not harder to answer", () => {
  // The same gesture on a phone-width deck and a desktop-width one should
  // resolve the same way relative to the card, not in absolute pixels.
  const gesture = { dx: 0, velocity: 0.62 };
  const narrow = verdictFor(gesture.dx, gesture.velocity, 300);
  const wide = verdictFor(gesture.dx, gesture.velocity, 400);
  assert.equal(narrow, "like");
  assert.equal(wide, "like");

  // And a throw that clears a narrow deck but not a wide one does exactly that.
  assert.equal(verdictFor(0, 0.45, 300), "like");
  assert.equal(verdictFor(0, 0.45, 400), null);
});
