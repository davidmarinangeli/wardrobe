# Feature 02 — Managed configuration and data locations

## Scope and ownership

Make the server safe to run from a read-only install location with its data, caches and configuration somewhere else, and add a mode where the desktop shell owns keys and configuration so the web UI stops offering to write `.env`. Also provide the command the shell will use to import an existing `data/` folder.

This feature touches server scripts and the React settings and onboarding code. It does not create the Tauri project.

The CODER owns the cache-directory plumbing, the managed-config mode on the server and in the UI, the data import command, tests, and a short section in `AGENTS.md` listing the new variables.

## Observed state

- `WARDROBE_DATA_DIR` already exists and every plugin resolves it as `path.resolve(root, value)`, so an absolute value works. Confirm with a test rather than by reading.
- `@huggingface/transformers` downloads `onnx-community/BiRefNet-ONNX` (about 470 MB) on first use into `node_modules/@huggingface/transformers/.cache`. The library honours `env.cacheDir` when set before the first `pipeline()` call (`scripts/import-job-api.mjs:626`).
- `scripts/draping-service.mjs` writes `subject.webp` and a manifest under `public/drapes/` and the color-profile API reads `public/drapes` back (`scripts/color-profile-api.mjs:429-439`). The frontend fetches `/drapes/subject.webp`.
- `responsiveImageApi` caches nothing on disk; it reads from `public/` and `dist/`.
- `scripts/setup-api.mjs` writes `.env` in `root` on `POST /api/setup/config` and returns `{ saved: true, restarting: true }`; the UI then shows "Saving and restarting the dev server…" (`src/onboarding.jsx:285,568`). `GET /api/setup/providers` reports which providers have a key.
- `.env.example` is used as the template when `.env` is missing.

## Design

### Cache directory

New setting `WARDROBE_CACHE_DIR` (flag `--cache-dir`). Default `<root>/.cache` for checkouts, so a dev clone keeps working without configuration, and the desktop shell passes `<app data>/cache`. Add it to `.gitignore`.

Consumers:

- Transformers: set `env.cacheDir = path.join(cacheDir, "transformers")` right after the dynamic import and before `pipeline()`. Keep `env.allowRemoteModels` as today.
- Drapes: `draping-service.mjs` and `color-profile-api.mjs` take the output directory from a single resolver `resolveDrapesDir({ root, cacheDir })` → `<cacheDir>/drapes`. Serve `/drapes/*` from that directory in both the Vite plugins (a tiny middleware in the color-profile plugin, or in the shared registry) and the standalone server. Remove the `public/drapes/` entry from `.gitignore` only after confirming nothing else writes there.
- Health reports `cacheDir`.

Nothing else may write under `root` at runtime except `.env` in unmanaged mode. Add a test that runs a full mocked import plus a drape analysis in a temporary root and asserts the root tree is unchanged except for `.cache/`.

### Managed configuration mode

New boolean setting `WARDROBE_MANAGED_CONFIG` (`1`/`true`). When on:

- `POST /api/setup/config` returns `409 { error: "Configuration is managed by the Wardrobe desktop app", managedBy: "desktop" }` without touching the file system.
- `GET /api/setup/providers` adds `managed: true`.
- `GET /api/health` reports `managed: true`.
- `POST /api/setup/reference` (model and face photos) keeps working: those are data, not secrets.
- `POST /api/import/ai-mode` (Gemini TEST/PROD) keeps working: it is server-side state, and switching modes from a phone is a legitimate use.
- Google Drive activation, restore and account connection keep working. The four `GOOGLE_DRIVE_*` values arrive through the environment like every other value.

Frontend, driven by `providers.managed`:

- Onboarding wizard: the provider step shows the detected provider and its key status as read-only text plus the sentence "API keys are managed by the Wardrobe desktop app. Open Settings from the tray icon to change them." The Save button is hidden. If no provider has a key, the wizard still opens but its only action is that sentence; the reference-photo step stays available.
- Settings › AI: same read-only rendering; the provider switcher stays visible but disabled with the same sentence as a hint.
- The "Saving and restarting the dev server…" copy is never shown in managed mode. In unmanaged mode under the standalone server there is no Vite restart either: `scripts/server.mjs` must re-read `.env` on `POST /api/setup/config` (reload `process.env` from the file through a tiny parser, the same `upsertEnvValues` module can host it) and the response becomes `{ saved: true, restarting: false }`. The UI already keys the spinner on `restarting`; confirm and keep.

### Data folder import

Add a subcommand to the standalone entry: `node scripts/server.mjs import-data --from <dir> --to <dataDir> [--replace]`. Behaviour:

1. Validate `<from>` with the archive inventory and validation primitives from `scripts/archive-store.mjs` (Drive Feature 01). Refuse an invalid or incomplete archive with the validation report on stderr and exit code `2`.
2. Refuse when `<to>` already contains a `library.json` unless `--replace`. With `--replace`, move the existing `<to>` to `<to>.before-import-<timestamp>` first.
3. Copy only inventoried files plus the canonical reference photos, with the same allowlist the archive uses. Never copy `.env`, `.google-drive/`, `jobs/`, locks or backups.
4. Print a JSON summary `{ files, bytes, warnings }` on stdout and exit `0`.

The desktop control panel (Feature 04) runs this subcommand through the sidecar and shows the summary.

### Documentation

`AGENTS.md` configuration table gains `WARDROBE_CACHE_DIR` and `WARDROBE_MANAGED_CONFIG` with one-line descriptions. The desktop app itself is documented in Feature 05.

## Implementation sequence

1. Cache directory resolver, transformers cache, drapes relocation, `/drapes` serving in both runtimes, `.gitignore`.
2. Managed mode on the server (`setup-api`, health) and `.env` reload in the standalone server.
3. Frontend read-only states in onboarding and Settings › AI.
4. `import-data` subcommand on top of the archive primitives.
5. Tests, `AGENTS.md`, implementation notes.

## Verification and acceptance

- Test: with `WARDROBE_DATA_DIR` and `WARDROBE_CACHE_DIR` absolute and outside `root`, a mocked import, a reference upload, and a drape analysis write only under those two directories. The root tree is byte-identical before and after.
- Test: with `WARDROBE_MANAGED_CONFIG=1`, `POST /api/setup/config` returns `409` and `.env` is not created; `providers` reports `managed: true`; `POST /api/setup/reference` still saves; `POST /api/import/ai-mode` still toggles.
- Test: without managed mode under `scripts/server.mjs`, saving a key through the API makes the next `providers` call report it as configured, without a restart.
- Test: `import-data` refuses an invalid archive, refuses a populated target without `--replace`, and copies a valid fixture with the expected summary; secrets and control files from the fixture do not land in the target.
- Manual: start the standalone server with managed mode on and walk through the wizard and Settings › AI in the browser; screenshots or a short description go in the notes.
- `npm run check` passes.
