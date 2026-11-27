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
