import { useLayoutEffect, useRef } from "react";
import { TShirt, CoatHanger, Images } from "@phosphor-icons/react";
import { useGlassSurface } from "../hooks/useGlassSurface.js";
import { GlassFilter } from "./GlassFilter.jsx";

/**
 * The app's three destinations, as a floating glass bar on phones.
 *
 * Navigation only. No action lives in here: an "add" control that adds a
 * garment on Wardrobe, an outfit on Outfits and a pin on Inspo is three
 * different actions wearing one icon, and putting it among the tabs implies it
 * is a fourth destination. Actions stay in the top bar, which mobile CSS
 * repositions into a floating row above this one. Settings likewise — it is
 * always-available, not somewhere you go.
 *
 * Hidden above the mobile breakpoint by CSS; the desktop `.app-view-switch`
 * keeps its place there.
 *
 * @param {object} props
 * @param {"wardrobe"|"outfits"|"inspo"} props.view
 * @param {(view: string) => void} props.onSelect
 * @param {{current: HTMLElement|null}} [props.navRef]  For useChromeScroll.
 */
const VIEWS = [
  { id: "wardrobe", label: "Wardrobe", Icon: TShirt },
  { id: "outfits", label: "Outfits", Icon: CoatHanger },
  { id: "inspo", label: "Inspo", Icon: Images },
];

export function BottomNav({ view, onSelect, navRef: externalRef }) {
  const localRef = useRef(null);
  const navRef = externalRef ?? localRef;
  const pillRef = useRef(null);
  const glass = useGlassSurface({ blur: 10, strength: 16, depth: 11 });

  // Measured rather than computed from the active index: the bar contracts when
  // it compacts, so any arithmetic would be right at one size and wrong at the
  // other. Keyed on `view` because a ref callback fires on mount and unmount
  // but never on a prop change, which would freeze the pill after first paint.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return undefined;

    const movePill = () => {
      const tab = nav.querySelector(`[data-tab="${view}"]`);
      if (!tab) return;
      pill.style.width = `${tab.offsetWidth}px`;
      pill.style.transform = `translate(${tab.offsetLeft}px, -50%)`;
    };

    movePill();
    window.addEventListener("resize", movePill);

    // Two observers because they fail in different conditions: ResizeObserver
    // follows the contraction frame by frame but is delivered before paint, so
    // a throttled tab may never get it; the MutationObserver on data-compact
    // arrives on the microtask queue regardless.
    const resize = new ResizeObserver(movePill);
    resize.observe(nav);
    const mutation = new MutationObserver(movePill);
    mutation.observe(nav, { attributes: true, attributeFilter: ["data-compact"] });

    return () => {
      window.removeEventListener("resize", movePill);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [view, navRef]);

  return (
    <>
      <GlassFilter svg={glass.svg} />
      <nav
        className="bottom-nav"
        ref={(node) => {
          navRef.current = node;
          glass.ref.current = node;
        }}
        style={glass.style}
        data-compact="false"
        aria-label="Switch between wardrobe, outfits, and inspo"
      >
        <span className="bottom-nav__pill" ref={pillRef} aria-hidden="true" />
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="bottom-nav__tab"
            data-tab={id}
            aria-current={id === view ? "page" : undefined}
            aria-pressed={id === view}
            onClick={() => onSelect(id)}
          >
            <Icon size={21} weight={id === view ? "fill" : "regular"} aria-hidden="true" />
            {/* 1fr → 0fr collapses to a genuine zero and interpolates, without
                inventing a height for the label. */}
            <span className="bottom-nav__labelwrap">
              <span className="bottom-nav__label">{label}</span>
            </span>
          </button>
        ))}
      </nav>
    </>
  );
}
