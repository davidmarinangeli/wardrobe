# Overview merge — critical points

## Feature 01

- Naming: the imported `blockedCoverages` must not be shadowed by the old local const of the same name. Using `blocked` as the new local would also clash with the per-item `const blocked` in the `OutfitBuilder` render loop (`src/outfits.jsx`). The local is `coverageBlocks`.
- The old `useMemo` depended on `selectedItems`, which is rebuilt with `.filter().map()` on every render, so it never cached anything. Removing it does not change performance. Don't add a memo that misleads the same way.
- Index entries hold raw tags only (`entry.item.tags`); no normalised tag field exists (`buildOverviewIndex` only folds tags into `searchText` through `allText` and `normalizeOverviewText`). `filterByTags` reads `entry.item?.tags` with an Array guard, because some items have no `tags` array.
- The key `filterByTags` uses (`tagKey`: trim + `toLocaleLowerCase("en")`) must stay the same as `overviewSuggestions`' key. Otherwise feature 02's chip counts will disagree with the filtered grid. `normalizeOverviewText` is deliberately not used: it folds plurals and punctuation, so it would merge chips that are counted separately (e.g. "t-shirt" and "t shirt").
- `tagKey` is a third copy of the trim + lowercase expression, next to `overviewSuggestions` and `commonOverviewTags`. Left as is to keep the diff small; `overviewSuggestions` is out of scope for feature 01.
- Keep the `GARMENT_PART_MAP` import in `src/outfits.jsx`: `SuggestionNudges` still uses it. Keep the `useMemo` import too (`itemsByCategory`, `dismissed`, `itemMap`).
- `isPieceBlocked` deliberately knows nothing about selection. Every caller, now `OutfitBuilder` and in feature 02 the picker, must keep the `!selected.has(id) &&` guard, or a selected piece would grey itself out.
- Behaviour differs from today in one invisible way: an unknown part no longer adds `undefined` to the coverage set. Nothing reads that value, because only `full`, `upper` and `lower` are ever checked; the test states the no-contribution rule explicitly.
- Two full pieces (dress plus jumpsuit) stay allowed together: a full piece blocks only `upper` and `lower`. That is today's behaviour and the test comments it so feature 02 doesn't "fix" it by accident.
- The blocked title text is wrong in one direction today: with a top or bottom selected, a dress reads "<name> — a full-length piece already covers this". Feature 01 keeps the text unchanged; feature 02 is the place for a coverage-aware message (for example a small `blockedReason(item, blocked)` in `outfit-rules.mjs`).
- `shared/outfit-index.mjs` already exists (it holds the outfit counts index). Don't confuse it with the new `shared/outfit-rules.mjs`.
- `node --test test/` (the directory form) fails on this Node; use `npm test` or the `test/*.test.mjs` glob.
