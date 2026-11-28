import { useEffect } from "react";
import { OverviewPieces } from "./overview-pieces.jsx";
import { OutfitsSection } from "./outfits.jsx";
import { CheatSheetsArea } from "./cheat-sheets.jsx";
import "./overview.css";

const SECTIONS = [
  { id: "outfits", label: "Outfits" },
  { id: "sheets", label: "Cheat sheets" },
  { id: "pieces", label: "Pieces" },
];

// Overview is the home of everything that groups pieces. The shell owns the
// page title and the section tabs; App owns which section is active. Inactive
// sections unmount, except CheatSheetsArea, which stays rendered with an
// `active` flag so an open editor (and its unsaved draft) survives a switch.
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

  // Automatic activation: arrows, Home and End select the tab they land on.
  const handleTabKeyDown = (event) => {
    const current = SECTIONS.findIndex(({ id }) => id === section);
    let next;
    if (event.key === "ArrowRight") next = (current + 1) % SECTIONS.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    const { id } = SECTIONS[next];
    onSectionChange?.(id);
    document.getElementById(`overview-tab-${id}`)?.focus();
  };

  return (
    <main className="overview-page">
      <header className="overview-header">
        {/* The page h1 is the shared large title (MobileHeadRow), on desktop too. */}
        <div className="overview-subnav" role="tablist" aria-label="Overview sections" onKeyDown={handleTabKeyDown}>
          {SECTIONS.map(({ id, label }) => {
            const active = id === section;
            return (
              <button
                key={id}
                id={`overview-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="overview-panel"
                tabIndex={active ? 0 : -1}
                className={active ? "is-active" : ""}
                onClick={() => onSectionChange?.(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <div id="overview-panel" role="tabpanel" aria-labelledby={`overview-tab-${section}`}>
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
