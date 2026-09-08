import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TShirt, CoatHanger, Images, Gear, Plus, Sparkle, Lightbulb } from "@phosphor-icons/react";
import { OptimizedImage } from "../../OptimizedImage.jsx";
import { useGlassSurface } from "../../hooks/useGlassSurface.js";
import { GlassFilter } from "../../components/GlassFilter.jsx";
import { useSheetGesture } from "../../hooks/useSheetGesture.js";
import { shouldDismiss, DISMISS_RATIO } from "../../../shared/sheet-physics.mjs";

const SCROLL_FILLER = [
  "Scroll down from here. Once the scroller has left the top, a downward drag is the scroller's and the sheet must not move an inch — the claim is decided at the moment the axis resolves and is never handed back mid-gesture.",
  "The grab handle at the top is different: it opts out of browser panning entirely, so a drag started there always moves the sheet even when this text is scrolled half way down.",
  "Then scroll back to the very top and try dragging the body again. It should dismiss. The difference between those two gestures is one number read at pointerdown.",
  "Notice also that the scrim behind lightens as the sheet descends, and darkens again if you push it back up. It is tied to position rather than to elapsed time, which is why it reverses when your thumb does.",
  "The last thing worth checking is interruption: dismiss the sheet and grab it again while it is still travelling. It should come back under your finger from wherever it had got to, not snap to the top first.",
];

export const NAV_VIEWS = [
  { id: "wardrobe", label: "Wardrobe", Icon: TShirt },
  { id: "outfits", label: "Outfits", Icon: CoatHanger },
  { id: "inspo", label: "Inspo", Icon: Images },
];

/**
 * What each view can actually do, named.
 *
 * The centre + had to go. One control that adds a garment on Wardrobe, an
 * outfit on Outfits and a pin on Inspo is three different actions wearing the
 * same icon, which is precisely the thing a user cannot learn — and putting it
 * inside the nav also implied it was a destination, which it never was. It also
 * left nowhere for the second CTA, so Mirror and Suggest-outfit fell off the
 * phone entirely.
 *
 * So: navigation and action are now separate objects. The bar below is only
 * ever navigation, identical on every screen; actions live in their own bar
 * with their real names on them.
 */
export const VIEW_ACTIONS = {
  wardrobe: {
    secondary: { id: "mirror", label: "How do I look?", Icon: Sparkle },
    primary: { id: "add-garment", label: "Add clothes", Icon: Plus },
  },
  outfits: {
    secondary: { id: "suggest", label: "Suggest outfit", Icon: Lightbulb },
    primary: { id: "add-outfit", label: "New outfit", Icon: Plus },
  },
  inspo: {
    secondary: { id: "mirror", label: "How do I look?", Icon: Sparkle },
    primary: { id: "add-inspo", label: "Add inspo", Icon: Plus },
  },
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * Large title in the content, compact glass bar taking over as it scrolls away.
 *
 * The bar tracks scroll position continuously rather than flipping at a
 * threshold — same rule as the sheet tracking a finger. It arrives on opacity
 * and scale together rather than opacity alone, so it still reads as a surface
 * moving into place. It used to animate its blur radius as well, which meant
 * re-blurring the whole strip on every scrolled frame — the single most
 * expensive thing on the page, and the reason this janked on Android.
 *
 * Written straight to the two nodes from a passive scroll listener. Routing a
 * scroll position through React state re-renders the page on every frame of
 * every scroll, which is the most expensive way to move two elements.
 */
export function ProtoHeader({ title, subtitle, onSettings, refracted = false }) {
  const largeRef = useRef(null);
  const barRef = useRef(null);
  // The compact bar is the other surface content genuinely passes under, and it
  // is small. Same budget as the nav.
  const glass = useGlassSurface({ enabled: refracted, strength: 12, depth: 8 });

  useEffect(() => {
    const large = largeRef.current;
    const bar = barRef.current;
    if (!large || !bar) return undefined;

    const paint = () => {
      const t = clamp01((window.scrollY - 8) / 48);
      bar.style.opacity = t.toFixed(3);
      bar.style.transform = `scale(${(0.965 + t * 0.035).toFixed(4)})`;
      large.style.opacity = (1 - t).toFixed(3);
    };

    paint();
    window.addEventListener("scroll", paint, { passive: true });
    return () => window.removeEventListener("scroll", paint);
  }, []);

  return (
    <>
      {refracted && <GlassFilter svg={glass.svg} />}
      <div className="proto-compactbar" ref={barRef} data-refracted={String(refracted)} aria-hidden="true">
        {/* The glass goes on an inner layer, not on .proto-compactbar itself:
            the outer element's opacity and scale are written per frame by the
            scroll handler, and a backdrop-filter on an element whose opacity is
            animating is re-composited every one of those frames. */}
        <span className="proto-compactbar__material" ref={glass.ref} style={glass.style} aria-hidden="true" />
        <span className="proto-compactbar__title">{title}</span>
      </div>
      {/* Settings sits in the top bar next to the title, on the page gutter,
          and scrolls away with it. It is not a destination — it does not belong
          among the tabs — but it is also not urgent enough to pin to the
          viewport and cover content for the whole session. */}
      <div className="proto-headrow">
        <h1 className="proto-largetitle" ref={largeRef}>{title}</h1>
        <button type="button" className="proto-settings" onClick={onSettings} aria-label="Settings">
          <Gear size={19} aria-hidden="true" />
        </button>
      </div>
      {subtitle && <div className="proto-subtitle">{subtitle}</div>}
    </>
  );
}

/**
 * Chrome that gets out of the way as you read.
 *
 * Two behaviours, deliberately driven by different signals:
 *
 * The nav *shrinks* on scroll position — past a threshold it drops its labels
 * and loses height — and it is driven by position rather than direction so it
 * cannot flip-flop while you jiggle. It never leaves. review-animations
 * STANDARDS.md puts navigation in the "tens of times a day" band, where motion
 * should be reduced rather than added, and hiding it outright would move every
 * tap target on the screen out from under the thumb that was aiming at it.
 *
 * The action bar *hides* on scroll direction — down conceals, up reveals —
 * because it is secondary, occasional, and genuinely worth trading for reading
 * room. Costing a scroll-up to recover is a fair price for an occasional
 * control; it would not be for navigation.
 *
 * Written straight to the nodes from a passive listener, never through state.
 */
export function useChromeScroll(navRef, actionRef) {
  useEffect(() => {
    let lastY = window.scrollY;
    let compact = false;
    let hidden = false;

    const paint = () => {
      const y = window.scrollY;
      const delta = y - lastY;
      const nav = navRef.current;
      const action = actionRef?.current;

      // Asymmetric on purpose: contracting is something the interface does to
      // get out of your way, expanding is a response to you asking for it back.
      // So compacting waits until you are past the threshold and still heading
      // down, while any upward movement at all expands it immediately — you
      // should never have to scroll up a measured distance to get the labels
      // back. Same reason a scroll-to-top gesture feels instant on iOS.
      let nextCompact = compact;
      if (y <= 40) nextCompact = false;
      else if (delta < -2) nextCompact = false;
      else if (delta > 2) nextCompact = true;

      if (nextCompact !== compact && nav) {
        compact = nextCompact;
        nav.dataset.compact = String(compact);
      }

      // The action bar is a coarser decision — it leaves entirely — so it keeps
      // a dead band, or a 2px tremor at the top of a flick would flap it.
      if (action && Math.abs(delta) > 6) {
        const nextHidden = delta > 0 && y > 60;
        if (nextHidden !== hidden) {
          hidden = nextHidden;
          action.dataset.hidden = String(hidden);
        }
      }

      if (Math.abs(delta) > 2) lastY = y;
    };

    paint();
    window.addEventListener("scroll", paint, { passive: true });
    return () => window.removeEventListener("scroll", paint);
  }, [navRef, actionRef]);
}

/**
 * The per-view action bar: the app's two real CTAs, with their real names.
 *
 * Sits above the nav rather than inside it, so a control that changes meaning
 * between screens is never mistaken for one that doesn't.
 */
export function ProtoActionBar({ view, onAction, barRef, refracted = false }) {
  const actions = VIEW_ACTIONS[view] ?? VIEW_ACTIONS.wardrobe;
  // The secondary CTA is the one that earns glass: it is small, it floats over
  // the scrolling grid, and it is the app's "ask the AI" moment — the one place
  // docs/design-references.md already reserves a richer treatment for. The
  // primary stays solid accent; refraction through an opaque fill shows
  // nothing, and the CTA should read as the most solid thing on screen.
  const glass = useGlassSurface({ enabled: refracted, strength: 13, depth: 9 });

  return (
    <div className="proto-actionbar" ref={barRef} data-hidden="false">
      {refracted && <GlassFilter svg={glass.svg} />}
      {actions.secondary && (
        <button
          type="button"
          className="proto-actionbar__btn proto-actionbar__btn--secondary"
          data-refracted={String(refracted)}
          ref={glass.ref}
          style={glass.style}
          onClick={() => onAction?.(actions.secondary.id)}
        >
          <actions.secondary.Icon size={17} weight="bold" aria-hidden="true" />
          <span>{actions.secondary.label}</span>
        </button>
      )}
      <button
        type="button"
        className="proto-actionbar__btn proto-actionbar__btn--primary"
        onClick={() => onAction?.(actions.primary.id)}
      >
        <actions.primary.Icon size={17} weight="bold" aria-hidden="true" />
        <span>{actions.primary.label}</span>
      </button>
    </div>
  );
}

export function ProtoNav({ active, onSelect, indicator = "pill", navRef: externalRef, lens = false, refracted = null }) {
  const localRef = useRef(null);
  const navRef = externalRef ?? localRef;
  const pillRef = useRef(null);

  // Measured, not computed from an index: the slots are 1fr but the Add column
  // is auto, so the tabs either side of it are not evenly spaced and arithmetic
  // would quietly be wrong by the Add button's width.
  //
  // This has to be a layout effect keyed on `active`, not a ref callback — a
  // ref callback fires on mount and on unmount, never on a prop change, so the
  // pill would take a width once and then sit still for the rest of the
  // session. (It did exactly that, which is what a prototype is for.)
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return undefined;

    const movePill = () => {
      const tab = nav.querySelector(`[data-tab="${active}"]`);
      if (!tab) return;
      pill.style.width = `${tab.offsetWidth}px`;
      pill.style.transform = `translate(${tab.offsetLeft}px, -50%)`;
    };

    movePill();
    window.addEventListener("resize", movePill);

    // The bar contracts on both axes when it compacts, over 260ms. A one-off
    // measurement strands the pill at the expanded width for all of it.
    //
    // Two observers, because they fail in different conditions. ResizeObserver
    // tracks the transition frame by frame, but its callbacks are delivered
    // before paint — in a tab that is not compositing, they may not arrive at
    // all. The MutationObserver on data-compact is delivered on the microtask
    // queue regardless of paint, so the pill still lands in the right place
    // even when the frame loop is throttled. Cheap enough to keep both.
    const resize = new ResizeObserver(movePill);
    resize.observe(nav);
    const mutation = new MutationObserver(movePill);
    mutation.observe(nav, { attributes: true, attributeFilter: ["data-compact"] });

    return () => {
      window.removeEventListener("resize", movePill);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [active]);

  return (
    <nav
      className="proto-nav"
      ref={navRef}
      data-indicator={indicator}
      data-compact="false"
      data-lens={String(lens)}
      data-refracted={String(!!refracted)}
      // Composed rather than set in CSS: the blur is the same on every variant,
      // but only this one has a displacement filter to append, and the filter's
      // id is generated at runtime.
      style={refracted ? { backdropFilter: `blur(10px) url(#${refracted})`, WebkitBackdropFilter: `blur(10px)` } : undefined}
      aria-label="Sections"
    >
      <span className="proto-nav__pill" ref={pillRef} aria-hidden="true" />
      {NAV_VIEWS.map((view) => (
        <NavTab key={view.id} view={view} active={active} onSelect={onSelect} />
      ))}
    </nav>
  );
}

function NavTab({ view, active, onSelect }) {
  const isActive = view.id === active;
  return (
    <button
      type="button"
      className="proto-nav__tab"
      data-tab={view.id}
      aria-current={isActive ? "page" : undefined}
      onClick={() => onSelect(view.id)}
    >
      <view.Icon size={21} weight={isActive ? "fill" : "regular"} aria-hidden="true" />
      {/* The 1fr→0fr grid collapse: the label genuinely reflows to nothing
          instead of being faked with a magic height, and it interpolates. */}
      <span className="proto-nav__labelwrap">
        <span className="proto-nav__label">{view.label}</span>
      </span>
    </button>
  );
}

/**
 * The sheet under test, wired to the real hook and the real physics module.
 *
 * A prototype that reimplements the gesture proves nothing about the gesture
 * that will ship. The only thing local to this file is the readout.
 */
export function ProtoSheet({ item, onClose, onDrag }) {
  const sheetRef = useRef(null);
  const overlayRef = useRef(null);
  const { dragHandlers } = useSheetGesture({
    sheetRef,
    overlayRef,
    enabled: true,
    onDismiss: onClose,
  });

  // The page behind must not scroll under an open sheet — without this the
  // whole document moves when the gesture is handed back to the browser, and
  // a drag at the top of it reaches pull-to-refresh.
  const isOpen = !!item;
  useEffect(() => {
    if (!isOpen) return undefined;
    document.body.classList.add("proto-sheet-open");
    return () => document.body.classList.remove("proto-sheet-open");
  }, [isOpen]);

  // Wrap the pointer handlers to publish the live numbers, without putting the
  // readout's state anywhere the gesture has to pay for it per frame.
  const instrumented = {
    ...dragHandlers,
    onPointerMove: (event) => {
      dragHandlers.onPointerMove(event);
      onDrag?.(event, sheetRef.current);
    },
    onPointerUp: (event) => {
      dragHandlers.onPointerUp(event);
      onDrag?.(null);
    },
    onPointerCancel: (event) => {
      dragHandlers.onPointerCancel(event);
      onDrag?.(null);
    },
  };

  if (!item) return null;

  return (
    <div
      className="proto-sheet-overlay"
      ref={overlayRef}
      role="presentation"
      // pointerdown, not mousedown. On touch the browser replays a synthetic
      // mousedown at the release point after the gesture — which landed on the
      // overlay once the sheet had moved out from under the finger, dismissing
      // it, and then ghost-clicked the card underneath and reopened it. That
      // was the "closes and reopens" behaviour.
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="proto-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label={item.name || "Garment"} {...instrumented}>
        <div className="proto-sheet__grabhandle" data-sheet-grab>
          <span className="proto-sheet__grabber" aria-hidden="true" />
        </div>
        <div className="proto-sheet__art">
          <OptimizedImage src={item.image || item.thumbnail} alt={item.name || ""} sizes="90vw" />
        </div>
        <h2 className="proto-sheet__title">{item.name || "Untitled"}</h2>
        <p className="proto-sheet__meta">{item.part || "piece"}</p>
        <p className="proto-sheet__filler">
          The bar is a flick over <b>0.11 px/ms</b>, or a push past{" "}
          <b>{Math.round(DISMISS_RATIO * 100)}%</b> of the sheet&rsquo;s own height. Either
          one alone is enough.
        </p>
        {/* The sheet has to genuinely overflow, or the hardest case in the whole
            gesture — a downward drag that belongs to the scroller rather than to
            the sheet — cannot be tried at all. A prototype that fits on one
            screen quietly tests the easy half. */}
        {SCROLL_FILLER.map((line, index) => (
          <p className="proto-sheet__filler" key={index}>{line}</p>
        ))}
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </aside>
    </div>
  );
}

/**
 * Rolling frame rate, so "it lags" becomes a number.
 *
 * Reads worst-frame as well as the mean: an average of 55 hides a scroll that
 * drops one frame in six, and the dropped frame is the thing you feel. Costs a
 * rAF loop and one text write every 250ms, which is far below what it measures.
 */
export function FpsMeter() {
  const valueRef = useRef(null);

  useEffect(() => {
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let windowStart = last;
    let raf = 0;

    const tick = (now) => {
      const delta = now - last;
      last = now;
      frames += 1;
      if (delta > worst) worst = delta;

      if (now - windowStart >= 250) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        const node = valueRef.current;
        if (node) {
          node.textContent = `${fps} fps · worst ${Math.round(worst)}ms`;
          node.dataset.level = fps >= 55 ? "good" : fps >= 40 ? "ok" : "bad";
        }
        frames = 0;
        worst = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div className="proto-fps" ref={valueRef} data-level="good">measuring…</div>;
}

/** Live gesture numbers. Tuning constants by feel alone is guesswork. */
export function useReadout() {
  const [state, setState] = useState(null);
  const last = useRef(null);

  const onDrag = (event, sheet) => {
    if (!event || !sheet) { last.current = null; setState(null); return; }
    const now = { y: event.clientY, t: event.timeStamp };
    const previous = last.current;
    last.current = now;
    if (!previous) return;
    const elapsed = now.t - previous.t;
    const velocity = elapsed > 0 ? (now.y - previous.y) / elapsed : 0;
    const dy = sheet.getBoundingClientRect().top - (window.innerHeight - sheet.offsetHeight);
    setState({ dy, velocity, leaves: shouldDismiss(dy, velocity, sheet.offsetHeight || 1) });
  };

  const readout = state ? (
    <div className="proto-readout">
      <span>dy <b>{Math.round(state.dy)}</b></span>
      <span>v <b>{state.velocity.toFixed(2)}</b></span>
      <span data-verdict={state.leaves ? "leave" : "stay"}>
        <b>{state.leaves ? "LEAVE" : "STAY"}</b>
      </span>
    </div>
  ) : null;

  return { onDrag, readout };
}
