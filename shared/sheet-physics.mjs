// The physics of a sheet being pushed off the bottom of the screen, kept apart
// from the pointer plumbing that uses it (src/hooks/useSheetGesture.js) for the
// same reason deck-physics.mjs is: what counts as "you dismissed this" is
// product behaviour, and product behaviour should be arithmetic you can test.
//
// This imports from deck-physics rather than extending it. The two answer
// different questions. A card is thrown left or right and the verdict is which;
// a sheet only ever leaves downward, and its resting position is a floor it
// cannot pass going the other way. Sharing `project` and `rubberband` keeps the
// two surfaces feeling like the same hand made them, without pretending a
// one-directional gesture is a two-sided one.

import { project, rubberband } from "./deck-physics.mjs";

// px per millisecond. Straight from review-animations/STANDARDS.md: "compute
// velocity and dismiss if > ~0.11. A flick should be enough." The point of a
// velocity rule is that it fires *instead of* a distance rule, not after it —
// requiring both is what makes drawers feel like they're arguing with you.
export const DISMISS_VELOCITY = 0.11;

// Fraction of the sheet's own height the projected resting point must pass for
// a slow drag to count. Deliberately lower than the deck's 0.28: a sheet is
// pushed with the whole hand rather than flicked with a thumb, and the distance
// available is the sheet's height rather than the screen's width.
export const DISMISS_RATIO = 0.4;

// How far the scrim fades as the sheet descends. Not to zero — the sheet is
// still on screen at full travel, and a scrim that vanishes early makes the
// page behind snap back to full contrast while something is still covering it.
const SCRIM_FADE = 0.85;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * How far the sheet actually moves, given how far the finger did.
 *
 * Downward is where the sheet is allowed to go, so it tracks 1:1 — anything
 * less and the sheet lags the hand that is pushing it. Upward is a boundary,
 * and boundaries in this app resist rather than stop dead: you can lift a sheet
 * a little past its resting position and feel it push back.
 *
 * @param {number} dy      px the pointer travelled, signed. Positive is down.
 * @param {number} height  the sheet's height, the dimension resistance scales to.
 * @returns {number} the offset to apply, in px.
 */
export function sheetOffset(dy, height) {
  return dy <= 0 ? rubberband(dy, height) : dy;
}

/**
 * Does releasing here dismiss the sheet?
 *
 * Two independent ways to say yes, which is the whole design: a fast flick from
 * almost nowhere, or a deliberate push most of the way down. Requiring both
 * would mean a flick doesn't work, and that is the exact failure the standards
 * call out.
 *
 * The `dy > 0` guard on the velocity rule is not decoration. Without it, lifting
 * the sheet upward and releasing as it springs back — moving downward, fast,
 * while still *above* its resting position — reads as a dismissal. It isn't;
 * it's the rubber band doing its job.
 *
 * @param {number} dy        px travelled, signed. Positive is down.
 * @param {number} velocity  px per millisecond at release, signed.
 * @param {number} height    the sheet's height in px.
 * @returns {boolean}
 */
export function shouldDismiss(dy, velocity, height) {
  if (velocity > DISMISS_VELOCITY && dy > 0) return true;
  return dy + project(velocity) > height * DISMISS_RATIO;
}

/**
 * Scrim opacity for a given drag position, as a multiplier on its resting value.
 *
 * The page behind coming back as you push the sheet away is what makes the
 * gesture feel like it is moving a real object rather than playing an animation
 * at the end. Tied to position, not to time, so it reverses when the hand does.
 *
 * @param {number} dy      px travelled, signed.
 * @param {number} height  the sheet's height in px.
 * @returns {number} 0–1.
 */
export function scrimFor(dy, height) {
  return 1 - SCRIM_FADE * clamp01(dy / height);
}
