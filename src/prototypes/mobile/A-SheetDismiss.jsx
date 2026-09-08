import { useState } from "react";
import { useWardrobe, ProtoGrid } from "../transitions/shared.jsx";
import { ProtoHeader, ProtoNav, ProtoSheet, useReadout } from "./shared.jsx";

/**
 * The gesture on its own, with nothing else moving.
 *
 * This is the variant that answers the only question that cannot be answered
 * from a diff: does the sheet feel like an object you are pushing, or like an
 * animation you are triggering. Everything else in this folder is a garnish on
 * top of whatever this establishes — so if this one is wrong, none of the rest
 * matters.
 *
 * What to check on a real phone:
 *  · a short fast flick leaves; a long slow crawl does not
 *  · scrolled down, a downward drag scrolls and never moves the sheet
 *  · back at the top, the same drag dismisses
 *  · lifting upward resists and springs back without dismissing
 *  · grabbing the sheet mid-spring takes it over rather than snapping it
 */
export function SheetDismissVariant() {
  const items = useWardrobe(8);
  const [open, setOpen] = useState(null);
  const [view, setView] = useState("wardrobe");
  const { onDrag, readout } = useReadout();

  return (
    <div className="proto-mobile">
      <ProtoHeader title="Wardrobe" subtitle="Tap a piece, then drag it away" onSettings={() => setOpen(items[0])} />

      <ProtoGrid items={items} onOpen={(item) => setOpen(item)} />

      <ProtoNav active={view} onSelect={setView} />

      <ProtoSheet item={open} onClose={() => setOpen(null)} onDrag={onDrag} />
      {readout}
    </div>
  );
}
