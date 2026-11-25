# Feature 01 — Pure outfit rules and tag filtering

Part of [Merge Outfits into Overview](overview-merge-plan.md). Baseline: `8e8295c` on `feat/google-drive-archive`. No UI change: the app looks and behaves exactly as before.

## Goal

Pull the two pieces of logic the shared picker will need out of components and into tested, pure modules, so features 02–03 build on code that is already covered.

## Scope

In:

- New `shared/outfit-rules.mjs` with the coverage rule now inlined in `OutfitBuilder` (`src/outfits.jsx`, `blockedCoverages` memo and `isBlocked`).
- New `filterByTags(entries, tags)` in `shared/overview-index.mjs`.
- `OutfitBuilder` switches to `outfit-rules.mjs`; behaviour unchanged.

Out: the picker, any markup or CSS, any change to `filterOverviewIndex` or `overviewSuggestions`.

## Contracts

### `shared/outfit-rules.mjs`

```js
blockedCoverages(selectedItems)   // -> Set<"upper"|"lower"|"full">
isPieceBlocked(item, blocked)     // -> boolean
```

- Uses `GARMENT_PART_MAP` (same source `outfits.jsx` uses today) for `coverage` and `layer`.
- Layering parts never contribute to `blocked` and are never blocked.
- Any selected non-layer `full` piece → `{upper, lower}`. Otherwise any selected `upper` or `lower` → `{full}`. Otherwise empty.
- Unknown `part` → not blocked, contributes nothing.
- `isPieceBlocked` does not know about selection. The caller keeps today's rule: only **unselected** pieces render as blocked (`!selected.has(item.id) && isPieceBlocked(...)`).
- Move the explanatory comment from `OutfitBuilder` with the code.

### `filterByTags(entries, tags)` in `shared/overview-index.mjs`

- `entries`: the index entries returned by `buildOverviewIndex` / `filterOverviewIndex` (so it composes after text search).
- `tags`: array of tag strings. Empty or missing → returns `entries` unchanged (same array is fine).
- AND semantics: an entry is kept only if it carries every tag.
- Case-insensitive, compared through the same normalisation the index already applies to tags (`normalizeOverviewText` or whatever the entry stores; check `buildOverviewIndex` and reuse its form rather than inventing a second one).
- Pure, no mutation of inputs.

## Tests

- `test/outfit-rules.test.mjs` (new): dress blocks top and bottom; top blocks dress; bottom blocks dress; jacket/layer neither blocks nor is blocked, alongside a dress and alongside a top; empty selection blocks nothing; unknown part.
- `test/overview-index.test.mjs` (extend): `filterByTags` with no tags, one tag, two tags (AND), mixed case, a tag no entry has, composition after `filterOverviewIndex`.

## Acceptance

- `npm run check` green.
- Browser: Outfits tab → **Add outfit** → select a dress, tops and bottoms grey out with the same title text; deselect, select a top, dresses grey out; a jacket stays selectable throughout.
- Commit: `refactor: extract outfit coverage rules and add tag filtering`.
