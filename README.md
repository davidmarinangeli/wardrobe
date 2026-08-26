<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.
- **Any other agent (no Codex available):** Run `scripts/bulk-import.mjs` (see below) — it does the same folder-of-photos → deduplicated wardrobe workflow without depending on Codex's built-in `imagegen` tool.

## Bulk import without Codex

`scripts/bulk-import.mjs` imports a whole folder of outfit photos in one run, using the same `AI_PROVIDER`/`OPENAI_*`/`GEMINI_*` settings as the web app. It detects every garment in every photo, uses one extra AI call to spot the same physical item worn in multiple photos (so it isn't imported twice), generates cutouts (and modeled photos, if `data/model-reference.png` exists), and writes straight into `data/library.json`.

```bash
npm run bulk-import -- --input ~/Pictures/old-wardrobe-photos --dry-run
npm run bulk-import -- --input ~/Pictures/old-wardrobe-photos
```

Run with `--dry-run` first to see what would be imported without writing anything. See `npm run bulk-import -- --help` for all options.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `AI_PROVIDER` | `openai` (or `gemini`, `minimax`) |
| `OPENAI_API_KEY` | Required if `AI_PROVIDER=openai` |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `GEMINI_API_KEY_TEST` | Required for TEST mode if `AI_PROVIDER=gemini` |
| `GEMINI_API_KEY_PROD` | Required for PROD mode if `AI_PROVIDER=gemini` (falls back to `GEMINI_API_KEY`) |
| `GEMINI_API_KEY` | Legacy alias for `GEMINI_API_KEY_PROD` |
| `GEMINI_VISION_MODEL` | `gemini-3.6-flash` |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` |
| `GEMINI_IMAGE_SIZE` | `1K` |
| `MINIMAX_API_KEY` | Required if `AI_PROVIDER=minimax` |
| `MINIMAX_API_BASE_URL` | `https://api.minimax.io/v1` |
| `MINIMAX_IMAGE_MODEL` | `image-01` |
| `MINIMAX_IMAGE_RESPONSE_FORMAT` | `base64` |
| `MINIMAX_IMAGE_ASPECT_RATIO` | Optional; takes priority over the stage's width/height |
| `MINIMAX_PROMPT_OPTIMIZER` | `false` |
| `MINIMAX_IMAGE_SEED` | Optional integer seed |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_FACE_REFERENCE` | `data/model-reference-face.png` (optional) |
| `WARDROBE_DATA_DIR` | `data` |

Set `AI_PROVIDER=gemini` to run the import pipeline on Gemini instead of OpenAI. `gemini-2.5-flash-image` ("Nano Banana") has a free tier (up to 500 images/day via a [Google AI Studio](https://aistudio.google.com/apikey) key, no credit card). For higher-quality output at a small per-image cost, set `GEMINI_IMAGE_MODEL` to `gemini-3.1-flash-image` or `gemini-3-pro-image` ("Nano Banana 2" / "Nano Banana 2 Pro").

### Face consistency

Modeled photos are only as good as the identity signal the model gets. `data/model-reference.png` is usually a full-body shot, so the face ends up as a tiny fraction of the frame — often the real reason a generated face drifts between generations. If a PNG exists at `WARDROBE_FACE_REFERENCE` (default `data/model-reference-face.png`, a close crop of the head and shoulders), it's automatically sent as an extra reference image alongside the full-body photo, and the prompt is adjusted to treat it as the primary source for facial identity. It's optional and silently skipped if absent.

Set `AI_PROVIDER=minimax` to run the garment and modeled-photo image generation through MiniMax's `/v1/image_generation` endpoint instead. Reference images (the garment, or the model photo plus garments) are mapped to `subject_reference`; both `url` and `base64` response formats are decoded into the same review pipeline. Use `https://api.minimaxi.com/v1` for the China endpoint, and set `MINIMAX_GARMENT_MODEL` / `MINIMAX_MODELED_MODEL` to override `MINIMAX_IMAGE_MODEL` per stage. Clothing detection and outfit-style analysis still use the OpenAI vision model regardless of `AI_PROVIDER`.

### TEST / PROD mode

When `AI_PROVIDER=gemini`, the app header shows a TEST/PROD toggle (persisted server-side, no restart needed). TEST mode calls Gemini with `GEMINI_API_KEY_TEST` and refuses to run the paid "premium" model photo tier — point that key at a Google Cloud project with **no billing account attached** so it's free-tier-only and physically can't be charged, even by mistake. PROD mode uses `GEMINI_API_KEY_PROD` (or the legacy `GEMINI_API_KEY`) and unlocks the premium tier. The mode defaults to PROD so existing single-key setups keep working; switch to TEST for day-to-day development.

## License

[MIT](LICENSE)
