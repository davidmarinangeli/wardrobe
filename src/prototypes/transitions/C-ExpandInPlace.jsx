import { useCallback, useState } from "react";
import { ProtoGrid, ProtoViewer, useWardrobe } from "./shared.jsx";

/**
 * C — Expand in place, no drawer.
 *
 * The card is the origin and the panel grows out of it, exactly the way the two
 * top-bar popovers now do — one mechanism for "this opened out of that" across
 * the whole app instead of a drawer here and a popover there.
 *
 * Nothing is measured beyond the card's own rect, nothing is cloned, and the
 * spatial claim is honest: the panel came from the card and returns to it. What
 * it gives up is the garment itself morphing — the image does not travel, the
 * container does. Whether that reads as enough is the question.
 */
export function ExpandInPlaceVariant() {
  const items = useWardrobe();
  const [active, setActive] = useState(null);
  const [origin, setOrigin] = useState(null);

  const open = useCallback((item, cardEl) => {
    const box = cardEl.getBoundingClientRect();
    setOrigin({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    });
    setActive(item);
  }, []);

  return (
    <div className="proto-transition-stage" data-expand-in-place>
      <ProtoGrid items={items} onOpen={open} />
      <ProtoViewer
        item={active}
        onClose={() => setActive(null)}
        entryProps={{
          className: "viewer-entry proto-expand-entry",
          style: origin ? { "--card-x": `${origin.x}px`, "--card-y": `${origin.y}px` } : undefined,
        }}
      />
    </div>
  );
}
