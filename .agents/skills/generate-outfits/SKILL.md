---
name: generate-outfits
description: Curate complete outfits from the local Wardrobe database and generate identity-preserving square modeled photos for every selected look end to end. Use when a user asks Codex for outfit ideas, combinations, looks, styling suggestions, a lookbook, or modeled outfit images based on clothes already imported into this Wardrobe.
---

# Generate Outfits

Create a complete outfit collection from `library.json` and `outfits.json` under the configured `WARDROBE_DATA_DIR` (default `data`): select strong combinations, generate a square modeled image for each, verify every result, and save the finished manifest and images in that archive.

## Begin with the count

Ask `How many outfits would you like me to generate?` unless the user already provided a positive count. Do not choose a default silently.

Also obtain the intended season, occasions, dress codes, or styling direction when the user named them. Otherwise create a balanced everyday mix without blocking on more questions.

Do the workflow end to end after receiving the count. Do not stop after returning suggestions, a manifest, or prompts.

## Requirements

- Read and follow the built-in `imagegen` skill before generating images.
- Require `library.json` in the configured archive, enough tops and bottoms for the requested count, and an identity reference at `<archive>/model-reference.png` or `WARDROBE_MODEL_REFERENCE`.
- Keep every source garment and identity image local and unchanged.
- Never add `data/`, the identity reference, garment images, or generated photos to Git.
- Use only wardrobe items that exist in the current database and whose local assets resolve successfully.
- Generate exactly the requested number of unique outfits and exactly one accepted modeled photo for each.

## Parallel work

Use subagents when the user requests more than eight outfits or explicitly asks for parallel generation. Keep one main agent responsible for the complete wardrobe inventory, global combination uniqueness, garment-usage balance, manifest reconciliation, and final QA.

Assign each worker a disjoint set of outfit IDs plus the exact identity and garment reference paths. Require every worker to return the outfit ID, filled prompt, reference list, generated path, status, and visual-review notes. Never allow two workers to generate or write the same outfit ID. Run workers in waves when concurrency is limited, reconcile results after every wave, and resume only missing or failed IDs.

## 1. Inspect the wardrobe

Resolve the archive as `path.resolve(repo, WARDROBE_DATA_DIR || 'data')` and read its `library.json`. Resolve local catalog assets relative to that directory: `/api/import/library/...` and `imported/...` point under `imported/`; `/api/archive/assets/...` maps to the matching archive-relative path. Preserve every subfolder segment and resolve the full path, never just the basename. Group items by:

- `upperbody` — tops
- `wholebody_up` — jackets and outer layers
- `lowerbody` — bottoms
- `accessories_up` — optional accessories
- `shoes` — optional shoes

Create checkerboard contact sheets of at most 12 garment cutouts and inspect them. Use both metadata and visual evidence; do not style from filenames or colors alone.

If the wardrobe cannot support the requested number of genuinely distinct outfits, tell the user the maximum useful count and ask whether to continue with that number.

## 2. Curate the combinations

Each outfit must contain exactly one top and one bottom, with an optional jacket, shoes, and restrained accessory. Use these principles recovered from the established Wardrobe outfit workflow:

- Favor tonal or analogous color harmony for cohesion.
- Use complementary contrast selectively and keep one color or garment dominant.
- Let one graphic, pattern, texture, or saturated piece carry the statement.
- Balance visual weight and silhouette: pair fuller bottoms with a cleaner top; keep heavier layers over a simple base.
- Use outer layers to frame the base look, repeat a present color, or add one controlled contrast.
- Keep layered looks physically plausible and make every selected garment visibly identifiable.
- Diversify garment usage instead of repeatedly leaning on the easiest neutral pieces.

Cover a useful mix of the user’s requested contexts. Without specific direction, balance casual, smart-casual, warm-weather, layered, dark-tonal, and statement looks as the wardrobe permits.

Build `$WORK/outfits.json` with the final target count:

```json
{
  "version": 1,
  "outfits": [
    {
      "id": "navy-camel-classic",
      "name": "Navy & Camel Classic",
      "occasion": ["smart-casual", "office"],
      "garmentIds": ["import-...", "import-..."],
      "reason": "Deep navy and camel create controlled warm-cool contrast.",
      "setting": "a quiet warm-stone courtyard with restrained greenery",
      "image": "outfit-images/navy-camel-classic.png",
      "status": "planned"
    }
  ]
}
```

Use stable lowercase hyphenated IDs. Reject duplicate garment combinations even when names or settings differ.

## 3. Prepare references and prompts

Create one generation package per outfit:

1. Identity reference
2. Exact top cutout
3. Exact bottom cutout
4. Optional exact outer layer
5. Optional exact shoes or accessory only when deliberately selected

Read [references/outfit-image-prompt.md](references/outfit-image-prompt.md) and fill its template from the exact outfit record. Inspect every outer-layer reference before choosing the layered clause; never infer a zipper, buttons, placket, opening, or closure.

Rotate restrained warm, natural settings across the collection while keeping one cohesive editorial art direction.

## 4. Generate every outfit

Create one square 1:1 modeled PNG per outfit with Imagegen. Save working outputs outside `data/` until they pass review. Use the smallest valid set of references for each call and never omit a selected garment.

Generate in bounded batches when the collection is large. Track every outfit as `planned`, `generated`, `accepted`, or `failed`; resume only missing or failed IDs.

## 5. Verify and correct

Compare every output against the identity and all garment references. Inspect contact sheets of at most 12 modeled outfits, then open questionable images individually.

Require:

- recognizable identity, face, hair, age, build, and body proportions
- every selected garment present and recognizable
- exact garment color, material, fit, construction, graphics, logos, text, proportions, and closures
- complete head-to-shoes framing with readable outfit and realistic anatomy
- natural layering without invented openings or hidden inner pieces
- no unselected visible garments except plain neutral shoes or invisible basics when no shoes were selected
- no extra person, text overlay, watermark, product mockup, or synthetic AI polish

Regenerate identity drift, missing or redesigned garments, fake closures or text, anatomy failures, or cropped feet. Do not mark an outfit accepted based on plausibility alone.

## 6. Deliver locally

After all requested outfits pass:

1. Resolve the configured archive directory and create its `outfit-images/` folder if needed.
2. Copy each accepted PNG to `<archive>/outfit-images/OUTFIT-ID.png`.
3. Store the portable relative asset path `outfit-images/OUTFIT-ID.png` in the outfit record. The web API serves it through `/api/archive/assets/outfit-images/OUTFIT-ID.png`.
4. Atomically write the exact requested collection to `<archive>/outfits.json`.
5. Reopen every copied file and verify that the count of images, unique outfit IDs, and accepted manifest records all equal the number the user requested.

Do not claim the current gallery displays outfits unless the app has an outfit route. The completed local assets and manifest are still the deliverable.

## Finish

Report the requested and completed count, output paths, any regenerated failures, and the styling mix. Display up to 12 modeled outfits in chat and point the user to the configured archive folder for the rest.
