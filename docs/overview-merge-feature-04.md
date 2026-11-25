# Feature 04 — Merge Outfits into Overview

Part of [Merge Outfits into Overview](overview-merge-plan.md). Depends on features 02 and 03. This is the user-visible switch from four tabs to three.

## Goal

Overview becomes the home of everything that groups pieces: **Outfits** (default) · **Cheat sheets** · **Pieces**. The Outfits tab disappears.

## Scope

### Overview shell and sections

| File | Change |
| --- | --- |
| `src/overview.jsx` | Becomes the shell: page header, segmented control (Outfits · Cheat sheets · Pieces), renders the active section. Takes `section` / `onSectionChange` from App. |
| `src/overview-pieces.jsx` (new) | Today's Pieces logic moved out of `overview.jsx`: search, evidence facets, selection, `TagEditor`, desktop panel, mobile drawer. |
| `src/outfits.jsx` | `Outfits` → `OutfitsSection`: no `PageShell`; own header row (title + count, **Suggest outfit**, **+ Outfit**); `SuggestionNudges` under the header; grid, viewer, suggestions panel. |
| `src/cheat-sheets.jsx` | `SheetCollection` header drops the "Overview" eyebrow; button already reads **+ Cheat sheet** from feature 03. `createRequest` / `returnFocusRef` props removed. |

- Section header rows share one look: title + count left, actions right. Pieces has no actions.
- Segmented control is a real tab list (`role="tablist"`, arrow keys), on desktop and phone.
- Sections not active are unmounted, except `CheatSheetsArea`, which keeps its `active` prop so an open editor survives a section switch (current behaviour).
- `onSelectionChange` reports `0` whenever the active section isn't Pieces, so `data-overview-selection` never hides the top bar actions on Outfits/Cheat sheets.

### Removals in Pieces

- **Create cheat sheet** goes away from the desktop `TagEditor` (`overview-selection__create-sheet`, `onCreateSheet`) and from the mobile drawer (`overview-drawer__create-sheet`), along with `createCheatSheet`, `createSheetRequest`, `cheatSheetTriggerRef`.
- In `CheatSheetsArea`, delete the `createRequest` effect (~L841) and the `returnFocusRef` writes; the `+` button is the only creation entry.

### State moved out of App

- `showOutfitBuilder`, `showOutfitSuggestions` and their reset in the archive-generation handler (`App.jsx` ~L270) move into `OutfitsSection`. Their props (`showBuilder`, `onOpenBuilder`, `onCloseBuilder`, `showSuggestions`, `onCloseSuggestions`) are deleted.
- `openOutfitId` / `onOutfitOpened` / `archiveGeneration` pass through Overview to `OutfitsSection` unchanged.
- New App state `overviewSection` (default `"outfits"`), passed as `section` / `onSectionChange`. Not persisted.

### App, nav, navigation

- `VIEW_TITLES`, `.app-view-switch` (and its `aria-label`), `BottomNav` `VIEWS` lose `outfits`. Update `BottomNav`'s JSDoc view union and aria-label, and the `PageShell` comment listing views.
- Top bar: drop the `view === "outfits"` branches (`idleLabel`, `onIdleActivate`, Suggest outfit button) and the comment explaining them. On Overview the primary is **Add piece** (import) and the secondary is **Mirror**, like Wardrobe.
- `openOutfit(id)`: `setView("overview")`, `setOverviewSection("outfits")`, `setOpenOutfitId(id)`.
- Declutter `onGoToOutfits`: `setShowDeclutter(false)`, `setView("overview")`, `setOverviewSection("outfits")`.
- If anything restores `view === "outfits"` from storage or URL, map it to `overview` + `outfits`. Grep before assuming there is none.
- `/api/outfits/index` refetch on `view === "wardrobe"` already covers outfits edited in Overview; no change.

### Mobile

- `src/components/mobile-chrome.css`: bottom nav pill/widths for three tabs; remove selectors tied to removed markup.
- Segmented control sits at the top of the Overview page, under the large title.

Out: dead CSS sweep and README (feature 05).

## Acceptance

- `npm run check` green.
- Browser, desktop and phone width:
  - Three tabs in top switch and bottom nav; Overview opens on Outfits.
  - Outfits: + Outfit and Suggest outfit work from the section header; nudges show above the grid.
  - Cheat sheets: + Cheat sheet flow from feature 03; open an editor, switch to Pieces and back → editor still open.
  - Pieces: select, add/remove a tag in bulk; no Create cheat sheet on desktop or in the mobile drawer; drawer still opens/closes; top bar actions hide only while a Pieces selection exists.
  - Top bar on Overview: Add piece + Mirror.
  - Item viewer "in N looks" → Overview › Outfits with that outfit's viewer open. Declutter link → Overview › Outfits.
  - Edit an outfit in Overview, go to Wardrobe → "in N looks" counts updated.
- Commit: `feat: merge Outfits into Overview`.
