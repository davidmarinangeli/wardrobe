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

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-26 (Windows 11, Node 24.14.1, npm 11), on top of Feature 01 (`8a11275`). Nothing was committed by the coder. No new dependency: `sirv` (added by Feature 01) also serves `/drapes/*`.

### Files

| File | What changed |
| --- | --- |
| `scripts/runtime-config.mjs` | **New.** `CACHE_DIR_ENV` (`"WARDROBE_CACHE_DIR"`), `DEFAULT_CACHE_DIR` (`".cache"`), `MANAGED_CONFIG_ENV` (`"WARDROBE_MANAGED_CONFIG"`), `MANAGED_CONFIG_MESSAGE` (`"Configuration is managed by the Wardrobe desktop app"`), `resolveCacheDir({ root, setting })`, `resolveDrapesDir({ root, cacheDir, setting })` → `<cacheDir>/drapes`, `resolveTransformersCacheDir({ root, cacheDir, setting })` → `<cacheDir>/transformers`, `isManagedConfigValue(value)`, `isManagedConfig(setting)`. Every argument defaults to `process.cwd()` / `process.env`. |
| `scripts/data-import.mjs` | **New.** The `import-data` subcommand: `importDataFolder({ from, to, replace, now })`, `validateImportSource(from)`, `runImportDataCli(argv, { stdout, stderr, now })`, `importTimestamp(date)`, `DataImportError`, `IMPORT_DATA_EXIT`, `IMPORT_DATA_HELP`. |
| `scripts/server.mjs` | `main()` dispatches `argv[0] === "import-data"` to `runImportDataCli`. Health reports `managed` from `WARDROBE_MANAGED_CONFIG`. The handle gains `managed`. New export `PINNED_ENV_KEYS`. The setup plugin gets an `onEnvSaved` hook that reloads `.env` in place (see below). Help text mentions the subcommand and the managed variable. |
| `scripts/api-plugins.mjs` | `apiPlugins({ env, react, onEnvSaved })`; `onEnvSaved` is passed to `wardrobeSetupApi` only. `vite.config.mjs` does not pass it, so Vite behaves as before. |
| `scripts/setup-api.mjs` | Managed mode (409 on `POST /api/setup/config`, `managed` in `GET /api/setup/providers`). New option `onEnvSaved({ envPath, content })`. New export `parseEnvContent(content)` (Node's `util.parseEnv`, the same parser as `--env-file`). |
| `scripts/import-job-api.mjs` | New export `configureTransformersCache(transformers, cacheDir)`. `removeBackgroundML(bytes, { cacheDir })` and `removeUnwornGarmentBackground(bytes, { rotationDegrees, cacheDir })` take the cache directory; the import plugin passes `resolveCacheDir({ root, setting })`. |
| `scripts/variant-api.mjs`, `scripts/wishlist-api.mjs`, `scripts/bulk-import.mjs` | Pass `cacheDir` to `removeUnwornGarmentBackground` (wishlist resolves it from `setting` alone, against the working directory; bulk-import against the repo root). |
| `scripts/color-profile-api.mjs` | Drape portrait directory is `resolveDrapesDir({ root, setting })`. The plugin mounts `/drapes` (before its API handler) in both `configureServer` and `configurePreviewServer`, so Vite dev, Vite preview and the standalone server serve it the same way. |
| `src/onboarding.jsx`, `src/onboarding.css` | Managed read-only states, and the `restarting: false` path (see Frontend). |
| `vite.config.mjs` | `server.watch.ignored: ["**/.cache/**"]` so the dev watcher does not follow the 470 MB model download. No other change. |
| `.gitignore` | `.cache/` added. `public/drapes/` kept, re-commented as a legacy location (deviation 2). |
| `AGENTS.md` | Configuration rows for `WARDROBE_CACHE_DIR` and `WARDROBE_MANAGED_CONFIG`, and one paragraph on `import-data`. |
| `test/desktop-feature02.test.mjs` | Feature tests (13). |

### Cache directory

- Setting: `WARDROBE_CACHE_DIR`, flag `--cache-dir` (already parsed by Feature 01). Default `<root>/.cache`; relative values resolve against `root`. The standalone server puts the absolute value in the shared plugin `env`, so every plugin sees the same directory. Nothing creates the directory up front; each consumer creates its own subfolder on first write.
- `<cacheDir>/transformers`: `@huggingface/transformers` `env.cacheDir`, set right after the dynamic import and before `pipeline()`. `env.allowRemoteModels` is unchanged. The library's `env` is process-global and the pipeline is a process-wide singleton, so the first caller's cache directory wins; all plugins resolve the same one.
- `<cacheDir>/drapes`: `subject.webp` and `subject.json` from `prepareSubject`. `GET /drapes/<name>.webp` is served from there with `sirv` in dev mode (files are looked up per request and sent with `Cache-Control: no-cache` plus an ETag, since the portrait is rewritten when the reference photo changes). Only `GET`/`HEAD` of `/^\/[a-z0-9][a-z0-9_-]*\.webp$/i` is served; `subject.json` and anything else falls through to the next middleware (a 404 under the standalone server). The URL the API returns is still `/drapes/subject.webp`, so the frontend did not change.
- Health already reported `cacheDir` (Feature 01).
- Audit of runtime writes under `root`: the only remaining one is `.env` from `POST /api/setup/config` in unmanaged mode, plus a configured external `WARDROBE_MODEL_REFERENCE`/`WARDROBE_FACE_REFERENCE` path, which `POST /api/setup/reference` also writes when the user set one (unchanged; the desktop shell never sets those). The acceptance test below proves the rest.

### Managed configuration mode

`WARDROBE_MANAGED_CONFIG` is on for `1` or `true` (any case, surrounding spaces ignored); anything else is off. It is read through the usual `setting()` chain, so it works under Vite (`.env` or the environment) and under the standalone server.

| Endpoint | Managed behaviour |
| --- | --- |
| `POST /api/setup/config` | Same-origin check first (`403` cross-origin, unchanged), then `409 {"error":"Configuration is managed by the Wardrobe desktop app","managedBy":"desktop"}`. The body is not read and nothing is written. |
| `GET /api/setup/providers` | `{ provider, configured: { openai, openrouter, gemini, minimax }, managed }`. `managed` is now always present (`false` when off). |
| `GET /api/health` | `managed: true`. Computed once at startup: `WARDROBE_MANAGED_CONFIG` is pinned (see reload). |
| `POST /api/setup/reference` | Unchanged, works. |
| `POST /api/import/mode` | Unchanged, works. The plan calls it `/api/import/ai-mode`; the real route is `/api/import/mode` (`GET` and `POST`, body `{ "mode": "test" \| "prod" }`). |
| Google Drive routes | Unchanged. |

### `.env` reload under the standalone server

- `wardrobeSetupApi({ env, onEnvSaved })`: after writing `.env` it awaits `onEnvSaved({ envPath, content })` and answers `{ saved: true, restarting: false }`. Without the hook (Vite) it answers `{ saved: true, restarting: true }` as before.
- `startServer` passes a hook that parses the written content with `parseEnvContent` (`util.parseEnv`, identical to `node --env-file`) and assigns every non-empty key to the shared `handle.env`. Empty values (`OPENAI_API_KEY=` and the other blanks a `.env` seeded from `.env.example` carries) are skipped: every `setting()` reader treats `""` as unset, and applying them would wipe a key that came from the real environment (review fix). When the base settings object is `process.env` itself (the CLI and `npm run start`), the keys are also written to `process.env`; when a caller passed its own `env` (tests, embedders), `process.env` is left alone.
- `PINNED_ENV_KEYS` = `WARDROBE_DATA_DIR`, `WARDROBE_CACHE_DIR`, `WARDROBE_MANAGED_CONFIG`, `WARDROBE_ALLOWED_HOSTS`: fixed at startup from flags or the parent environment and never changed by a reload.
- Keys deleted from `.env` keep their current values until a restart. The UI never deletes keys, so this only matters for hand edits.

### Frontend

Driven by `GET /api/setup/providers` through a small `useSetupProviders()` hook in `src/onboarding.jsx`. Until it answers, the UI renders the unmanaged form (a click on Save in that window would get the 409 message as an inline error).

- Wizard (`Onboarding`): in managed mode the steps are welcome → provider → photos → done (`MANAGED_STEPS`: four progress dots instead of five). The provider step is `ManagedProviderStep`: it shows the provider the server detected and its key status ("key saved" or "no key yet"), and lists other providers that have a key. Below that is the sentence `MANAGED_KEYS_HINT`: "API keys are managed by the Wardrobe desktop app. Open Settings from the tray icon to change them." There is no form and no Save button, only Back and Continue (to the reference-photo step). With no key at all, a note says imports stay off until a key is added in the desktop app, and the photo step stays reachable. The key step is never rendered. The welcome bullet says the keys stay in the desktop app instead of `.env`.
- Settings › AI (`AiSettings`) and the wizard's done step: the provider list stays visible, but every option is `disabled` (`.provider-switch.is-managed`: default cursor, the provider in use keeps full contrast). Providers without a key say "No key" instead of "Add key →". The same sentence sits under the list as the hint (`aria-describedby`). The Gemini TEST/PROD switch keeps working; its missing-key warning points to the desktop app instead of `.env`. Reference photos work unchanged.
- `restarting`: `KeysStep` and `ProviderSwitcher` now read the response. With `restarting: false` they clear the session note, fetch `/api/import/config` once and continue in place: the wizard moves on, and the switcher shows "Now using X." The "Saving and restarting the dev server…" copy is shown only after a `restarting: true` response, so never in managed mode and never under the standalone server. The previous UI showed the spinner unconditionally; it did not actually key on `restarting`.

### `import-data`

```text
node scripts/server.mjs import-data --from <dir> --to <dataDir> [--replace] [-h|--help]
```

1. `--from` and `--to` are resolved to absolute paths. They must differ, and neither may be inside the other.
2. Source validation (`validateImportSource`) uses `buildArchiveInventory` and `validateArchive` from `scripts/archive-store.mjs`. The source must:
   - be an existing folder and not a symlink;
   - inventory cleanly;
   - pass `validateArchive` (sizes, checksums, catalog shapes, and every referenced media file present and inventoried);
   - contain a `library.json` (decision 3).

   Historical missing sources are warnings, not errors.
3. Target rules:
   - Missing or empty: the import fills it.
   - Contains `library.json`: refused unless `--replace`. With `--replace`, it is renamed to `<to>.before-import-<YYYYMMDDTHHMMSSZ>` (with a `-N` suffix if that name is taken).
   - Non-empty without `library.json` (a skeleton the server leaves after one start: `archive-metadata.json`, empty `imported/`, `.google-drive/archive-coordination/`): moved aside the same way without `--replace`, with a warning (decision 4).
   - A symlink or a file is refused.
4. The copy uses `createArchiveSnapshot({ sourceDir, stagingRoot })` into `<parent>/.<basename>.import-<timestamp>` next to the target, so it is on the same volume. The snapshot copies exactly the inventory (`ARCHIVE_CATALOGS`, the image files under `ARCHIVE_MEDIA_ROOTS` minus dot names and control names, and the canonical `model-reference*.{png,jpg,jpeg,webp}`), verifies every hash, re-validates, and retries if the source changes during the copy. The verified directory is then renamed to `<to>`. The staging root is always removed. If placing it fails after the old target was moved aside, the backup is renamed back. Copied files have mode `0600` and directories `0700` (POSIX), as for every archive snapshot.
5. Output:
   - Success: one JSON line on stdout, `{"files":N,"bytes":N,"warnings":[…],"to":"<abs>","backup":"<abs>"|null}`. `files`, `bytes` and `warnings` are the plan's summary; `to` and `backup` are additions.
   - Failure: one JSON line on stderr, `{"error":{"code":…,"message":…,…}}`. For `archive_invalid` it also carries `errors` (strings) and `historicalMissing`.
   - Writes are flushed before `main()` returns, so the `process.exit()` in `server.mjs` cannot truncate piped output.

| Exit code | Meaning | `error.code` on stderr |
| --- | --- | --- |
| `0` | Imported | (summary on stdout) |
| `1` | Unexpected failure, target is not a folder, target cannot be moved (`target_busy`: "Stop the Wardrobe server and try again") | `import_failed`, `target_invalid`, `target_busy` |
| `2` | Usage error (missing or unknown flag, overlapping folders), or invalid source | `usage` (usage text on stderr for flag errors), `source_missing`, `source_invalid`, `archive_invalid` |
| `3` | Target already holds a wardrobe and `--replace` was not given | `target_populated` |

Never copied, verified by test: `.env`, `.google-drive/` (including `connection.json` and `archive-coordination/`), `jobs/`, `library.json.bak`, `library.json.lock`, `*.tmp` media, hidden media files, and stray folders such as `backup-2025/`.

### Decisions and deviations, with reasons

1. **No counselor was consulted.** The workflow asked for a counselor subagent (model "fable") on real doubts, but this session had no Agent tool, as in Feature 01. A counselor would have reviewed decisions 2 to 6; they are recorded here for the reviewer.
2. **`public/drapes/` stays in `.gitignore`**, re-commented as a legacy location. Nothing writes there any more; the plan allowed removing the entry once that was confirmed. Older checkouts still hold a crop of a personal photo in that folder, though. Un-ignoring it would surface that file to `git add -A`, and `vite build` copies it into `dist/`. Owners should delete the folder by hand (the comment says so).
3. **`import-data` requires a `library.json` in the source.** An empty folder is a valid, empty archive for `validateArchive`. Importing one would silently install an empty wardrobe, which is almost certainly a wrong folder pick in the control panel. `library.json` is also the plan's own marker for a populated target.
4. **A non-empty target without `library.json` is moved aside, not merged and not refused.** The plan defines refusal only by `library.json`. The desktop data directory will usually be a skeleton by the time the user imports, because the server ran once. Merging would mix a stale `archive-metadata.json`/`browser-state.json` with the imported catalogs. Refusing would force `--replace` on every first import. Moving it aside keeps the result identical to a fresh directory and loses nothing. The cost: a Drive connection made before the import stays in the backup's `.google-drive/`, so Drive must be connected again.
5. **The `.env` reload applies the whole parsed file**, not only the saved keys, except `PINNED_ENV_KEYS` and empty values. "Re-read `.env`" in the plan. It differs from a restart in one way: `node --env-file-if-exists` (and Vite's `loadEnv`) let the real process environment win over the file, while the reload lets a non-empty file value override an environment value for the same key until the next restart. The user just saved that file explicitly, so the file wins for the running server.
6. **Exit code `3` for a populated target.** The plan fixes only `2` (invalid archive). A separate code lets Feature 04 offer "Replace" without parsing text. Usage errors stay `2`, consistent with Feature 01's CLI.
7. **`managed` is always present in `/api/setup/providers`**, not only when true, so the frontend never has to treat a missing field as false.
8. **`/drapes` is served by the color-profile plugin**, not by `server.mjs`, so Vite dev, Vite preview and the standalone server share one implementation (the plan offered either).
9. **The cache directory is passed explicitly** (`removeUnwornGarmentBackground(…, { cacheDir })`) from every caller instead of being a module-level setting, because four callers in three plugins and the bulk-import CLI share the singleton pipeline. Callers that pass nothing fall back to `WARDROBE_CACHE_DIR`, then `<cwd>/.cache`.
10. **Model cache migration.** Existing checkouts downloaded BiRefNet into `node_modules/@huggingface/transformers/.cache`. The first unworn-garment import after this change downloads it again (about 470 MB) into `.cache/transformers`. The old folder can be deleted by hand. Not automated: it lives under `node_modules` and disappears on the next clean install anyway.

### Verification run

- `node --test test/desktop-feature02.test.mjs`: 13 pass. It covers:
  - Resolvers and the managed-flag parser.
  - `configureTransformersCache` on a stand-in object (the real library is not loaded, so nothing is downloaded).
  - `parseEnvContent`.
  - **Root untouched.** `startServer` runs on a temporary install root (stub `dist/`, `public/`, `package.json`, no `data/`) with absolute `--data-dir` and `--cache-dir` outside it, and mocked AI (`globalThis.fetch`). It then runs:
    - full-body and face reference uploads;
    - a complete web import: detection, crop approval, garment generation, approval, `library.json` written;
    - `GET /api/color-profile/drapes`, `GET /drapes/subject.webp` (the bytes of `<cacheDir>/drapes/subject.webp`, `image/webp`), the manifest and a traversal answering 404;
    - `POST /api/color-profile/drapes/analyze`.

    After `close()`, the root tree (paths plus SHA-256) is byte-identical to before, and no `.cache/`, `data/` or `public/drapes/` exists under root.
  - **Managed mode.** 409 with the exact body; no `.env`; `providers.managed` and `health.managed` true; keys absent from responses; reference upload saves; `POST /api/import/mode` toggles `test` and back to `prod`; cross-origin still 403.
  - **Unmanaged mode.** `managed: false` in providers and health.
  - **Reload.** A hand-written `.env` with comments and pinned keys. After `POST /api/setup/config`: `{ saved: true, restarting: false }`. The next `providers` call reports the key and provider, and `/api/import/config` reports `hasApiKey`. The comment survives, the pinned `WARDROBE_DATA_DIR` and `WARDROBE_MANAGED_CONFIG` are not applied, and `process.env` is untouched. MiniMax is used because this machine has a real `OPENAI_API_KEY` in its environment, which plugins fall back to; the test skips itself if `MINIMAX_API_KEY` is set.
  - **Vite path.** The setup plugin without the hook still answers `restarting: true`.
  - **`import-data`.**
    - A valid copy, with exact file list, bytes and summary, and every secret or control file absent from the target.
    - Missing media, a corrupt catalog, a folder without `library.json`, a missing source and missing flags: all exit `2` with a JSON report.
    - A populated target exits `3` and is untouched; `--replace` moves it to the timestamped backup.
    - A skeleton target is moved aside with a warning; an empty target is filled directly; nested `--to` is refused.
    - The real CLI (`node scripts/server.mjs import-data …` as a child process): exit codes `0`, `3`, `0` with `--replace`, `2`, and `--help`.
- Related existing suites (`standalone-server`, `setup-providers`, `feature01-review-regressions`, `web-import-originals-acceptance`, `color-profile`): 34 tests, 33 pass, 1 skipped (the POSIX-only `SIGTERM` test).
- `npm run build` passes.
- Full suite, `node --test --test-timeout=60000 test/*.test.mjs`, test by test against `HEAD` (`8a11275`, exported with `git archive` and run the same way):

  | Run | Tests | Pass | Fail | Cancelled | Skipped |
  | --- | --- | --- | --- | --- | --- |
  | Baseline at `HEAD` | 450 | 379 | 69 | 1 | 1 |
  | After this feature | 463 | 397 | 65 | 0 | 1 |

  The 13 new tests all pass. One test passed in the baseline run and failed after: "rolls back a raw-root manual copy with a bounded human snapshot name" (Google Drive feature 04, `sync_state_invalid`). Run alone, it also fails twice in a row on the baseline export, so it is a flaky existing Windows Drive failure, not a regression. Six Drive tests flipped the other way. The remaining failures are the existing Windows problems listed in Feature 01's notes (Drive sync and restore, `/private/tmp` paths, bare `C:\` `import()`, sharp holding files open on Windows cleanup). `npm run check` therefore still cannot pass on Windows.
- `npm run dev` (`--port 5183`, temporary `WARDROBE_DATA_DIR` and `WARDROBE_CACHE_DIR`): `/` and `/api/setup/providers` answer 200 (`managed: false`). A WebP placed in `<cache>/drapes/` is served at `/drapes/subject.webp` with `image/webp` and `Cache-Control: no-cache`. Nothing appeared under the repo's `.cache/` or `public/drapes/`.
- Manual walkthrough, managed. `npm run build`, then `WARDROBE_MANAGED_CONFIG=1 AI_PROVIDER=gemini node scripts/server.mjs --port 5191 --data-dir <temp> --cache-dir <temp>`, with no AI key in the environment. Driven in headless Chrome over CDP because the built-in preview browser timed out.
  - `/api/health` reported `managed: true` and the given paths. A same-origin `POST /api/setup/config` got the 409 body.
  - Wizard welcome: the bullet says keys stay in the desktop app.
  - Wizard "Get started": "STEP 1 OF 2 · AI provider · Gemini · no key yet", then the managed sentence and the "Imports and modeled photos stay off until a key is added there…" note. Only Back and Continue are offered: no key form, no Save.
  - Continue: "STEP 2 OF 2 · Add a reference photo".
  - Settings › AI: the four providers are listed and all `disabled` (Gemini "In use", the others "No key"). The managed sentence sits under the list. The Gemini TEST/PROD switch is active, with the warning "Add the Gemini PROD key in the Wardrobe desktop app (Settings, from the tray icon)." The reference-photo dropzones are present.
  - No "restarting the dev server" copy anywhere.
  - Screenshots were taken but not committed.
- Manual walkthrough, unmanaged standalone. `node scripts/server.mjs --port 5192 --root <temp> --dist ./dist …`, so `.env` was written in a temporary root and never in the checkout. Wizard: Get started → MiniMax → Continue → typed a fixture key → Save & continue. The wizard went straight to "STEP 3 OF 3 · Add a reference photo", with no reload and no restart copy. The temporary `.env` held `AI_PROVIDER=minimax` and the key, and `/api/setup/providers` reported `minimax: true`.

### Pending manual verification

- macOS: `npm run check` passes (it cannot pass on Windows; see Feature 01's notes and the run above).
- A real unworn-garment import (no mock) downloads BiRefNet into `<cacheDir>/transformers` and nothing appears under `node_modules/@huggingface/transformers/.cache`. Not run here: it downloads about 470 MB from Hugging Face.
- The drape view in a real browser session with a real face photo (Color profile › drape test) under `npm run dev` and under `npm run start`, showing the portrait from `/drapes/subject.webp`.
- `npm run dev` (Vite): saving a key in the wizard still restarts Vite, reloads the page and resumes the wizard (the `restarting: true` path; unchanged code, not exercised in a browser here).
- Feature 03/04: the packaged sidecar with `WARDROBE_MANAGED_CONFIG=1` shows the same read-only states inside the Tauri window, and `import-data` run through the sidecar binary on both platforms.

### Notes for later features

- Feature 03: pass `--cache-dir <app cache>` (the server derives `transformers/` and `drapes/` inside it) and `WARDROBE_MANAGED_CONFIG=1` in the environment. Health then reports `managed: true` and the cache path. No `.env` is read or written in managed mode, and the server never writes under `--root`.
- Feature 04, `import-data`:
  - Stop the sidecar before running it on the live data directory, and restart it afterwards. The command renames directories; a running server would keep its in-memory state and, on Windows, can make the rename fail (`target_busy`, exit 1).
  - Parse stdout (exit 0) or the stderr JSON (exit 2 or 3). Offer "Replace" on exit 3, and show `backup` from the summary.
  - Warnings are plain strings.
- Feature 04, cache: clearing the model cache means deleting `<cache>/transformers`. Deleting `<cache>/drapes` is harmless; the portrait is regenerated on the next drape view.
- Feature 04, Archive tab: `src/settings-modal.jsx` still tells the user to put the four `GOOGLE_DRIVE_*` values in `.env` when Drive is unconfigured. In managed mode those values come from the control panel. Feature 04 should reword that message when `providers.managed` is true. It was out of scope here.
- Same for the import popover (found in review): with no key, `src/import-flow.jsx` shows "Setup required: Add your OpenAI API key to `.env` … then restart the app". In managed mode it should point to the desktop app instead. Also out of scope here (the plan names only the wizard and Settings › AI).
- Found while testing, not fixed (existing bug, out of scope): `prepareSubject` in `scripts/draping-service.mjs` fails with "Cannot extract channel 3" when the reference PNG has an alpha channel but is fully opaque. The WebP drops the alpha, then `detectNeck` extracts channel 3. A PNG screenshot used as the face photo would hit it.
