# Product

<!-- impeccable:product-schema 1 -->

> Written by a delegated agent (step 0a of `docs/impeccable/plan.md`) without a live interview: the init flow's questions could not be asked, so every statement below was inferred from `README.md`, `AGENTS.md`, `docs/` and the code. Everything marked "(da confermare)" needs the owner's confirmation; facts copied verbatim from the docs are not marked.

## Platform

web

The same React/Vite UI ships three ways: in the browser from `npm run dev` / `npm run start`, inside the Tauri desktop app (macOS Apple Silicon, Windows x64), and on a phone through Tailscale remote access. A native wrapper around the web UI does not make its design language native, so the platform stays `web`; the phone layout (bottom nav, sheets) is responsive web.

## Users

- A single person managing their own clothes on their own machine: a local-first, single-user tool, not a shared or social service. (da confermare)
- The owner and anyone who forks the repo and brings their own AI key; technically comfortable enough to run `npm`, paste an API key or let Codex/Claude import for them (AGENTS.md "For agents"). (da confermare)
- Two usage scenes: at a desk (desktop, 1440px class) importing photos, building outfits and cheat sheets; and on the phone, in front of the wardrobe or a mirror, browsing pieces, logging "Wore it today" and asking "How do I look?". (da confermare)

## Product Purpose

Wardrobe turns photos of clothes into a clean, organized digital wardrobe: an AI vision model detects every garment in a photo, extracts a product cutout, and optionally generates a modeled photo of the user wearing it. On top of that catalog the fork adds styling tools: outfits, AI outfit suggestions, cheat sheets (collection overviews), bulk tags, an Inspo board with wishlist pieces detected from saved looks, an AI mirror critique, a seasonal colour analysis and a declutter triage.

Success means the user can find, combine and decide about what they own faster than by opening the wardrobe itself. (da confermare)

## Positioning

- Local-first: originals, cutouts and the database stay on the user's machine; an optional Google Drive backup copies the archive, and AI keys never leave the local `.env` / OS keychain.
- Built on the user's own clothes: suggestions, mirror swaps and colour matches are drawn only from pieces the user already owns, not from a shop catalog. (da confermare: wording of the claim)
- Provider-agnostic: OpenAI, OpenRouter, Gemini (free tier, TEST/PROD keys) and MiniMax, with explicit cost control (Standard vs Premium tiers, a TEST mode that cannot be billed).

## Operating Context

- Three top-level destinations by decision: Wardrobe, Overview (Outfits, Cheat sheets, Pieces) and Inspo. Secondary features (My colours, Declutter) live in hot cards on the Wardrobe page rather than in the nav (`src/components/PageShell.jsx` comment).
- Most actions open a modal or side sheet over the grid: item viewer, outfit viewer, piece picker, Settings, suggestions, colour profile, declutter, cheat-sheet editor, import and mirror popovers, the setup wizard.
- AI calls are slow and can cost money; the UI shows queued imports, background jobs, failures with Retry, and tier/price menus before generation.
- Imports also arrive from outside the UI: `scripts/bulk-import.mjs` and the Codex skills write into the same `data/` library.

## Capabilities and Constraints

- Garment categories: tops, bodysuits, jackets, dresses, jumpsuits, bottoms, skirts, shorts, accessories, shoes, socks (`src/categories.js`).
- Each piece can have several "ways to wear it" (variants) with their own cutout and modeled photo.
- Outfits have pieces, a style memo, style tags, a flat lay or a modeled photo, and a wear log ("Wore it today").
- Declutter unlocks after enough wear-log days; colour profile assigns a season palette and drives the "Matches my colours" filter.
- The desktop app manages provider and keys itself (`WARDROBE_MANAGED_CONFIG`): the web UI then shows them read-only.
- English is the UI language (the round-1 `ui/english-copy` pass). (da confermare: no localization planned)
- UI work must not change behaviour, data, API or factual copy without an explicit decision (`docs/impeccable/plan.md`).

## Brand Commitments

- Name: "Wardrobe". Tagline in README: "Your clothes, extracted and organized with AI."
- Fork of tandpfun/wardrobe; credit to the original author stays in README.
- Visual commitments made binding by the owner for this UI round: keep the current colour palette and the warm glass style with rounded corners (`docs/impeccable/plan.md`, "Vincoli"). The visual detail lives in DESIGN.md.
- Voice: plain, short, second person, sentence case ("Decide what to keep, sell, or give away."). (da confermare)

## Evidence on Hand

- Demo data for UI work: `wardrobe-variants/_demo-data` (20 garments, 5 outfits, 5 inspo pins, 6 wishlist pieces, 2 cheat sheets, a Deep Autumn profile), all flat SVG illustrations, no real photos.
- Screenshots and clips in `docs/screenshots/` (recorded before Outfits moved into Overview, marked RETAKE in README).
- No testimonials, user counts, benchmarks or pricing claims exist; future work must not invent them.

## Product Principles

1. The garment is the content: cutouts and photos lead, chrome recedes. (da confermare)
2. Three destinations, everything else one step away: no new top-level nav for features used a few times a year (from the PageShell comment).
3. AI is explicit and accountable: say what will run, what it costs (tier), and what failed, with a way to retry. (da confermare)
4. Local and reversible: unsaved edits are guarded, destructive actions confirm, the archive is portable. (da confermare)

## Accessibility & Inclusion

No product-specific standard is recorded. The code already follows WCAG-minded patterns (visible focus rings, `prefers-reduced-motion` and `prefers-reduced-transparency` fallbacks, a 16px floor for phone inputs, accessible names on icon buttons); treat WCAG 2.2 AA as the working target. (da confermare)
