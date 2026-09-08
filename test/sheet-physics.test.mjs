import assert from "node:assert/strict";
import test from "node:test";

import {
  sheetOffset,
  shouldDismiss,
  scrimFor,
  DISMISS_RATIO,
  DISMISS_VELOCITY,
} from "../shared/sheet-physics.mjs";

// A garment viewer on a phone: most of the screen, minus the status bar.
const HEIGHT = 700;
const THRESHOLD = HEIGHT * DISMISS_RATIO;   // 280px

test("a short fast flick dismisses, because it was thrown", () => {
  // 20px of travel — under a tenth of the distance bar — released at 0.4 px/ms.
  // This is the case the velocity rule exists for, and the one a distance-only
  // threshold gets wrong.
  assert.ok(20 < THRESHOLD, "precondition: nowhere near the distance bar");
  assert.equal(shouldDismiss(20, 0.4, HEIGHT), true);
});

test("a slow crawl that never gets far springs home", () => {
  // 100px down over a long enough time to carry no momentum. The person is
  // looking, not leaving.
  assert.equal(shouldDismiss(100, 0.02, HEIGHT), false);
});

test("a slow push most of the way down still dismisses", () => {
  // Distance alone remains sufficient. Someone who deliberately drags a sheet
  // past the bar has answered, however little velocity they had at release.
  assert.equal(shouldDismiss(320, 0.01, HEIGHT), true);
});

test("releasing while pulling back up keeps the sheet", () => {
  // Dragged 200px down, but moving upward at release. The projection eats the
  // travel, so the sheet returns rather than leaving on a gesture the hand had
  // already reversed.
  assert.equal(shouldDismiss(200, -0.5, HEIGHT), false);
});

test("springing back from an upward lift is not a dismissal", () => {
  // The guard that stops the rubber band from dismissing the sheet it is
  // pulling home: above the resting position, moving down fast, and yet the
  // only correct answer is "stay".
  assert.ok(0.6 > DISMISS_VELOCITY, "precondition: fast enough to trip the velocity rule");
  assert.equal(shouldDismiss(-40, 0.6, HEIGHT), false);
});

test("the velocity bar is the standards' number, not a distance in disguise", () => {
  // Just under and just over 0.11 px/ms, at a travel distance far below the
  // distance bar, so only the velocity rule can be deciding.
  assert.equal(shouldDismiss(10, DISMISS_VELOCITY - 0.01, HEIGHT), false);
  assert.equal(shouldDismiss(10, DISMISS_VELOCITY + 0.01, HEIGHT), true);
});

test("the sheet's own height sets the bar, so a short sheet is not harder to dismiss", () => {
  // The same slow push should resolve the same way relative to the sheet, not
  // in absolute pixels — a 300px confirm and a 700px viewer both leave when
  // pushed 40% of their own height.
  assert.equal(shouldDismiss(130, 0.01, 300), true);
  assert.equal(shouldDismiss(130, 0.01, 700), false);
});

test("downward tracks the finger exactly", () => {
  // Any damping on the way out reads as the sheet lagging the hand pushing it.
  assert.equal(sheetOffset(0, HEIGHT), 0);
  assert.equal(sheetOffset(120, HEIGHT), 120);
  assert.equal(sheetOffset(600, HEIGHT), 600);
});

test("upward resists, and resists more the further it is lifted", () => {
  const near = sheetOffset(-20, HEIGHT);
  const far = sheetOffset(-200, HEIGHT);

  // It always follows a little, never nothing — a hard stop reads as frozen.
  assert.ok(near < 0 && far < 0);
  // But always less than the finger moved.
  assert.ok(Math.abs(near) < 20);
  assert.ok(Math.abs(far) < 200);
  // And the ratio worsens with distance. That is what resistance means here;
  // a constant fraction would just feel like sluggish tracking.
  assert.ok(Math.abs(far) / 200 < Math.abs(near) / 20);
});

test("the scrim fades with position and clamps at both ends", () => {
  assert.equal(scrimFor(0, HEIGHT), 1);
  // Lifting the sheet above rest must not brighten the scrim past full.
  assert.equal(scrimFor(-100, HEIGHT), 1);
  // Nor may pushing it past its own height drive the scrim negative.
  assert.equal(scrimFor(HEIGHT * 2, HEIGHT), scrimFor(HEIGHT, HEIGHT));
  assert.ok(scrimFor(HEIGHT, HEIGHT) > 0, "the page behind never returns to full contrast");

  // Monotonic in between, so the scrim reverses when the hand does.
  assert.ok(scrimFor(200, HEIGHT) < scrimFor(100, HEIGHT));
});
