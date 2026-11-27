# Feature 03 — Cheat sheets on the shared picker

Part of [Merge Outfits into Overview](overview-merge-plan.md). Depends on feature 02. Overview keeps its current two sub-tabs (Pieces / Cheat sheets).

## Goal

Cheat sheets pick pieces through the same `PiecePicker` as outfits, and the editor's internal picker mode goes away.

## Scope

In (`src/cheat-sheets.jsx`):

- **New cheat sheet** in `SheetCollection` becomes **+ Cheat sheet** and opens `PiecePicker` first; confirm opens `CheatSheetEditor`.
- Editor **Add pieces** becomes **Edit pieces** and opens `PiecePicker` over the editor.
- Delete the local `PiecePicker` (~L205), the `mode === "picker"` branch and everything only it uses (`pickerSearchRef`, the picker heading, Escape handling for picker mode, query/category state if nothing else needs it).

Out:

- Overview's **Create cheat sheet** from a Pieces selection keeps working through `createRequest` in this feature; feature 04 removes it. Don't remove the `createRequest` path yet.
- Pencil on a saved sheet still opens the editor directly.
- `.cheat-picker*` CSS cleanup (feature 05).

## Flows

### Create

`+ Cheat sheet` → `PiecePicker` with `title="New cheat sheet"`, `rules={null}`, `confirmLabel="Next"`, `minPieces={1}`, `renderPreview` = a tray of selected thumbnails (simple strip; the "rough live layout" is an open point, not this feature). Confirm → `setEntry({ key, sheet: null, initialPieces: pieces })`, the same shape the `createRequest` path uses (~L847). Cancel → back to the collection, focus on the `+` button.

A blank (zero-piece) sheet is no longer creatable from `+`. Disable `+ Cheat sheet` with a hint when `items` is empty.

### Edit pieces (inside the editor)

`Edit pieces` → `PiecePicker` with `title="Edit pieces"`, `initialSelection` = current editor pieces (`{ itemId, variantId }`), `confirmLabel="Done"`, `minPieces={1}` unless the editor already allows an empty sheet (check: if it does, use `0`).

On confirm, reconcile into the editor's piece list:

- piece still present → keep its scale, keep its variant unless the picker changed it;
- new piece → default scale, picker's variant;
- removed piece → dropped;
- order: existing pieces keep their order, new ones appended in selection order.

Write the reconcile as a pure helper (`shared/cheat-sheet-pieces.mjs` or next to the existing cheat sheet layout code) so it can be unit-tested. Reconciling marks the editor dirty exactly like today's add/remove does, so the editor's own close-confirm and preview re-render still fire.

Closing the picker returns focus to **Edit pieces**. Escape closes the picker, not the editor (the picker's `ViewerPanel` sits on top).

## Tests

- New test for the reconcile helper: keep scale on retained, default scale on added, drop removed, variant change on retained piece, order rule.
- Existing `test/cheat-sheet-*.test.mjs` stay green.

## Acceptance

- `npm run check` green.
- Browser, desktop and phone width:
  - Cheat sheets → + Cheat sheet → pick 3 → Next → editor shows the 3 pieces, preview renders.
  - Change the scale of one piece, Edit pieces, remove another, add a new one, Done → scaled piece kept its scale, removed gone, new one at default.
  - Edit pieces → change selection → Escape → confirmation; confirm discard → editor unchanged.
  - Overview Pieces → select → Create cheat sheet still works (removed in feature 04).
  - Pencil on a saved sheet → editor directly; Edit pieces works there too.
- Commit: `feat: cheat sheets pick pieces through the shared picker`.
