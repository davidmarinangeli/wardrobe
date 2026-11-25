# Feature 02 — Shared piece picker, used by outfits

Part of [Merge Outfits into Overview](overview-merge-plan.md). Depends on feature 01. The tab structure does not change yet: the picker replaces `OutfitBuilder` inside today's **Outfits** tab, so it can be checked on its own.

## Goal

Build the full-screen `PiecePicker` once, generic enough for outfits and cheat sheets, and make outfit create/edit go through it.

## Scope

In:

- `src/components/PiecePicker.jsx` + `src/components/piece-picker.css`.
- Outfit create (top bar **Add outfit**, still in App for now) and edit (`OutfitViewer` → Edit) open `PiecePicker` instead of `OutfitBuilder`.
- Delete `OutfitBuilder` from `src/outfits.jsx`.

Out: cheat sheets (feature 03), moving outfits into Overview or moving **Suggest outfit** (feature 04), CSS cleanup of `.outfit-builder*` / `.builder-*` (feature 05; leave the rules dead for now). Phone layout is deliberately rough (see plan's open points); it must work, not be final.

## Component contract

```js
<PiecePicker
  title="New outfit"
  items={items}
  initialSelection={[{ itemId, variantId }]}  // default []
  rules="outfit" | null
  renderPreview={(selectedPieces) => node}    // selectedPieces: items with variantId/image/thumbnail resolved
  confirmLabel="Save"
  minPieces={1}
  footer={node}
  onConfirm={(pieces) => …}                   // [{ itemId, variantId }], may return a promise
  onClose={() => …}
/>
```

- Rendered through `ViewerPanel` (full screen), so focus trap, Escape, portal and motion come from there. Don't hand-roll a dialog.
- Owns selection (`Map<itemId, variantId>`), query, category, active tags. Knows nothing about outfits beyond `rules`.
- `onConfirm` returning a rejected promise keeps the picker open; the caller shows its own error (for outfits: in `footer`). While the promise is pending, Confirm is disabled.
- Confirm is disabled below `minPieces`.

## Behaviour

- **Header**: back/close, `title`, "N selected" (full selection, not filtered), Confirm button.
- **Search**: `buildOverviewIndex(items)` memoised on `items`, then `filterOverviewIndex(index, query)`.
- **Category chips**: `WARDROBE_TYPES` from `src/categories.js`, single select, "All" default. Same filtering the cheat sheet picker uses (`src/cheat-sheets.jsx` `PiecePicker`); reuse its predicate.
- **Tag chips**: `overviewSuggestions(items)` for tag + count over the whole wardrobe (counts don't change with filters). Toggle; several active combine with AND via `filterByTags`. One horizontally scrolling row; active chips sorted first.
- **Grid**: image cards with a corner checkbox, visually aligned with `.overview-card`. Cards are buttons with `aria-pressed`.
- **Select**: new piece gets `initialVariantForPiece(item)`. A selected piece with `variants.length > 1` shows its variant thumbnails (moved from `OutfitBuilder`'s `.builder-variant-picker`, using `variantOwnImage`).
- **Rules**: with `rules="outfit"`, unselected pieces where `isPieceBlocked(item, blockedCoverages(selected))` render disabled with the existing explanatory `title`. Selected pieces are never auto-removed.
- **Filtering never deselects.**
- **Close with changes**: if the selection differs from `initialSelection` (compare itemId + variantId sets), close/Escape/back ask for confirmation. Reuse the cheat sheet editor's close-confirm pattern (`closeConfirm` state + Keep/Discard dialog, `src/cheat-sheets.jsx` ~L498/L743); extract a small shared piece if it's cheaper than copying.
- **Empty filter result**: "No pieces match" + **Clear filters** (resets query, category, tags; not selection).
- **Preview**: desktop = side panel with `renderPreview(selected)` above `footer`. Phone = collapsed bottom tray showing the count, tap to expand into preview + footer.

## Outfit wiring (`src/outfits.jsx`)

- Create: `PiecePicker` with `title="New outfit"`, `rules="outfit"`, `renderPreview={(p) => <OutfitStack items={p} />}`, `confirmLabel="Save"`, `footer` = Name field + error line.
- Edit: same, `title` = "Edit outfit", `initialSelection` = outfit pieces (same normalisation `OutfitBuilder` does for legacy `itemIds`), name prefilled.
- Save: validate name ("Give this outfit a name.") and ≥1 piece ("Pick at least one piece."), then existing `saveOutfit` (`POST` or `PATCH`). Name lives in the outfit wrapper, not in the picker.
- App's `showOutfitBuilder` / `onOpenBuilder` / `onCloseBuilder` stay as they are for now; only what they render changes.
- If `items` is empty, **Add outfit** is disabled with a hint instead of opening an empty picker.

## Tests

Pure logic is already covered by feature 01. If selection-diff ("has changes") or the legacy-pieces normalisation ends up as a helper, put it in a `shared/` module and test it; don't add DOM test infrastructure for this feature.

## Acceptance

- `npm run check` green.
- Browser, desktop and phone width:
  - Add outfit → search, category, two tag chips (AND), select a dress (tops/bottoms blocked), pick a variant, name, Save → card appears.
  - Save without name / without pieces → same messages as before, picker stays open.
  - Edit that outfit → picker preselected incl. variant, change a piece, Save → viewer shows new pieces.
  - Change selection then Escape → confirmation; no change then Escape → closes directly.
  - Filters that match nothing → empty state, Clear filters restores grid, selection intact.
- Commit: `feat: shared full-screen piece picker for outfits`.
