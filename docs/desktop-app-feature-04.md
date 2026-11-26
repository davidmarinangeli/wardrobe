# Feature 04 — Control panel

## Scope and ownership

Fill the control window from Feature 03 with the screens that replace `.env` editing: provider and API keys stored in the keychain, non-secret overrides, storage and cache locations, Google Drive credentials, server status and logs, and general options. The remote-access screen is Feature 07 and the updates screen is Feature 06; this feature leaves labelled placeholders for both.

The CODER owns `desktop/src/` (React), `desktop/src-tauri/src/secrets.rs`, the command surface in `commands.rs`, the capability file, and Rust and frontend tests.

## Design principles

- Secrets never reach the frontend. Commands return `{ present: bool, hint: "…ab12" }`. Setting a secret takes the value once and returns nothing.
- Every change that affects the server calls `server_restart()` and the UI shows the Starting state until health is back. The Wardrobe window reloads itself afterwards (emit `server-ready`; the Rust side calls `webview.reload()` on the `wardrobe` window).
- The panel is deliberately plain: one column, sections in a left rail, system font or the app's Instrument Sans, light and dark through `prefers-color-scheme`. No animation library.
- Copy is in English, matching the web app.

## Secrets (`secrets.rs`)

`keyring` crate, service name `wardrobe` (plus the identifier from Feature 03 on macOS so entries are scoped), one entry per key name. Supported names are exactly the writable set of the web setup API plus Drive: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY_TEST`, `GEMINI_API_KEY_PROD`, `MINIMAX_API_KEY`, `GOOGLE_DRIVE_CLIENT_SECRET`. Anything else is rejected at the command boundary.

Commands: `secret_status() -> Map<name, {present, hint}>`, `secret_set(name, value)`, `secret_delete(name)`. Values are trimmed; empty or multi-line values are rejected. On macOS unsigned builds the Keychain may prompt "Wardrobe wants to use your confidential information" after an update; the panel's help text says to choose Always Allow.

Sidecar environment assembly (`sidecar.rs`): every present secret is exported under its own name. Legacy `GEMINI_API_KEY` is never written; the server's fallback stays for `.env` users.

## Screens

### Status

Server state (Running on port N, Starting, Failed with reason), uptime, version from health, buttons Open Wardrobe, Open in browser, Restart server, Show logs (last 500 lines, monospace, copy button, Open log folder). Data and cache directory paths with Reveal buttons.

### AI provider and keys

- Provider select: OpenAI, OpenRouter, Gemini, MiniMax. Saving writes `provider` in the config store, which becomes `AI_PROVIDER` in the sidecar environment.
- Key fields per provider, rendered as "Not set" or "Set, ends with …ab12", with Replace and Remove. Gemini shows TEST and PROD fields and the sentence from the web app about an unbilled TEST project.
- Reference photos are not here: the web app's Settings keeps them, and a link "Reference photos are managed in Wardrobe › Settings" opens the Wardrobe window.
- Advanced: a textarea of `KEY=value` lines for non-secret overrides (`OPENAI_IMAGE_MODEL`, `GEMINI_IMAGE_MODEL`, `OPENAI_IMAGE_ROUTE`, `WARDROBE_FACE_REFERENCE`, and anything in the `AGENTS.md` table). Validation: `^[A-Z0-9_]+=` per line, no secret names allowed here (reject with the message "use the key fields above"), no `WARDROBE_DATA_DIR`, `WARDROBE_CACHE_DIR`, `WARDROBE_MANAGED_CONFIG`, `WARDROBE_ALLOWED_HOSTS` (owned by the panel). Saved as the ordered `overrides` map.

### Storage

- Data directory: current path, Change… (directory picker through `tauri-plugin-dialog`), with the warning that the server restarts and the new folder is used as-is.
- Import existing data…: directory picker, then runs the Feature 02 `import-data` subcommand through the sidecar binary (not through the running server) and shows the JSON summary or the validation errors. Offers Replace when the target is populated, with the backup path printed.
- Cache: size of `<cache>/transformers` and `<cache>/drapes`, Clear model cache (the next import re-downloads about 470 MB; say so).
- Port: numeric field, default 5173, with the note that the Google Drive redirect URI must match.

### Google Drive

The four values: Client ID, Client secret (keychain), Redirect URI (default `http://localhost:<port>/api/google-drive/oauth/callback`, recomputed when the port changes unless edited), Folder ID. Link to `docs/google-drive-operations.md` on GitHub. Activation, account connection and restore stay in Wardrobe › Settings › Archive, and the screen says so.

### General

Launch at login (autostart plugin), Start hidden in the tray, Open Wardrobe in the app window or in the default browser at launch.

### Placeholders

Remote access (Feature 07) and Updates (Feature 06) sections render a one-line "Coming in a later version" until those features land. They are removed by those features, not kept.

## Implementation sequence

1. `secrets.rs` with a trait over the keyring so tests use the mock store; commands and capability entries.
2. Config commands for overrides, port, data and cache directories, general options; environment assembly in the sidecar manager; restart on change.
3. Frontend screens in the order above, with a small `invoke` wrapper and a state store for server state driven by the `server-state` event.
4. `import-data` integration: a Rust command `data_import(from, replace)` spawns the sidecar binary with the subcommand and returns the parsed summary.
5. First-launch flow: no key present → control window on the AI screen with a short intro; once a key is saved and health is green, open the Wardrobe window.
6. Tests and implementation notes, including the final command list with signatures.

## Verification and acceptance

- Rust tests: secret set, status, delete, rejection of unknown names and multi-line values, environment assembly includes present secrets and overrides and never the rejected names.
- Frontend tests (Vitest with mocked `invoke`): a key shows as Set with the hint and never the value; override validation messages; port validation.
- Manual, both platforms: set an OpenAI key in the panel, open Wardrobe, run one real import, confirm the web Settings › AI shows the managed read-only state and the key works. Remove the key, confirm the server reports the provider as unconfigured after restart.
- Manual: Import existing data from this repo's `data/` into a fresh app data directory; the wardrobe shows the same pieces and outfits; Drive status is "not connected" because `.google-drive/` was not copied.
- Manual: change the port to 5174, confirm the Wardrobe window, the tray "Open in browser" item and the Drive redirect URI default all follow.
- No secret value appears in `server.log`, in the store file, or in the frontend bundle. Grep the log and store after the manual runs and note it.

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-26 (Windows 11, Node 24.14.1, npm 11, rustc 1.99.1), on top of Feature 03 (`03c85ae`). Nothing was committed by the coder.

### Dependencies

- Rust (`desktop/src-tauri/Cargo.toml`):
  - `keyring 3.6.3` with `apple-native` and `windows-native`. The 4.x line (keyring-core) was not used: 3.x has the `keyring::mock` credential store the plan names for tests.
  - `tauri-plugin-dialog` (`"2.7"`, locked at 2.8.4).
- `desktop/package.json` dev dependencies: `vitest 3.2.4` and `jsdom 26.1.0` (Vitest 3 matches the desktop's Vite 6). The root `package.json` has no new dependency.

### Files

| File | What changed |
| --- | --- |
| `desktop/src-tauri/src/secrets.rs` | `KeyringSecretStore` (keychain), `KEYRING_SERVICE`, `SECRETS_BACKEND_ENV`; `SecretStatus` gains `error`. `MemorySecretStore` stays for tests and the memory mode. |
| `desktop/src-tauri/src/config.rs` | `GoogleDriveConfig`, `GoogleDrivePatch`, `OpenTarget`, `DRIVE_ENV_KEYS`, `DRIVE_CALLBACK_PATH`, `default_drive_redirect_uri(port)`, `validate_drive`, `validate_redirect_uri`. `DesktopConfig` gains `google_drive` and `open_wardrobe_in`; `ConfigPatch` gains the same as options. Methods `effective_drive_redirect_uri()` and `drive_env(client_secret_present)`. |
| `desktop/src-tauri/src/sidecar.rs` | `build_env` exports the Drive values. New: `SidecarManager::command()`, `ImportOutcome`, `import_data_args`, `parse_import_output`, `run_import_data`, `IMPORT_TIMEOUT` (15 min). |
| `desktop/src-tauri/src/storage.rs` | **New.** `CacheStatus`, `CacheFolder`, `cache_status`, `clear_model_cache`, `dir_size`, `is_empty_wardrobe`. |
| `desktop/src-tauri/src/lib.rs` | Keychain store at setup, `AppState.secrets_persistent`, `AppState.lifecycle` (serializes start, restart and stop-run-start), `with_server_stopped`, `import_data`, `clear_model_cache`, dialog plugin, launch target, new commands registered. |
| `desktop/src-tauri/src/commands.rs` | New commands (below); `ConfigView` and `AppInfo` gain fields. |
| `desktop/src-tauri/src/windows.rs` | Control window 780×720 (minimum 600×480) instead of 520×720, for the section rail. |
| `desktop/src-tauri/build.rs`, `capabilities/control.json` | The seven new commands and their `allow-*` permissions, for the `control` window only. No dialog or opener permission is granted to the frontend: both plugins are called from Rust. |
| `desktop/src-tauri/tests/import_data.rs` | **New.** `import-data` through `run_import_data` with `node` and the repo's `scripts/server.mjs`. |
| `desktop/src/App.jsx` | The panel: rail with Status, AI provider, Storage, Google Drive, General, Remote access, Updates. |
| `desktop/src/api.js` | A wrapper for every command, plus `errorText`. |
| `desktop/src/hooks.js` | **New.** `useServerState()` (driven by `server-state`), `useAction()`. |
| `desktop/src/components.jsx` | **New.** `Section`, `ErrorText`, `PathRow` (Reveal), `SecretField`. |
| `desktop/src/validation.js` | **New.** Validation that mirrors `config.rs` (`parseOverrides`, `validatePort`, `validateRedirectUri`, `validateFolderId`, `validateClientId`, `validateSecretValue`), plus formatting helpers and the provider list. |
| `desktop/src/sections/{StatusSection,AiSection,StorageSection,DriveSection,GeneralSection}.jsx` | **New.** The screens. `GeneralSection.jsx` also exports `PlaceholderSection`. |
| `desktop/src/styles.css` | Rail layout, light and dark through `prefers-color-scheme`, system font. |
| `desktop/vite.config.mjs`, `desktop/package.json` | A Vitest `test` block (jsdom, `test-ui/**/*.test.{js,jsx}`). `npm test` = `node --test test/*.test.mjs && vitest run`; `npm run test:ui` = `vitest run`. |
| `desktop/test-ui/validation.test.js`, `desktop/test-ui/panel.test.jsx` | **New.** Frontend tests. |
| `desktop/README.md` | "Control panel" section, keychain locations, test commands. |
| `src/settings-modal.jsx`, `src/onboarding.jsx` | The Archive tab's "not configured" message points to the desktop control panel when `providers.managed` is true (the Feature 02 note). `useSetupProviders` is now exported. |
| `AGENTS.md` | One sentence on the Archive tab in the desktop app. |

### Commands

All commands are in `commands.rs`, listed in `build.rs`, and granted only to the `control` window. Feature 03's commands keep their signatures; the new ones are:

```rust
async fn server_health(app: AppHandle) -> Option<Health>                    // /api/health of the running port, 1.5 s timeout
async fn data_import(app: AppHandle, from: String, replace: bool) -> Result<ImportOutcome, String>
async fn cache_status(app: AppHandle) -> Result<CacheStatus, String>
async fn cache_clear_models(app: AppHandle) -> Result<CacheStatus, String>  // stops the server, deletes <cache>/transformers, starts it
async fn pick_directory(app: AppHandle, title: Option<String>, start: Option<String>) -> Result<Option<String>, String>
fn reveal_location(app: AppHandle, location: String) -> Result<(), String>  // "data" | "cache" | "logs" | "config"
fn open_help(app: AppHandle, topic: String) -> Result<(), String>           // "google-drive"
```

From JS: `invoke("data_import", { from, replace })`, `invoke("pick_directory", { title, start })`, `invoke("reveal_location", { location })` and `invoke("open_help", { topic })`.

Unchanged commands, with their Feature 04 behaviour:

- `secret_status() -> BTreeMap<String, SecretStatus>`. `SecretStatus { present, hint, error? }`: `error` appears only when the keychain read failed, and never contains the value.
- `secret_set(name, value) -> Result<(), String>` and `secret_delete(name) -> Result<(), String>` write the keychain and restart the server.

Payloads (field names as serialized):

- `ImportOutcome` (camelCase, tagged by `status`):
  - `{ status: "imported", files, bytes, warnings, to, backup }`
  - `{ status: "targetPopulated", to, message }` (exit 3)
  - `{ status: "failed", exitCode, code, message, errors }` (`archive_invalid` carries the validation errors)
- `CacheStatus { cache_dir, transformers: { path, exists, bytes }, drapes: {…} }` (snake_case).
- `ConfigView` gains `drive_redirect_uri` (the effective one) and `default_drive_redirect_uri` (for the current port).
- `AppInfo.secrets_persistent` is true for the keychain. `AppInfo` gains `platform`, which is `std::env::consts::OS` (`"macos"` or `"windows"`).
- `DesktopConfig` (`config.json`) gains:
  - `google_drive: { client_id, redirect_uri: null | string, folder_id }`
  - `open_wardrobe_in: "window" | "browser"`

  `ConfigPatch.google_drive` takes optional `client_id`, `redirect_uri` and `folder_id`. An empty `redirect_uri` goes back to the port default.

### Secrets

- Service name `KEYRING_SERVICE`, one entry per secret name (user = the name). It must never change.
  - Windows: `"wardrobe"`. Credential Manager shows generic credentials `OPENAI_API_KEY.wardrobe`, and so on.
  - macOS: `"wardrobe (app.wardrobe.desktop)"`. This is "service `wardrobe` plus the identifier" from the plan.
- `KeyringSecretStore` keeps one `keyring::Entry` per name and caches each value after the first successful read. The keychain is therefore read at most once per name per launch, which limits macOS access prompts. Errors are not cached.
  - Deleting a missing entry is not an error.
  - The six names and the value rules are unchanged from Feature 03: trimmed, non-empty, single line. Unknown names are rejected at the command boundary.
- `WARDROBE_DESKTOP_SECRETS=memory` (any build) selects the session-only `MemorySecretStore` instead of the keychain, and the AI screen then shows a warning. It exists so that the app can be exercised on a machine whose keychain must not be touched. That is how it was run here.
- Environment assembly in `build_env`, in this order:
  1. The inherited environment minus the stripped keys.
  2. `WARDROBE_MANAGED_CONFIG=1`.
  3. The overrides.
  4. The Drive values.
  5. `AI_PROVIDER`.
  6. Every present secret, under its own name.

  `GEMINI_API_KEY` is never written; an inherited one still passes through, for `.env`-style setups.

### Behaviour worth knowing

- **Restarts.** Every server-affecting change goes through `restart_sidecar` or `with_server_stopped`. Both, and the launch-time `start_sidecar`, hold `AppState::lifecycle` (added in review): a restart requested while an import or a cache clear runs (a key, a setting, the Restart button) waits for it to finish instead of starting the server in the middle of it. Each first calls `stop()` outside the lock, so a start that is still waiting for health is interrupted as in Feature 03, then stops again under the lock. The panel follows `server-state`, and the rail shows "Starting on port N…". On each state or port change the panel re-reads `app_info`, `get_config` and `secret_status`. On Running, the Wardrobe window is navigated to the (possibly new) port, which reloads it. Feature 03 already did this.
- **First launch.** Without a provider key the panel opens on the AI screen with a short intro. Adding a key for the provider shown in the select first saves that provider (`set_config({ provider })`), then the key. Two restarts follow. The first Running state with a key opens Wardrobe: in the window or in the default browser, per `open_wardrobe_in`.
- **Google Drive values.** They are exported only when at least one Drive value is configured (client ID, folder ID, an edited redirect URI, or the client secret).
  - When any is configured, the redirect URI is always exported. By default it is `http://localhost:<port>/api/google-drive/oauth/callback` and follows the port.
  - With nothing configured, nothing is exported. Otherwise the server would see a lone redirect URI and report `configuration_incomplete`.
  - Validation mirrors `scripts/google-drive-auth.mjs`:
    - The redirect URI is https, or http on a loopback host, on the callback path, with no query or fragment.
    - The folder ID is 5 to 200 characters of `[A-Za-z0-9_-]`.
    - The client ID is one word of at most 512 characters.
  - `GOOGLE_DRIVE_CLIENT_ID`, `_REDIRECT_URI` and `_FOLDER_ID` are rejected as overrides with "set it in the Google Drive section".
- **Overrides textarea.** Each line must be `KEY=value`. Blank lines and `#` lines are skipped and not kept. Values are trimmed. Rejected lines:
  - Secret names (including `GEMINI_API_KEY`): "use the key fields above".
  - `AI_PROVIDER`: points to the Provider select.
  - Shell-owned keys.
  - Drive keys.
  - Duplicates.

  Rust validates again.
- **Import existing data.**
  1. The folder picker runs in Rust.
  2. `data_import` stops the server and runs `<node> <script> import-data --from <dir> --to <data dir> [--replace]`. In a release build the Node is the packaged sidecar and the script is `server.cjs`; in a debug build it is `node` from PATH and `scripts/server.mjs`. The environment is the inherited one without the stripped keys, plus `WARDROBE_MANAGED_CONFIG=1`, with no secrets. The working directory is the data directory's parent.
  3. Afterwards it starts the server again.
  4. The panel shows the summary, the backup path and warnings, or the validation errors. On `targetPopulated` it offers Replace.
- **Clear model cache** deletes only `<cache>/transformers`, with the server stopped. Drapes, logs and `EBWebView` are kept.
- **Status** shows the version and uptime (from `server_health`, refreshed every 30 s), Open Wardrobe, Open in browser and Restart server. It also shows the data and cache paths with Reveal, and the last 500 log lines with Copy, Refresh and Open log folder.

### Decisions and deviations, with reasons

1. **The fresh server skeleton is imported over without asking.** The server writes `library.json` (`[]`) on its first start. Every first import into the app's data directory therefore came back as `targetPopulated` (observed in the manual run), which contradicts Feature 02's assumption in its deviation 4.
   - `storage::is_empty_wardrobe(data_dir)` is true when `library.json` is an empty array, `imported/` holds no file, `outfits.json`, `inspo.json`, `wishlist.json` and `cheat-sheets.json` are absent or empty arrays, and there is no `model-reference*` file and no `.google-drive/` folder. In that case `import_data` passes `--replace`. (The catalog, reference-photo and Drive checks were added in review, so that a user who set a reference photo, a wishlist or a Drive connection before importing still gets the Replace prompt.)
   - The skeleton still goes to a `data.before-import-<time>` backup, so nothing is deleted.
   - A real wardrobe still gets the Replace prompt.
2. **Drive's non-secret values are dedicated config fields, not overrides.** The plan lists the four values as their own screen. A structured `google_drive` field lets the redirect URI default follow the port, and keeps the Drive screen and the overrides from fighting over the same keys.
3. **`open_wardrobe_in` is a new config field.** The plan's General option ("open Wardrobe in the app window or in the default browser at launch") had no field in Feature 03's config. It applies only to the automatic open at launch; the tray and the panel buttons keep their meaning.
4. **The dialog and the opener run from Rust commands**, not from the JavaScript plugin APIs. The control window's capability gains no plugin permissions. `reveal_location` only opens the app's own four folders, and `open_help` only opens fixed URLs.
5. **The control window is 780×720**, so a left rail fits next to one column.
6. **The keychain is read through a per-session cache**, because every command that checks for keys (`has_provider_key`, `launch_spec`, `secret_status`) would otherwise hit the keychain again.
7. **`SecretStatus.error`** (optional) lets the panel say "The keychain could not be read" instead of a misleading "Not set" when access is denied.
8. **`cache_clear_models` stops the server.** On Windows a loaded ONNX model can keep files locked, and the transformers pipeline singleton would keep stale state.
9. **No counselor was consulted.** The workflow asked for a counselor subagent (model "fable"), but this session had no Agent tool, as in Feature 03. A counselor would have reviewed decisions 1, 2 and 6, and the keychain service name.

### Verification run (Windows 11, x86_64-pc-windows-msvc)

- **`cargo test`** in `desktop/src-tauri`: 31 unit tests, 1 import-data integration test and 8 lifecycle tests, all pass. `cargo clippy --all-targets` reports no warnings, and `cargo fmt --check` is clean. The new tests cover:
  - The keyring store against the `keyring` crate's mock store: set, status and delete; the value reaching the entry trimmed; a missing entry deleting cleanly; and rejection of unknown names, the legacy `GEMINI_API_KEY`, empty and multi-line values.
  - A mock keychain error surfacing without the value and not being cached.
  - `present()` never exporting names outside `SECRET_NAMES`.
  - Environment assembly: present secrets, overrides and Drive values are included; `GEMINI_API_KEY` and unconfigured Drive keys are not.
  - Drive validation, and the redirect URI following the port until edited.
  - Drive keys rejected as overrides; `open_wardrobe_in` not restarting the server.
  - Cache sizes and clearing only `transformers/`, and the empty-skeleton check.
  - Import outcome parsing, plus the real `import-data` run: imported without `.env`, `targetPopulated`, replace with backup, and `archive_invalid` with its errors.
- **`npm test`** in `desktop/`: 7 script tests and 21 Vitest tests pass. The Vitest tests render the real `App` with `@tauri-apps/api/mocks` `mockIPC`, including events. They check:
  - A key shows as "Set, ends with …ab12", the stored value never appears, and after Replace the typed value is gone from the DOM and every input.
  - Remove asks for confirmation first.
  - First launch opens the AI screen with the intro; choosing Gemini then adding a TEST key saves the provider first.
  - Override messages appear for a secret, a malformed line and a shell-owned key, and a valid save sends the ordered entries.
  - Port validation shows "Enter a port number between 1 and 65535." and blocks the save, and the redirect hint follows the typed port.
  - The panel follows `server-state` events, and the placeholders render.
  - The import result views render.
- **`npm run build`** passes in `desktop/` and at the root.
- **Related root tests** (`standalone-server`, `desktop-feature02`, `setup-providers`, `feature01-review-regressions`): 35 tests, 34 pass, 1 skipped (the POSIX `SIGTERM` test).
- **Full root suite**, `node --test --test-timeout=60000 test/*.test.mjs`: 463 tests: 400 pass, 62 fail, 1 skipped.
  - Every failure is in a file already known to fail on Windows (Features 01 to 03): `google-drive-feature02` (25), `google-drive-feature03` (16), `google-drive-feature04` (15), `archive-store` (2), `bulk-import-archive-acceptance` (2), `mirror-fixtures` (1) and `mirror-invariants` (1).
  - No failing file touches the code this feature changed. `npm run check` therefore still cannot pass on Windows.
- **`npm run tauri dev`**, run with `OPENAI_API_KEY` removed and `WARDROBE_DESKTOP_SECRETS=memory`, so the real keychain was never touched. It was driven over WebView2's remote debugging port. The app data folders did not exist before and were deleted afterwards. Results:
  - **First launch:** only the control window opened, on the AI screen with the intro.
  - **Secret commands:**
    - `secret_set("PATH")` was rejected, and so was a multi-line value.
    - An `OPENAI_API_KEY` override was rejected with "use the key fields above".
    - Setting a fake OpenAI key restarted the server and opened the Wardrobe window with the empty wardrobe. `/api/setup/providers` then reported `openai: true, managed: true`.
    - `secret_status` returned only `present` and `hint: "…9z9z"`.
  - **IPC from the Wardrobe window:** `invoke("secret_status")` was refused by the ACL.
  - **Port and Drive:**
    - One `set_config` changed the port to 5174 and set the Drive client ID and folder ID; then the client secret was set.
    - 5173 closed and 5174 answered. The Wardrobe window moved to `http://localhost:5174/`, and `drive_redirect_uri` became `http://localhost:5174/api/google-drive/oauth/callback`. `/api/google-drive/status` reported `configured: true`.
    - Later, the port was changed to 5175 by typing into the Storage form and submitting it. The server, the Wardrobe window and the redirect hint all followed.
  - **`data_import`** with a temporary fixture (`library.json` plus a `.env`), not the repo's `data/`:
    - Before deviation 1: `targetPopulated` on the fresh skeleton, then `imported` with a backup after `replace: true`. A relative path was rejected.
    - After deviation 1: `imported` directly, with a backup.
    - The server was Running after each import.
  - **`cache_clear_models`:** a fake 5000-byte `transformers/` was deleted, and `logs/` and `EBWebView/` were kept. The app log shows stop, clear, start.
  - **Key removal:** after `secret_delete("OPENAI_API_KEY")`, `/api/setup/providers` reported `openai: false`, and `has_provider_key` was false.
  - **Key entered through the UI form:** it showed "Set, ends with …7q7q" and the value was not in the page HTML. The Wardrobe window opened on the new port.
  - **Web Settings › Archive** (managed mode, Drive incomplete because the memory secret was lost on the rebuild) shows the new desktop-panel wording.
  - **Secret leak check:** the fake key values appear in none of `config.json`, `server.log`, `desktop.log`, the `tauri dev` output, or the built `desktop/dist`.
  - **Shutdown:** after the app was killed, the sidecar exited and released the port. No Run-key autostart entry and no Credential Manager entry named `wardrobe` existed afterwards.

### Pending manual verification

- **macOS** (nothing was run on macOS):
  - Keychain storage under `wardrobe (app.wardrobe.desktop)`.
  - The "wants to use your confidential information" prompt after an update, and Always Allow.
  - The folder picker.
  - Reveal in Finder.
  - The menu-bar wording.
  - CI `desktop-rust` with `keyring`'s `apple-native` feature.
- **Windows with the real Credential Manager:** set, replace and remove a key from the panel, confirm the `OPENAI_API_KEY.wardrobe` generic credential, and confirm it survives an app restart and a reinstall. This run used the memory store on purpose.
- **Plan manual steps, both platforms:**
  - Set a real OpenAI key in the panel, open Wardrobe, run one real import, and confirm that web Settings › AI shows the managed read-only state and that the key works.
  - Remove the key and restart: the provider shows as unconfigured. That last part was observed here with a fake key.
- **Import from a real `data/` folder into a fresh app data directory:** the same pieces and outfits should show, and Drive should be "not connected". It was done here with a temporary fixture only, because the real `data/` must not be touched. The native picker was not exercised; the IPC call was.
- **Clicks that open OS windows were not run:** Reveal, Open log folder, the Setup guide link, and the native folder dialogs (Change… and Import existing data…).
- **Launch at login** from the General screen, and **Start hidden**. Launch at login writes the registry or a LaunchAgent and was not toggled. Start hidden was saved through `set_config` only.
- **Open Wardrobe in the default browser at launch:** saved and then reverted. The browser launch itself was not observed.
- **Copy** in the log viewer (clipboard in WebView2 and WKWebView).
- **Release build** (`npm run prepare:app && npm run tauri build`) with the keychain store, and `import-data` through the packaged Node sidecar on both targets.
- **CI:** `desktop-smoke` now also runs Vitest through `npm test`. `desktop-rust` compiles `keyring` and the dialog plugin on macOS and Windows. Neither job ran here.

### Notes for later features

- **Feature 06:** replace `PlaceholderSection id="updates"` in `App.jsx` (the `SECTIONS` entry `updates`) with the real screen, and add its commands to `build.rs` and `capabilities/control.json`.
- **Feature 07:**
  - Replace the `remote` placeholder the same way.
  - `set_config({ allowed_hosts })` already restarts the server.
  - An https tailnet redirect URI is accepted by `validate_redirect_uri`, should Drive from a phone ever be revisited.
- **Opening a folder or URL from the panel:** use a Rust command with a fixed allowlist (like `reveal_location` and `open_help`) rather than granting `opener:*` or `dialog:*` to the control window.
