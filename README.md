<div align="center">

# Wardrobe

Your clothes, extracted and organized with AI.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

## About the original project

This is a fork of [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe), a local-first app with a simple idea: drop in a photo of a clothing item, let AI cut it out into a clean product shot, and generate an editorial photo of you wearing it. Everything — originals, cutouts, and the wardrobe database — stays on your machine.

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

The original does three things well:

- Detects every garment in a photo with an AI vision model
- Extracts a clean product cutout from it
- Generates an optional modeled editorial preview of you wearing it

Full credit to [@cdngdev](https://x.com/cdngdev) for the original idea and implementation — this fork builds on top of it.

## What this fork adds

The core import pipeline above is still here, but this fork turns it into a full styling app.

**Style tools**

- **Outfits** — combine wardrobe pieces (top, bottom, jacket, shoes, socks, accessory) into saved looks, previewed as a flat lay that reveals a scattered editorial layout on hover. Generate a modeled photo of the full outfit, in Standard or Premium quality, and refine it with a free-text note ("jacket should be darker") to regenerate.
- **Suggest outfits** — pick an occasion (casual, work, date, sport, event) and get 3–5 AI-generated combinations pulled from your own wardrobe, each with reasoning about color harmony, weather, and occasion fit. It factors in live local weather and your style profile from Inspo. One click saves a suggestion as a real outfit.
- **Inspo** — one board for style inspiration and the wishlist pieces detected from it. Paste image URLs or drag in photos from anywhere to save a full look; a "Detect items" action analyzes it and breaks it down into individual garment cutouts. Browse by category — Full Look for the saved photos, or any garment type for the pieces detected out of them.
- **My Colors** — a quick seasonal color-analysis quiz (undertone + contrast) that assigns you a season palette, refinable by extracting colors from your own photos. Matching wardrobe items get a badge, and it feeds into outfit suggestions.

**AI & providers**

- **Choice of provider** — the original shipped on OpenAI only; this fork adds **Gemini** (with a free tier via Google AI Studio) and **MiniMax** as full alternatives, configurable with `AI_PROVIDER`.
- **Gemini TEST/PROD mode** — a header toggle that switches between a free, unbilled key for everyday use and a billed key for higher-quality output, with no restart needed.
- **Face reference photo** — an optional close-up face/shoulders photo, sent alongside the full-body reference to sharpen facial identity across generations.
- **Outfit-level and item-level modeled photos** — Standard vs. Premium quality tiers, with regeneration notes.

**Getting set up**

- **In-dashboard onboarding wizard** — the app walks you through picking a provider, saving your API key, and dropping in a reference photo, right in the browser. No hand-editing `.env` or restarting anything yourself — see [Quick start](#quick-start).
- **Bulk import and agent-driven setup** — a script for importing a whole folder of old photos at once, plus Codex skills for hands-off importing and outfit generation. See [AGENTS.md](AGENTS.md).

## Quick start

```bash
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). On first run, a setup wizard opens automatically:

1. **Choose a provider** — Gemini is recommended to start, since [Google AI Studio](https://aistudio.google.com/apikey) gives a free key with no billing attached.
2. **Add your key** — pasted into the wizard, saved straight into `.env` on your machine, dev server restarts itself.
3. **Drop in a reference photo** — a clear, full-body photo of yourself (a face close-up is optional but recommended).

That's it — the importer unlocks and you can drag, paste, or choose a photo to bring in your first piece. Reopen the wizard any time from the gear icon in the header, to switch providers, add a face reference, or check your setup.

Prefer to do it by hand? Copy `.env.example` to `.env`, add `OPENAI_API_KEY` (or your provider's key), and place a PNG reference photo at `data/model-reference.png` — the wizard is just a friendlier way to do the same thing.

## More setup options

Manual `.env` configuration (all providers and variables), the Codex import/outfit skills, the standalone bulk-import script, and agent-specific setup instructions all live in [AGENTS.md](AGENTS.md) — reach for it if you're scripting a setup, importing in bulk, or configuring something the wizard doesn't cover.

## License

[MIT](LICENSE)
