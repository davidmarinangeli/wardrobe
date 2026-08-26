---
name: import-clothes
description: Extract unique garments from outfit or model photos, reconstruct clean transparent clothing cutouts, generate identity-preserving modeled editorial photos, and import approved items directly into this Wardrobe project's local JSON database. Use when a user asks Codex to add, ingest, extract, or import clothes from a folder of photos into Wardrobe, wants modeled photos for imported pieces, or wants finished wardrobe PNGs without using the in-app OpenAI import flow.
---

# Import Clothes

Turn photos of worn clothing into source-faithful transparent catalog PNGs and modeled editorial photos, then add the approved results to the local Wardrobe database.

## Inputs

Obtain the source-image folder unless the user already supplied it. Resolve relative paths from the repository root. Confirm this is the Wardrobe repository by checking for `package.json`, `scripts/import-job-api.mjs`, and `data/` in `.gitignore`.

At the start, check for the identity reference at `data/model-reference.png` or the local path configured by `WARDROBE_MODEL_REFERENCE`. If neither exists, ask: `Please provide a clear PNG reference photo of yourself for the modeled wardrobe images. What is its local path?` Do not begin modeled generation until the user supplies it. Keep the image local and never add it to Git.

Default to direct database import when the user asks to add clothes to Wardrobe. If they only request cutouts, ask for a new output-folder name instead and skip the database step.

## Rules

- Read and follow the built-in `imagegen` skill before generating or editing an image.
- Preserve every source image unchanged.
- Produce one clothing item per PNG, except an established matching pair such as shoes.
- Remove the wearer, skin, hair, mannequin, hanger, props, other layers, and scene.
- Preserve only source-supported color, material, silhouette, construction, pattern, and legible marks.
- Prefer omission over invented logos, text, pockets, seams, fasteners, hardware, or trim.
- Deduplicate only when source photographs establish that two appearances are the same physical item.
- Hold items whose defining construction cannot be recovered without substantial invention.
- Never place temporary crops, prompts, manifests, or QA files in `data/`.

## Parallel work

Use subagents for large source folders or more than eight generated items when the current environment supports them. Give each worker a disjoint set of source files or manifest slugs and require it to return the slug, prompt, reference paths, chroma path, modeled path, and visual-review notes.

Keep one main agent responsible for the global item inventory, physical-identity deduplication, manifest reconciliation, database write, and final contact-sheet QA. Never let two workers generate or write the same slug. Run batches in waves when concurrency is limited, and resume only missing or failed slugs.

## Temporary workspace

Work outside the repository data directory:

```bash
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wardrobe-import.XXXXXX")"
mkdir -p "$WORK"/{source-jpg,crops,chroma,items,modeled,qa}
```

Keep all intermediate files under `$WORK`. Delete it only after delivery succeeds.

## Workflow

### 1. Inventory sources

Use `rg --files` first. Include JPEG, PNG, WebP, HEIC/HEIF, TIFF, BMP, and AVIF. Exclude `data/`, `dist/`, `node_modules/`, and `.git/`.

Create upright RGB JPEG working copies at quality 95 or better without upscaling. Make labeled contact sheets of at most 12 photos and inspect every sheet. Inventory every deliberately worn top, jacket, bottom, accessory, and pair of shoes.

### 2. Build the manifest

Write `$WORK/manifest.json` using this final shape:

```json
{
  "items": [
    {
      "slug": "navy-fair-isle-cardigan",
      "file": "navy-fair-isle-cardigan.png",
      "modeledFile": "navy-fair-isle-cardigan.png",
      "name": "Navy Fair Isle Cardigan",
      "part": "wholebody_up",
      "color": "#172033",
      "secondaryColor": "#f2efe6",
      "tags": ["knit", "fair isle", "zip"],
      "status": "accepted",
      "sourceRefs": ["IMG_1284.jpg", "IMG_1289.jpg"],
      "unknowns": []
    }
  ]
}
```

Use only these `part` values:

- `upperbody` — tops
- `wholebody_up` — jackets and outerwear
- `lowerbody` — bottoms
- `accessories_up` — accessories
- `shoes` — shoes

Use lowercase hyphenated slugs, six-digit hex colors, at most 12 short lowercase tags, and `null` when there is no genuinely distinct secondary color. Keep working records as `status: "generate"` or `status: "hold"`; change a record to `accepted` only after final QA. The import script ignores every non-accepted record.

### 3. Prepare focused references

For each generated item, crop the strongest view with about 12% padding and preserve enough context to distinguish the target from underlayers. Add at most one complementary crop when it shows important construction unavailable in the primary view. Inspect labeled crop contact sheets before generation.

### 4. Generate evidence-bound cutouts

Use Imagegen with the primary crop and only a genuinely complementary second crop. Ask for the complete empty item centered on a perfectly uniform chroma background with generous padding and no shadow. State the exact source-supported construction and all uncertain details that must be omitted.

Default to `#00ff00`; use `#ff00ff` for green garments unless magenta is prominent. Otherwise choose a maximally distant saturated RGB key. Never use a key color present in the garment.

Save generated chroma images to `$WORK/chroma/SLUG.png`. Compare every result against its source before accepting it.

### 5. Remove the chroma background

Prefer the helper bundled with the built-in Imagegen skill:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/remove_chroma_key.py" \
  --input "$WORK/chroma/SLUG.png" \
  --out "$WORK/items/SLUG.png" \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill \
  --force
```

If removal damages the item, regenerate with a more distant key instead of forcing the matte.

### 6. Verify

For every final PNG, verify:

- PNG format with an RGBA alpha channel
- transparent corners and border
- visible content with padding and no clipped extremity
- no body part, underlayer, adjacent garment, prop, shadow, or chroma halo
- source-faithful category, proportions, color, material, construction, pattern, and marks
- exactly one output for every accepted manifest record

Inspect checkerboard contact sheets of at most 12 items and compare sensitive results individually with their source crops. Regenerate critical or major failures. Mark only passing records `accepted`.

### 7. Generate modeled photos

Use `data/model-reference.png` as the identity reference unless `WARDROBE_MODEL_REFERENCE` points to another local PNG. If neither exists, ask the user for a clear reference photo before continuing. Never add that photo to Git.

Also check for a close-up face/headshot reference at `data/model-reference-face.png` (or `WARDROBE_FACE_REFERENCE`). It's optional, but strongly recommended: a full-body reference alone usually leaves the face as a tiny fraction of the frame, which is the most common cause of identity drift across generations. If it exists, include it as an additional identity image alongside the full-body reference. If it doesn't exist, proceed with the full-body reference alone and mention to the user that adding a face closeup would likely improve consistency.

For every accepted cutout, use Imagegen with the identity image(s) first — full-body reference, then the face closeup if present — and the exact garment PNG last. Save a horizontal 3:2 PNG as `$WORK/modeled/SLUG.png` and set `modeledFile` to `SLUG.png` in the manifest.

Use this generation brief:

```text
Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact clothing item from Image 2. (If a face closeup reference is included, adjust the numbering: it becomes Image 2 and the garment becomes Image 3 — state that explicitly and add: "Image 2 is a close-up of that same person's face; treat it as the primary source for their exact facial identity and do not idealize or alter it.")

Preserve the person's recognizable face, hair, age, build, skin texture, and body proportions. Preserve the featured garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, closure, and distinctive details. Do not redesign, simplify, replace, or reinterpret it.

Use understated neutral supporting clothes that complete the outfit without covering or competing with the featured item. Keep the full featured item and every important detail visible. Use a natural pose with arms and accessories away from it.

Place the person in a tasteful real-world setting with warm professional natural light, realistic shadows, authentic skin and fabric texture, and restrained editorial color grading. Leave environmental breathing room for flexible cropping.

Avoid hidden garment details, invented closures, fake text or logos, extra statement pieces, crossed arms, bags or scarves covering the item, cropped item extremities, extra people, text overlays, watermarks, product-mockup styling, or synthetic AI polish.
```

Vary understated settings across a batch while keeping the identity and art direction cohesive. Compare each photo against both references. Regenerate identity drift, garment redesign, blocked details, anatomy failures, or incorrect framing.

### 8. Import into Wardrobe

Show the user the accepted item count and names before writing when their original request did not explicitly authorize direct import. When direct import was requested, proceed after QA.

Run the bundled deterministic importer from the repository root:

```bash
node .agents/skills/import-clothes/scripts/import-to-wardrobe.mjs \
  --items "$WORK/items" \
  --modeled "$WORK/modeled" \
  --manifest "$WORK/manifest.json"
```

The script validates the cutouts and modeled PNGs, copies them into `data/imported/`, and atomically updates `data/library.json`. It derives stable UUIDs from cutout content, so rerunning an identical import updates metadata and modeled photos without creating duplicates.

Restart the dev server only if the running app does not pick up the database change, then verify the new item count at `/api/import/wardrobe` and visually inspect the gallery.

For cutout-only delivery, create the requested new child folder under the repository root and copy only accepted PNGs into it. Do not write the database.

## Finish

Return the imported count, skipped/held items, absolute database path, and gallery verification result. Display up to 12 final cutouts in chat. Mention any unrecoverable fragments briefly.
