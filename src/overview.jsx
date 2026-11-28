import { useEffect, useRef } from "react";
import { OverviewPieces } from "./overview-pieces.jsx";
import { OutfitsSection } from "./outfits.jsx";
import { CheatSheetsArea } from "./cheat-sheets.jsx";
import "./overview.css";

export const OVERVIEW_SECTIONS = [
  { id: "outfits", label: "Outfits" },
  { id: "sheets", label: "Cheat sheets" },
  { id: "pieces", label: "Pieces" },
];

// Overview is the home of everything that groups pieces. The page header
// (App's PageHeader + PageTabs) owns the section tabs and App owns which
// section is active. Inactive sections unmount, except CheatSheetsArea, which
// stays rendered with an `active` flag so an open editor (and its unsaved
// draft) survives a switch.
export function Overview({
  items,
  premiumAllowed = true,
  provider = null,
  loading = false,
  error = "",
  selectedItemId = null,
  onOpenItem,
  onItemsUpdated,
  onSelectionChange,
  section = "outfits",
  onSectionChange,
  onCountChange,
  colorProfile,
  onOpenColorQuiz,
  openOutfitId,
  onOutfitOpened,
  archiveGeneration,
}) {
  // Only Pieces has a selection. Runs after OverviewPieces unmounts, so the top
  // bar never stays hidden on Outfits or Cheat sheets for a selection that is gone.
  useEffect(() => {
    if (section !== "pieces") onSelectionChange?.(0);
  }, [section, onSelectionChange]);

  // The active tab carries the count of what its section shows. Pieces is the
  // wardrobe itself; Outfits and Cheat sheets load their own lists and print
  // the count in their section heading (visually hidden, see overview.css),
  // so it is read from there rather than fetched a second time.
  const panelRef = useRef(null);
  useEffect(() => {
    if (!onCountChange) return undefined;
    if (section === "pieces") {
      onCountChange(items.length);
      return undefined;
    }
    const panel = panelRef.current;
    if (!panel) return undefined;
    const read = () => {
      const text = panel.querySelector(".overview-panel-head h2 > span")?.textContent?.trim();
      onCountChange(text && /^\d+$/.test(text) ? Number(text) : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(panel, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [section, items.length, onCountChange]);

  return (
    <main className="overview-page">
      <div id="overview-panel" ref={panelRef} role="tabpanel" aria-labelledby={`overview-tab-${section}`}>
        {section === "outfits" && (
          <OutfitsSection
            items={items}
            premiumAllowed={premiumAllowed}
            provider={provider}
            colorProfile={colorProfile}
            onOpenColorQuiz={onOpenColorQuiz}
            openOutfitId={openOutfitId}
            onOutfitOpened={onOutfitOpened}
            archiveGeneration={archiveGeneration}
          />
        )}
        {section === "pieces" && (
          <OverviewPieces
            items={items}
            loading={loading}
            error={error}
            selectedItemId={selectedItemId}
            onOpenItem={onOpenItem}
            onItemsUpdated={onItemsUpdated}
            onSelectionChange={onSelectionChange}
          />
        )}
        <CheatSheetsArea items={items} premiumAllowed={premiumAllowed} provider={provider} active={section === "sheets"} onSaved={() => onSectionChange?.("sheets")} />
      </div>
    </main>
  );
}
