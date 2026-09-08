import { useRef, useState } from "react";
import { useWardrobe, ProtoGrid } from "../transitions/shared.jsx";
import { ProtoHeader, ProtoNav, ProtoActionBar, useChromeScroll } from "./shared.jsx";

/**
 * The chrome as a whole: navigation, contextual actions, and how both behave
 * once you start scrolling.
 *
 * Three things are being judged here at once, because they are not separable —
 * they share the bottom of the screen.
 *
 * 1. Whether the sliding pill earns itself. Tab switching is a
 *    tens-of-times-a-day interaction, which review-animations/STANDARDS.md puts
 *    in the "remove or drastically reduce" band, so the pill has to be doing
 *    real work. The competing answer is that the Phosphor weight swap
 *    (regular → fill) plus the colour change already says everything and never
 *    slides the wrong way when you skip a tab.
 * 2. Whether splitting actions out of the nav reads correctly — switch tabs and
 *    watch the action bar relabel while the nav stays put.
 * 3. Whether the shrink-on-scroll is the right amount. Scroll down: the labels
 *    collapse and the action bar leaves. Scroll back up: the actions return.
 */
export function NavPillVariant() {
  const items = useWardrobe(14);
  const [view, setView] = useState("wardrobe");
  const [indicator, setIndicator] = useState("pill");
  const navRef = useRef(null);
  const actionRef = useRef(null);
  useChromeScroll(navRef, actionRef);

  return (
    <div className="proto-mobile">
      <ProtoHeader
        title={labelFor(view)}
        subtitle={(
          <button type="button" className="proto-toggle" onClick={() => setIndicator((current) => (current === "pill" ? "weight" : "pill"))}>
            {indicator === "pill" ? "Sliding pill ⇄" : "Weight only ⇄"}
          </button>
        )}
      />

      <ProtoGrid items={items} onOpen={() => {}} />

      <ProtoActionBar view={view} barRef={actionRef} onAction={() => {}} />
      <ProtoNav active={view} onSelect={setView} indicator={indicator} navRef={navRef} />
    </div>
  );
}

const labelFor = (id) => id.charAt(0).toUpperCase() + id.slice(1);
