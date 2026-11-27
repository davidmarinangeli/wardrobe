# Feature 05 — Cleanup and docs

Part of [Merge Outfits into Overview](overview-merge-plan.md). Depends on feature 04. No behaviour change.

## Goal

Remove what features 02–04 left dead and bring the docs in line with three tabs.

## Scope

### Dead CSS

Delete each selector only after `grep -rn` over `src/` confirms nothing renders it:

- `.outfit-builder*`, `.builder-piece-option`, `.builder-variant-picker` (if the picker didn't reuse it) — `src/outfits.css`
- `.cheat-picker*` — `src/cheat-sheets.css`
- `.overview-selection__create-sheet`, `.overview-drawer__create-sheet` — `src/overview.css`
- Outfits page header styles that only `PageShell` used for the old tab
- Mobile rules for the fourth bottom-nav tab — `src/components/mobile-chrome.css`

### Dead code

- Imports left unused in `src/outfits.jsx`, `src/cheat-sheets.jsx`, `src/overview.jsx`, `src/App.jsx` (`useSheetGesture`, `CATEGORIES`, `PageShell`, `forwardRef`, … whatever the earlier features orphaned).
- Comments that still mention the Outfits tab, the top-bar Add outfit, or Create cheat sheet from a selection.

### Docs

- `README.md`: tab list (three tabs), the "Outfits" section rewritten as Overview › Outfits, cheat sheets created with **+ Cheat sheet**.
- Screenshots / alt text under `docs/screenshots/` or in README that show or name four tabs: update the text; flag images that need retaking rather than shipping stale ones silently.
- `AGENTS.md`: only if it names the Outfits tab.
- `docs/overview-merge-plan.md`: add a short delivery record (commit per feature).

## Acceptance

- `npm run check` green.
- `grep -rn "outfit-builder\|cheat-picker\|create-sheet\|\"outfits\"" src/` returns only intended hits (API paths like `/api/outfits` are expected).
- Full manual checklist from the plan, once, desktop and phone width.
- Commit: `chore: remove dead builder/picker code and document the merged Overview`.
