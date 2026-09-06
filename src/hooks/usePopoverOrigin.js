import { useCallback } from "react";

// How much of the distance to the trigger the panel actually travels, and the
// hard ceiling on it. A correct transform-origin already does most of the work
// of "this came out of that"; the translate is a small extra nudge in the
// trigger's direction, kept short so the whole move stays well inside the
// 300ms/short-distance bar the repo's animation standards set.
const TRAVEL_FRACTION = 0.06;
const TRAVEL_MAX = 24;

// The identity block starts life the size of the chip's own label. Below this
// the type is scaled so far down that even the blur mask can't hide the
// interpolation, so it's clamped and the last of the gap is covered by fade.
const IDENTITY_MIN_SCALE = 0.3;

const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

/**
 * Makes a centered popover grow out of the button that opened it, and — when a
 * third ref is given — makes the panel's identity block (icon + title) start
 * life sitting exactly on the chip, so one element becomes the other instead of
 * one fading over the other.
 *
 * Both top-bar popovers used to hardcode a viewport-unit translate from a
 * bottom corner — geometry left over from when their triggers were floating
 * docks. The triggers are pills in the top bar now, so the panels visibly flew
 * in from corners where nothing exists. Per .claude/skills/animate (RECIPES.md)
 * and review-animations/STANDARDS.md, a trigger-anchored popover scales from
 * its trigger; only modals are exempt.
 *
 * Returns a function to call immediately BEFORE opening. It measures where the
 * panel is about to come to rest and writes --origin-x/y (its transform-origin)
 * and --travel-x/y (the small nudge) onto the panel. Measuring on every open,
 * rather than once on mount, is what keeps the origin right after a resize or
 * after the trigger relabels itself and changes width.
 *
 * The panel's resting position is derived from the viewport center rather than
 * read back with getBoundingClientRect: while closed the panel still carries
 * its closed transform, so its rect is the scaled one, not where it lands.
 * offsetWidth/offsetHeight are layout metrics and ignore transforms, and the
 * backdrop centers the panel with symmetric padding — so the panel's resting
 * center is the viewport's center. The identity block can't be derived that way
 * — it sits inside the panel's own padding — so it is measured directly, with
 * both transforms momentarily off.
 *
 * @param {{current: HTMLElement|null}} triggerRef  - the button that opens it.
 * @param {{current: HTMLElement|null}} panelRef    - the popover itself.
 * @param {{current: HTMLElement|null}} [identityRef] - the panel's icon+title
 *   block, if it should morph out of the chip rather than simply appear.
 */
export function usePopoverOrigin(triggerRef, panelRef, identityRef) {
  return useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    // No layout to measure against — a display:none ancestor, or a window with
    // no size (a hidden tab reports 0). Leave the vars alone so the panel falls
    // back to its 50%/50% default instead of taking a garbage origin.
    if (!panel.offsetWidth || !window.innerWidth) return;

    const triggerBox = trigger.getBoundingClientRect();
    const triggerX = triggerBox.left + triggerBox.width / 2;
    const triggerY = triggerBox.top + triggerBox.height / 2;

    const viewportX = window.innerWidth / 2;
    const viewportY = window.innerHeight / 2;
    const restingLeft = viewportX - panel.offsetWidth / 2;
    const restingTop = viewportY - panel.offsetHeight / 2;

    panel.style.setProperty("--origin-x", `${Math.round(triggerX - restingLeft)}px`);
    panel.style.setProperty("--origin-y", `${Math.round(triggerY - restingTop)}px`);
    panel.style.setProperty("--travel-x", `${Math.round(clamp((triggerX - viewportX) * TRAVEL_FRACTION, TRAVEL_MAX))}px`);
    panel.style.setProperty("--travel-y", `${Math.round(clamp((triggerY - viewportY) * TRAVEL_FRACTION, TRAVEL_MAX))}px`);

    const identity = identityRef?.current;
    if (!identity || !identity.offsetHeight) return;

    // Where the identity block actually comes to rest. Predicting this from
    // layout offsets is doable but fiddly and quietly wrong by a dozen pixels
    // when an ancestor's padding lands on the wrong side of an offsetParent
    // boundary. Measuring it is exact: neutralise the panel's closed transform,
    // read the rect, put it back. All three happen in one task, before the
    // browser gets a chance to paint, so nothing flashes — the cost is a single
    // forced reflow per open, which is the same thing getBoundingClientRect on
    // the trigger already cost us above.
    // Both transforms have to come off: the panel's closed scale, and the
    // identity's own leftover offset from the previous open — measuring through
    // that would compound the last measurement into this one and walk the block
    // further off the chip on every open.
    const panelTransform = panel.style.transform;
    const identityTransform = identity.style.transform;
    panel.style.transform = "none";
    identity.style.transform = "none";
    const identityBox = identity.getBoundingClientRect();
    panel.style.transform = panelTransform;
    identity.style.transform = identityTransform;

    // transform-origin is left center on the identity block, so the two points
    // to reconcile are the left-center of the block and the left edge of the
    // chip's content box — i.e. just inside its horizontal padding.
    const restingX = identityBox.left;
    const restingY = identityBox.top + identityBox.height / 2;

    const padLeft = parseFloat(getComputedStyle(trigger).paddingLeft) || 0;
    const chipX = triggerBox.left + padLeft;
    const chipY = triggerBox.top + triggerBox.height / 2;

    // Match the chip's cap height, not its full pill height — the pill is mostly
    // padding, and scaling the title to the padded box overshoots badly.
    const scale = Math.max(IDENTITY_MIN_SCALE, (triggerBox.height * 0.42) / identityBox.height);

    panel.style.setProperty("--identity-dx", `${Math.round(chipX - restingX)}px`);
    panel.style.setProperty("--identity-dy", `${Math.round(chipY - restingY)}px`);
    panel.style.setProperty("--identity-scale", scale.toFixed(3));
  }, [triggerRef, panelRef, identityRef]);
}
