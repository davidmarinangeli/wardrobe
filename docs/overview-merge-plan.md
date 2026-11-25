# Merge Outfits into Overview

## Goal and baseline

The app has four top-level tabs: **Wardrobe**, **Overview**, **Outfits**, **Inspo**. Overview and Outfits overlap: both exist to put wardrobe pieces into a group, an outfit in one case and a cheat sheet in the other, and each does it with its own picker.

After this change the app has three tabs (**Wardrobe**, **Overview**, **Inspo**). Overview has three sections, in this order:

1. **Outfits** (default section): the saved outfits grid, with **Suggest outfit** and **+ Outfit** at the top right.
2. **Cheat sheets**: the cheat sheet collection, with **+ Cheat sheet** at the top right.
3. **Pieces**: today's Overview list, kept only for bulk tag editing (select pieces, add or remove tags on all of them).

**+ Outfit** and **+ Cheat sheet** open the same full-screen **piece picker**: search by name/color/fabric/tags, category chips, clickable tag chips, live preview of the selection. After confirming, each type continues in its own way: an outfit asks for a name and saves; a cheat sheet opens the existing cheat sheet editor.

Plan written against HEAD `331918e` on `feat/google-drive-archive`. No new dependencies, no API or data-model changes: outfits keep `POST/PATCH /api/outfits`, cheat sheets keep `/api/cheat-sheets`. This is a client-only refactor.

### What exists today

| Piece | Where | Notes |
| --- | --- | --- |
| Overview page, sub-tabs Pieces / Cheat sheets | `src/overview.jsx` | Pieces = search + evidence facets + selection + `TagEditor` (bulk tags + **Create cheat sheet** from selection). Desktop sidebar, mobile drag drawer. |
| Cheat sheet collection + editor | `src/cheat-sheets.jsx` (`CheatSheetsArea`, `CheatSheetEditor`, `PiecePicker`) | Editor is already a full-screen `ViewerPanel` with title, description, scale per piece, variant `<select>`, live rendered preview and AI beautify. Pieces are added through an internal `mode === "picker"` that swaps in `PiecePicker` (search + category, list rows). Creation from Overview goes through the `createRequest` prop. |
| Outfits tab | `src/outfits.jsx` (`Outfits`, `OutfitBuilder`, `OutfitCard`, `OutfitViewer`, `SuggestionNudges`) | `OutfitBuilder` is a side sheet: name field, `OutfitStack` preview, pieces grouped by category (no search), variant thumbnails under each selected piece, coverage rule (a dress/jumpsuit blocks tops and bottoms and vice versa; layering pieces never block or get blocked). |
| Top bar actions | `src/App.jsx:589-622` | On `outfits` the primary button is relabelled **Add outfit** and the secondary slot is **Suggest outfit**; elsewhere the primary is the piece import and the secondary is Mirror. `data-overview-selection` hides the action row on mobile while a Pieces selection is open. |
| Navigation into Outfits | `App.jsx` `openOutfit` (item viewer "in N looks") and `DeclutterPanel.onGoToOutfits` | Both call `setView("outfits")`. |
| Tabs | `App.jsx` `VIEW_TITLES` and `.app-view-switch`, `src/components/BottomNav.jsx` `VIEWS` | Four entries each. |
| Search index | `shared/overview-index.mjs` | `filterOverviewIndex` matches name, tags, color, fabric, subtype. `overviewSuggestions` already counts tags across items. |

## Decisions

- Tab name stays **Overview**. Sections: **Outfits · Cheat sheets · Pieces**, default **Outfits**. Remembering the last section is not needed.
- The **Pieces** section is only for bulk tags. **Create cheat sheet** from a selection goes away (desktop panel and mobile drawer). No "create outfit from selection" either.
- One shared full-screen picker (approach A). The type-specific step comes after it.
- **Editing** an outfit reopens the same picker with its pieces already selected.
- Outfit rules stay: variant choice and the coverage block both work inside the picker when it is opened for an outfit.
- The picker shows a **live preview** of the selection.
- Filters in the picker: free-text search, category chips, **clickable tag chips**. No palette filter, no "only selected" toggle.
- Retired/sold pieces: out of scope. The picker uses the same `items` array the rest of the page uses.
- Top bar on Overview: primary goes back to **Add piece** (import), secondary is **Mirror**. **Suggest outfit** moves next to **+ Outfit** in the Outfits section header. `SuggestionNudges` stay at the top of the Outfits section.
- "in N looks" from the item viewer and the Declutter link open **Overview → Outfits**, and the first one also opens that outfit's viewer.
- Mobile: bottom nav with three tabs. The sections are a segmented control at the top of the page. The picker is full screen on phones too.
- No search over saved outfits / cheat sheets for now.

## The shared picker

New component `src/components/PiecePicker.jsx` (+ `piece-picker.css`), rendered through `ViewerPanel` as a full-screen panel, so it gets the existing focus trap, Escape handling, portal and open/close motion.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ← New outfit                                   3 selected   [Next →] │
├──────────────────────────────────────────────────────────────────────┤
│ 🔍 Search by name, color, fabric, tag…                               │
│ [All] [Tops] [Bottoms] [Dresses] [Shoes] [Accessories] …             │
│ #linen 12  #work 9  #summer 7  #black 6  …                (tag chips)│
├────────────────────────────────────────────┬─────────────────────────┤
│ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐              │   Live preview          │
│ │ ✓ │ │   │ │ ⊘ │ │   │ │ ✓ │   grid of    │   (OutfitStack for an   │
│ └───┘ └───┘ └───┘ └───┘ └───┘   pieces     │    outfit, thumbnail    │
│  ◐ ◑  variant thumbs under a selected      │    tray for a sheet)    │
│       multi-variant piece                  │                         │
└────────────────────────────────────────────┴─────────────────────────┘
 Phone: preview collapses into a bottom tray (tap to expand), grid is
 2–3 columns, header keeps Back / count / Next.
```

### API

```js
<PiecePicker
  title="New outfit"                  // header label
  items={items}
  initialSelection={[{ itemId, variantId }]}   // edit / "edit pieces"
  rules="outfit" | null               // enables the coverage block
  renderPreview={(selectedPieces) => node}     // live preview slot
  confirmLabel="Next"                 // or "Save", "Done"
  minPieces={1}
  footer={node}                       // optional extra content in the side panel (outfit name)
  onConfirm={(pieces) => …}           // [{ itemId, variantId }]
  onClose={() => …}
/>
```

The picker owns selection, search, category and tag state. It does not know about outfits or cheat sheets beyond `rules` and the preview it is given.

### Behaviour

- **Search**: `buildOverviewIndex` + `filterOverviewIndex(index, query)`, the same matching Overview uses today.
- **Category chips**: `WARDROBE_TYPES` from `src/categories.js`, single select, "All" by default (same as the cheat sheet picker today).
- **Tag chips**: `overviewSuggestions(items)` gives every tag with its count. Clicking a chip toggles it; several active tags combine with **AND** (a piece must carry all of them). Counts reflect the full wardrobe, not the current filter, so chips don't jump around. Chips scroll horizontally on one row; an active chip moves to the front. A new pure helper `filterByTags(entries, tags)` in `shared/overview-index.mjs` does the filtering.
- **Grid**: image cards (not list rows), checkbox in the corner like `.overview-card`. Selecting a piece sets `initialVariantForPiece(item)`, as both builders do today. A selected multi-variant piece shows the variant thumbnails under it (moved from `OutfitBuilder`).
- **Coverage rule** (`rules="outfit"`): the logic in `OutfitBuilder.blockedCoverages`/`isBlocked` moves to a pure module `shared/outfit-rules.mjs` (`blockedCoverages(selectedItems)`, `isPieceBlocked(item, blocked)`), unit-tested, and the picker renders blocked pieces greyed with the existing explanatory title. Selected pieces that become blocked are not removed silently: blocking only applies to unselected pieces, as today.
- **Selection survives filtering**: changing search/category/tags never deselects. The header count always shows the full selection.
- **Close with changes**: if the selection differs from `initialSelection`, closing asks for confirmation (reuse the cheat sheet editor's close-confirm pattern).
- **Empty states**: no match → "No pieces match" + "Clear filters". Empty wardrobe → picker is not reachable (the `+` buttons are disabled with a hint).

## Per-type flows

### Outfit

- **+ Outfit** → `PiecePicker` with `rules="outfit"`, `renderPreview` = `OutfitStack`, `footer` = the **Name** field, `confirmLabel="Save"`. Save validates name and ≥1 piece (same messages as today) and calls the existing `saveOutfit`.
- Name lives in the side panel next to the preview (on phones, at the top of the expanded tray), so creating an outfit stays one screen, without a separate second step.
- **Edit** (from `OutfitViewer` → Edit) opens the same picker with `initialSelection` = the outfit's pieces and the name prefilled; save goes to `PATCH`.
- `OutfitBuilder` is deleted.

### Cheat sheet

- **+ Cheat sheet** → `PiecePicker` with no rules, `renderPreview` = a tray of selected thumbnails, `confirmLabel="Next"`. Confirm opens `CheatSheetEditor` with `initialPieces` set to the selection (the path the Overview `createRequest` uses today).
- In the editor, **Add pieces** becomes **Edit pieces** and opens the shared picker over the editor with `initialSelection` = current pieces and `confirmLabel="Done"`. On confirm, the editor keeps scale/variant for pieces that stay, adds new ones at default scale, and drops removed ones. The internal `mode === "picker"` branch and the local `PiecePicker` are deleted.
- **Edit** of a saved sheet (pencil on the card) opens the editor directly, since it holds title, description and beautify as well as pieces; changing pieces goes through **Edit pieces**. This is the one place where "edit reopens the picker" applies one step later than for outfits.
- A blank cheat sheet (zero pieces) is no longer creatable from the `+` button: the picker requires ≥1 piece.

## Page structure

```text
src/overview.jsx            Overview shell: header, segmented control, active section
src/overview-pieces.jsx     today's Pieces logic (search, facets, selection, TagEditor, drawer), minus "Create cheat sheet"
src/outfits.jsx             OutfitsSection (was Outfits): grid, viewer, suggestions, nudges; no PageShell, no OutfitBuilder
src/cheat-sheets.jsx        CheatSheetsArea: collection + editor; "+ Cheat sheet" opens PiecePicker
src/components/PiecePicker.jsx + piece-picker.css   shared picker
shared/outfit-rules.mjs     coverage rule
shared/overview-index.mjs   + filterByTags
```

- Each section renders its own header row: title + count on the left, actions on the right (`Suggest outfit` + `+ Outfit`; `+ Cheat sheet`; none for Pieces). The `SheetCollection` header's **New cheat sheet** button becomes **+ Cheat sheet**, and the "Overview" eyebrow goes.
- Outfit state that App holds only because the trigger lived in the top bar (`showOutfitBuilder`, `showOutfitSuggestions` and their props) moves into `OutfitsSection`.
- `Overview` gets `section` / `onSectionChange` from App (lifted state) so `openOutfit` and Declutter can select **Outfits**. `openOutfitId` / `onOutfitOpened` are passed through to `OutfitsSection` unchanged.
- `onSelectionChange` (which drives `data-overview-selection`) reports 0 when the active section isn't Pieces.
- The `Overview` `createRequest` / `returnFocusRef` plumbing into `CheatSheetsArea` goes away; `CheatSheetsArea` opens the picker itself.
- Sections stay unmounted when inactive, as the Outfits tab is today; `CheatSheetsArea` keeps its current `active` handling so an open editor survives a section switch.

## App changes (`src/App.jsx`, `BottomNav.jsx`, CSS)

- `VIEW_TITLES`, `.app-view-switch` and `BottomNav` `VIEWS` lose `outfits`. `BottomNav`'s doc comment and the `PageShell` comment (which lists views) are updated.
- Top bar: remove the `view === "outfits"` branches (`idleLabel`, `onIdleActivate`, the Suggest-outfit button). Overview falls through to the default import + Mirror.
- `openOutfit`: `setView("overview")`, `setOverviewSection("outfits")`, `setOpenOutfitId(id)`.
- Declutter `onGoToOutfits`: same, without an outfit id.
- The outfit index (`/api/outfits/index`, for the "in N looks" counts) is refetched whenever `view` becomes `wardrobe` (`App.jsx:120`), so outfits edited inside Overview are picked up on the way back. Nothing to change.
- `mobile-chrome.css`: bottom nav pill and widths for three tabs; drop selectors tied to removed markup.

## Phases

Each phase leaves the app working and ends with `npm run check` green, a manual pass in the browser at desktop and phone width, and a commit + push.

1. **Pure logic.** `shared/outfit-rules.mjs` (extracted from `OutfitBuilder`, which starts using it), `filterByTags` in `shared/overview-index.mjs`. Tests in `test/outfit-rules.test.mjs` and `test/overview-index.test.mjs` (AND semantics, case-insensitive tags, empty tag list = no filter).
2. **Shared picker, used by outfits.** Build `PiecePicker`; replace `OutfitBuilder` in the current Outfits tab for create and edit. The tab structure doesn't change yet, so the picker can be checked on its own.
3. **Cheat sheets on the picker.** `+ Cheat sheet` → picker → editor; **Edit pieces** in the editor; delete the internal picker mode and old `PiecePicker`.
4. **Merge.** Overview shell with three sections (Outfits default); split `overview-pieces.jsx`; `Outfits` → `OutfitsSection` inside Overview, with Suggest outfit and nudges in its header; remove **Create cheat sheet** from the Pieces selection; App top bar, tabs, `BottomNav`, `openOutfit`, Declutter.
5. **Cleanup and docs.** Delete dead CSS (`.outfit-builder*`, `.builder-piece-option`, `.cheat-picker*`, `.overview-selection__create-sheet`, `.overview-drawer__create-sheet`, outfits page header bits); update README ("Outfits" section and tab list) and any screenshots/alt text that name four tabs; final `npm run check`.

## Manual verification checklist

- Create an outfit: search, category, two tag chips (AND), select a dress and see tops/bottoms blocked, pick a variant, name, save → card appears in Outfits.
- Edit that outfit: picker opens preselected, change a piece, save → viewer shows the new pieces.
- Create a cheat sheet: picker → Next → editor shows the pieces; Edit pieces keeps the scale of pieces that stayed.
- Close the picker with changes → confirmation; without changes → closes directly.
- Pieces section: select, add/remove a tag in bulk; no Create cheat sheet button; mobile drawer still opens and closes.
- Item viewer "in N looks" → Overview › Outfits with the outfit open. Declutter link → Overview › Outfits.
- Top bar on Overview shows Add piece + Mirror; Suggest outfit works from the Outfits section.
- Phone width: three-tab bottom nav, segmented control, full-screen picker with the preview tray.

## Open points for the refinement pass

- Exact picker layout on phones (tray height, columns) and its motion: deliberately left loose; the user will refine the modal after this lands.
- Whether the cheat sheet tray preview should become a rough live layout (cheap DOM approximation) instead of a thumbnail strip.
- Whether to keep evidence facets (the "12 linen shirts" chips from Pieces) in the picker as well.
