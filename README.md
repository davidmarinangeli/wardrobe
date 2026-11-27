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
<!-- RETAKE: recorded with the old Wardrobe/Outfits/Inspo tab bar -->

The original does three things well:

- Detects every garment in a photo with an AI vision model
- Extracts a clean product cutout from it
- Generates an optional modeled editorial preview of you wearing it

Full credit to [@cdngdev](https://x.com/cdngdev) for the original idea and implementation — this fork builds on top of it.

## What this fork adds

The core import pipeline above is still here, but this fork turns it into a full styling app.

The app has three tabs: **Wardrobe**, **Overview** and **Inspo**. Overview holds everything that groups pieces, in three sections: **Outfits** (where it opens), **Cheat sheets** and **Pieces**.

**Style tools**

- **Outfits** — in Overview › Outfits, **+ Outfit** opens a full-screen piece picker: search by name, color, fabric or tag, narrow with category and tag chips, choose a variant, and watch a live flat-lay preview build up as you pick (a dress or jumpsuit greys out tops and bottoms). Name the look and save it; **Edit** reopens the picker with its pieces already selected. Generate a modeled photo of the full outfit, in Standard or Premium quality, and refine it with a free-text note ("jacket should be darker") to regenerate.
- **Suggest outfits** — **Suggest outfit**, next to **+ Outfit**, asks for an occasion (casual, work, date, sport, event) and returns 3–5 AI-generated combinations pulled from your own wardrobe, each with reasoning about color harmony, weather, and occasion fit. It factors in live local weather and your style profile from Inspo. One click saves a suggestion as a real outfit.
- **Cheat sheets** — build a collection overview: in Overview › Cheat sheets, **+ Cheat sheet** opens the same picker; **Next** takes the selection into the editor, where **Edit pieces** reopens it. Equivalent garments partially overlap while staying recognizable. Add a title and optional description, then use **AI finish** to create a matching background, style the title and harmonize light and shadow. Choose the image model and quality from the same remembered menu used for model photos, and customize the art direction before generating; compare and download the original or AI version separately.
- **Bulk tags** — in Overview › Pieces, select pieces and add or remove a tag on all of them at once.
- **Inspo** — one board for style inspiration and the wishlist pieces detected from it. Paste image URLs or drag in photos from anywhere to save a full look; a "Detect items" action analyzes it and breaks it down into individual garment cutouts. Browse by category — Full Look for the saved photos, or any garment type for the pieces detected out of them.
- **How do I look?** — an AI mirror: upload a photo of yourself actually wearing an outfit and get a fit and color critique, plus swap suggestions pulled from pieces you already own.
- **My Colors** — a quick seasonal color-analysis quiz (undertone + contrast) that assigns you a season palette, refinable by extracting colors from your own photos. Matching wardrobe items get a badge, and it feeds into outfit suggestions.

Select a saved cheat-sheet card to view it fullscreen, or use its pencil button to edit it.

**AI & providers**

- **Choice of provider** — the original shipped on OpenAI only; this fork adds **OpenRouter**, **Gemini** (with a free tier via Google AI Studio), and **MiniMax** as alternatives, configurable with `AI_PROVIDER`.
- **Gemini TEST/PROD mode** — a header toggle that switches between a free, unbilled key for everyday use and a billed key for higher-quality output, with no restart needed.
- **Face reference photo** — an optional close-up face/shoulders photo, sent alongside the full-body reference to sharpen facial identity across generations.
- **Outfit-level and item-level modeled photos** — Standard vs. Premium quality tiers, with regeneration notes.

**Getting set up**

- **In-dashboard onboarding wizard** — the app walks you through picking a provider, saving your API key, and dropping in a reference photo, right in the browser. No hand-editing `.env` or restarting anything yourself — see [Quick start](#quick-start).
- **Bulk import and agent-driven setup** — a script for importing a whole folder of old photos at once, plus Codex skills for hands-off importing and outfit generation. See [AGENTS.md](AGENTS.md).

## See it in action

Each clip plays on loop below. The full-quality MP4 is linked under each one.

<sub>The screenshots and clips were recorded before Outfits moved into Overview; the tabs are now Wardrobe · Overview · Inspo.</sub>

### The wardrobe

![Browsing the wardrobe grid](docs/screenshots/wardrobe.webp)
<!-- RETAKE: recorded with the old Wardrobe/Outfits/Inspo tab bar -->

<sub>[Full quality MP4 →](docs/screenshots/wardrobe.mp4)</sub>

Every piece you import lands here as a clean cutout on its own card, labeled with its category and how many saved looks it appears in. Filter down to tops, jackets, bottoms, accessories, shoes or socks — or to just the pieces that match your season palette — and open any item to see the original photo it came from, its modeled preview, and the outfits built around it; opening one of those looks takes you to Overview › Outfits.

### Overview › Outfits

![Saved outfits in Overview](docs/screenshots/outfits.webp)
<!-- RETAKE: recorded with the old Wardrobe/Outfits/Inspo tab bar -->

<sub>[Full quality MP4 →](docs/screenshots/outfits.mp4)</sub>

<sub>Recorded before Outfits moved into Overview.</sub>

Saved looks, each previewed as a flat lay that scatters into an editorial layout on hover. Overview opens on this section. Build one by hand with **+ Outfit**, which opens a full-screen picker of your pieces with search, category and tag filters, and a live preview of the look; or hit **Suggest outfit** in the same header, pick an occasion, and get AI-generated combinations drawn from your wardrobe with reasoning about color harmony, weather and occasion fit. Any outfit can be rendered as a modeled photo of you wearing the whole look, and refined with a free-text note ("jacket should be darker") to regenerate.

### Inspo and the AI Mirror

![Importing inspo images and asking How do I look](docs/screenshots/inspo-howdoilook.webp)
<!-- RETAKE: recorded with the old Wardrobe/Outfits/Inspo tab bar -->

<sub>[Full quality MP4 →](docs/screenshots/inspo-howdoilook.mp4)</sub>

**Inspo** is a board for looks you want to steal. Paste a batch of image URLs or drag photos in from anywhere, then run **Detect items** to break a saved look down into individual garment cutouts you can browse by category — the wishlist half of your wardrobe.

**How do I look?** is the AI Mirror: upload a photo of yourself actually wearing an outfit and get a fit and color critique — what's working, what isn't — plus swap suggestions pulled from pieces you already own.

### My Colors

![The seasonal color analysis flow](docs/screenshots/armocromia.webp)
<!-- RETAKE: likely recorded in the same session as the others, with the old tab bar -->

<sub>[Full quality MP4 →](docs/screenshots/armocromia.mp4)</sub>

A guided seasonal color analysis. Side-by-side comparisons narrow you down — warm against cool, then depth and contrast — until you land on one of the twelve seasons, and you can refine it further by extracting colors from your own photos. Matching wardrobe items pick up a badge, and the palette feeds straight into outfit suggestions.

## Deep dive: it gets better as you use it

Suggestions aren't generated from a blank slate every time. The app keeps a
private log of things you actually did, and rebuilds a picture of your taste
from it on every run. Nothing here leaves your machine — it all lives in
`data/preferences.json`.

**How it learns**

Only from actions you took. Saving an outfit counts most (you're saying you'll
wear it), hearting a suggestion counts a little less, and passing on one is the
only negative recorded. Adding to the wishlist or pinning inspiration counts
too, more softly. There is deliberately no "you ignored this" signal: without
tracking what you looked at, that would be a guess, not a fact.

Two details matter. Recent actions count for more — a signal is worth half as
much once it's 90 days old, so last spring's phase fades instead of following
you around. And a pass is only written once you can no longer undo it, so a
mis-tap you corrected never counts against a look.

**What improves**

Every run, the log is rolled up into a short description of you that goes into
the prompt alongside the weather, the occasion and your wardrobe:

- **Colors you keep choosing** — and colors that show up in looks you turned down.
- **Combinations you keep choosing** — the pairings are the real fingerprint;
  two people can own the same colors and put them together nothing alike.
- **Details that recur** — the textures, cuts and tags common to your picks.
- **Core pieces** — the items showing up across several saved outfits, so
  suggestions get built around your actual staples.
- **Pieces you've never worn** — owned a while, never in an outfit. The stylist
  is asked to find a way to make one work, as an opportunity, never a nudge to
  buy or a comment on you.

Alongside that, two profiles you build directly: your **Inspo** board is read
once (three pins minimum) into a short description of the aesthetic it points
at, shown back to you in the suggestion panel so you can see what your board is
saying; and your **My Colors** season palette steers which of your pieces get
picked.

Finally, whatever comes back is checked before you see it: outfits that don't
actually dress you, or that break the color rules the Mirror uses, are dropped
rather than shown.

## Quick start

```bash
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). On first run, a setup wizard opens automatically:

1. **Choose a provider** — Gemini is recommended to start, since [Google AI Studio](https://aistudio.google.com/apikey) gives a free key with no billing attached.
2. **Add your key** — pasted into the wizard, saved straight into `.env` on your machine, dev server restarts itself.
3. **Drop in a reference photo** — a clear, full-body photo of yourself (a face close-up is optional but recommended).

That's it — the importer unlocks and you can drag, paste, or choose a photo to bring in your first piece. These steps are for AI imports and generated photos; open the **Archive / Google Drive** shortcut at any wizard step to configure storage without an AI key. Afterwards, the gear icon opens **Settings**: the **AI** tab switches providers, adds keys, flips the Gemini TEST/PROD mode and replaces the reference photos.

Prefer to do it by hand? Copy `.env.example` to `.env`, add `OPENAI_API_KEY` (or your provider's key), and place a PNG reference photo at `data/model-reference.png` — the wizard is just a friendlier way to do the same thing.

Google Drive archive settings live in the **Archive** tab of **Settings** (gear icon), or the shortcut in the wizard. The tab stays greyed out until the four `GOOGLE_DRIVE_*` values are set in `.env`. Drive connection and backup are opt-in; connecting does not turn synchronization on. See [Google Drive archive setup and recovery](docs/google-drive-operations.md) for OAuth configuration, what is copied, and restore behavior. No AI key is needed to configure or use storage.

## Desktop app

Wardrobe also ships as an app for **macOS (Apple Silicon)** and **Windows (x64)**. It runs the server on your computer, opens Wardrobe in its own window, keeps going in the menu bar or tray when you close the window, and has a **Settings** window for keys, storage and options. While it runs you can also use Wardrobe from any browser on the same computer at [localhost:5173](http://localhost:5173).

### Download

Get the latest version from the [Releases page](https://github.com/davidmarinangeli/wardrobe/releases/latest):

| Your computer | File |
| --- | --- |
| Mac with Apple Silicon (M1 or later) | `Wardrobe_<version>_aarch64.dmg` |
| Windows 10 or 11 (64-bit) | `Wardrobe_<version>_x64-setup.exe` |

The other files on the page (`.tar.gz`, `.sig`, `latest.json`) are for the app's built-in updater; you don't need them.

### Install on macOS

The app is not notarized by Apple (this is a hobby project without a paid developer account), so macOS blocks it the first time.

1. Open the `.dmg` and drag **Wardrobe** into **Applications**.
2. Do one of these, once:
   - In Terminal, run `xattr -cr /Applications/Wardrobe.app`, then open Wardrobe normally; or
   - Open Wardrobe, dismiss the warning, then go to **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to the Wardrobe message, and confirm.

You only need this once per downloaded copy. Updates installed from inside the app do not ask again.

### Install on Windows

1. Run `Wardrobe_<version>_x64-setup.exe`.
2. SmartScreen shows "Windows protected your PC", because the installer is not code-signed. Click **More info**, then **Run anyway**.

The installer installs for your user only (no administrator prompt). Wardrobe needs Microsoft Edge WebView2, which Windows 10 and 11 already include; if it is missing, the installer downloads it.

### First launch

1. Wardrobe starts in the menu bar (macOS) or tray (Windows). If you have no AI key yet, the **Settings** window opens by itself; otherwise open it from the menu bar or tray icon › **Settings…**.
2. Under **AI provider**, choose a provider and paste its key. Keys are kept in the macOS Keychain or Windows Credential Manager, never in a file.
3. Optional: under **Storage**, **Import existing data…** copies a `data/` folder from a previous `npm run dev` setup into the app.
4. The Wardrobe window opens. Add your reference photo in the setup wizard as usual.

On macOS, after an update the Keychain may ask once per key whether Wardrobe can use it; choose **Always Allow**.

### Updates

Wardrobe checks for a new version shortly after it starts and every six hours. When one is out, **Settings › Updates** shows what changed, and the menu bar or tray item changes to **Update to vX.Y.Z…**. Click **Install and restart** to update; nothing is installed until you do, and **Skip this version** stops the reminders until the next release. Your wardrobe, settings and keys are kept. On Windows a small installer progress window appears for a few seconds.

### Use it from your phone

With [Tailscale](https://tailscale.com) on the computer and the phone, **Settings › Remote access › Enable remote access** publishes Wardrobe at an HTTPS address only your tailnet can open, with a QR code to scan. Keys and settings stay on the computer. Setup and limits: [docs/tailscale-remote-access.md](docs/tailscale-remote-access.md).

### Where your data lives

| | macOS | Windows |
| --- | --- | --- |
| Wardrobe data | `~/Library/Application Support/app.wardrobe.desktop/data` | `%APPDATA%\app.wardrobe.desktop\data` |
| Settings | `~/Library/Application Support/app.wardrobe.desktop/config.json` | `%APPDATA%\app.wardrobe.desktop\config.json` |
| Cache (background-removal model) | `~/Library/Caches/app.wardrobe.desktop` | `%LOCALAPPDATA%\app.wardrobe.desktop` |
| Logs | `~/Library/Logs/app.wardrobe.desktop` | `%LOCALAPPDATA%\app.wardrobe.desktop\logs` |

Uninstalling the app keeps these folders, so a reinstall finds your wardrobe again: on macOS you just delete Wardrobe from Applications, and the Windows uninstaller leaves them alone unless you tick its **Delete the application data** box. To remove everything, delete them by hand (or tick that box). Keys stay in the Keychain or Credential Manager until you remove them in Settings before uninstalling.

Building the app yourself and publishing releases are covered in [desktop/README.md](desktop/README.md).

## More setup options

Manual `.env` configuration (all providers and variables), the Codex import/outfit skills, the standalone bulk-import script, and agent-specific setup instructions all live in [AGENTS.md](AGENTS.md) — reach for it if you're scripting a setup, importing in bulk, or configuring something the wizard doesn't cover.

## License

[MIT](LICENSE)
