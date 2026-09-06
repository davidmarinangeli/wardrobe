// The physics of a thrown card, kept apart from the pointer plumbing that uses
// it (src/hooks/useDeckGesture.js) so the rules that decide a swipe can be
// stated as arithmetic and tested as arithmetic. What counts as a decision is
// product behaviour, not an implementation detail of an event handler.

// Fraction of the deck's width the *projected* resting point has to cross to
// count as a decision. Applied to the projection rather than to the raw
// distance is the whole trick: it is what makes a short fast flick commit and a
// long slow crawl not.
export const COMMIT_RATIO = 0.28;

// Apple's scroll-deceleration constant, from the Designing Fluid Interfaces
// sample code. 0.998 is the iOS scroll feel; a card deck wants to settle sooner
// than a scroll view does, so this is tightened.
export const DECELERATION = 0.995;

// Progressive resistance constant. Higher is looser.
export const RUBBERBAND = 0.55;

/**
 * Where a throw comes to rest, given the velocity it was released at.
 *
 * This is the exponential-decay form Apple actually ships, NOT the
 * physics-textbook v²/2a. The two disagree substantially — the textbook form
 * is quadratic in velocity and overshoots wildly on a hard flick — and the
 * exponential one is what is in everything that feels right.
 *
 * @param {number} velocity      px per millisecond, signed.
 * @param {number} deceleration  0–1, closer to 1 travels further.
 * @returns {number} signed distance, in px, still to travel.
 */
export function project(velocity, deceleration = DECELERATION) {
  return velocity * (deceleration / (1 - deceleration));
}

/**
 * Progressive resistance past a boundary: the further you drag beyond it, the
 * less the element follows. A hard stop reads as frozen; this reads as
 * responsive, but there's nothing more this way.
 *
 * @param {number} overshoot  px past the boundary, signed.
 * @param {number} dimension  the element's size along that axis.
 * @returns {number} the damped offset to actually apply.
 */
export function rubberband(overshoot, dimension, constant = RUBBERBAND) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Does releasing here answer the card, and which way?
 *
 * Decided from where the throw is going, not from where the finger let go.
 *
 * @param {number} dx        px travelled, signed.
 * @param {number} velocity  px per millisecond at release, signed.
 * @param {number} width     deck width in px.
 * @returns {"like"|"pass"|null} null means it springs home.
 */
export function verdictFor(dx, velocity, width) {
  const projected = dx + project(velocity);
  if (Math.abs(projected) <= width * COMMIT_RATIO) return null;
  return projected > 0 ? "like" : "pass";
}
