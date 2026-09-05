import { useCallback, useRef, useState } from "react";
import { animate } from "motion";
import { ProtoGrid, ProtoViewer, useWardrobe } from "./shared.jsx";

/**
 * B — FLIP clone.
 *
 * Measure the card, put a copy of its image on a fixed layer, animate that copy
 * to where the viewer's hero will be, then drop it. Works in every browser,
 * runs on a spring, is interruptible, and the thing that moves is genuinely one
 * element rather than a cross-fade of two snapshots.
 *
 * The price is that it is real machinery: a clone to build and reliably tear
 * down, a destination that has to be known before it exists, and a decode that
 * may not have finished on either end. This is the variant that will be
 * correct — the question the prototype answers is whether it is worth it.
 */
export function FlipCloneVariant() {
  const items = useWardrobe();
  const [active, setActive] = useState(null);
  const cloneRef = useRef(null);

  const open = useCallback((item, cardEl) => {
    const source = cardEl.querySelector("img");
    if (!source) { setActive(item); return; }
    const from = source.getBoundingClientRect();

    const clone = source.cloneNode(true);
    Object.assign(clone.style, {
      position: "fixed",
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      objectFit: "contain",
      margin: 0,
      zIndex: 60,
      pointerEvents: "none",
      filter: "var(--shadow-contact)",
    });
    document.body.appendChild(clone);
    cloneRef.current = clone;
    setActive(item);

    // The destination only exists once the viewer has rendered, so the read has
    // to wait a frame. Two rAFs: one for React to commit, one for layout.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.querySelector(".viewer-art img");
      if (!target) { clone.remove(); return; }
      const to = target.getBoundingClientRect();
      target.style.opacity = "0";

      const spring = { type: "spring", bounce: 0.12, duration: 0.44 };
      animate(from.left, to.left, { ...spring, onUpdate: (v) => { clone.style.left = `${v}px`; } });
      animate(from.top, to.top, { ...spring, onUpdate: (v) => { clone.style.top = `${v}px`; } });
      animate(from.width, to.width, { ...spring, onUpdate: (v) => { clone.style.width = `${v}px`; } });
      animate(from.height, to.height, {
        ...spring,
        onUpdate: (v) => { clone.style.height = `${v}px`; },
        onComplete: () => { target.style.opacity = ""; clone.remove(); cloneRef.current = null; },
      });
    }));
  }, []);

  const close = useCallback(() => {
    cloneRef.current?.remove();
    cloneRef.current = null;
    setActive(null);
  }, []);

  return (
    <div className="proto-transition-stage">
      <ProtoGrid items={items} onOpen={open} />
      <ProtoViewer item={active} onClose={close} />
    </div>
  );
}
