# Feature 06 — In-app updates

## Scope and ownership

Let an installed app discover a newer GitHub release, show it, and install it on request. Uses `tauri-plugin-updater` against the `latest.json` published by Feature 05. The whole bundle updates at once: shell, server bundle, Node binary and native modules are all inside the application bundle.

The CODER owns the updater configuration, the Rust update commands, the Updates screen in the control panel, the tray entry, and the real two-version verification.

## Design

### Configuration

`tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/davidmarinangeli/wardrobe/releases/latest/download/latest.json"],
    "pubkey": "<public key from Feature 05>",
    "windows": { "installMode": "passive" }
  }
}
```

`createUpdaterArtifacts: true` in the bundle section, which is what makes Feature 05 produce the `.tar.gz` and `.sig` files. Capability: the `control` window gets `updater:default`; the `wardrobe` window gets nothing.

### Behaviour

- Check 15 s after launch, then every 6 hours while running, and on demand from the tray item "Check for updates…" and the control panel button.
- Result states exposed through the `update-state` event and the `update_state()` command: `UpToDate { current }`, `Available { version, date, notes }`, `Downloading { received, total }`, `Ready`, `Failed { reason }`. The last check time is stored in the config store so the panel can show "Checked 3 minutes ago".
- `Available` shows in the control panel Updates section with the release notes (Markdown from the GitHub release body as carried in `latest.json`), an Install and restart button, and a Skip this version link that stores the skipped version. The tray item text changes to "Update to vX.Y.Z…".
- Install: stop the sidecar first (so no file in the bundle is in use on Windows), then `update.download_and_install()`, then `app.restart()`. If install fails, restart the sidecar and surface `Failed`.
- Network errors on the automatic checks are silent except in the panel's last-check line. Manual checks show the error.
- No automatic installation. The owner chose explicit consent.

### Unsigned macOS

The updater replaces `Wardrobe.app` in place with the contents of the downloaded `.tar.gz`. The download is performed by the app itself, so it carries no quarantine attribute, and the new bundle is ad-hoc signed by CI. This is expected to launch without a Gatekeeper prompt but has not been proven for this project. The acceptance criteria below prove it.

## Implementation sequence

1. Plugin, config, capability.
2. Rust: `UpdateManager` with the state machine, scheduler, commands `update_check()`, `update_install()`, `update_skip(version)`, `update_state()`.
3. Control panel Updates section replacing the Feature 04 placeholder; tray item wiring.
4. Two-version verification with real tags, as below.
5. Implementation notes, including what happened on macOS after the in-place replacement.

## Verification and acceptance

- Unit: state transitions and skip logic with a mocked updater response.
- Real run: publish `v0.1.0` and install it on both platforms from the release page. Publish `v0.1.1` with a visible change (the version string in the control panel is enough). On both machines: the app shows `v0.1.1` as available within the launch check, Install and restart replaces the app, the new version starts, the Wardrobe window opens, the data directory and keys are intact. On macOS there is no Gatekeeper prompt after the update, or, if there is one, the notes record it and the README gets the extra step.
- A user who skipped `v0.1.1` is not nagged until `v0.1.2` exists.
- Killing the network during a download produces `Failed` and leaves the installed version working.

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-27 (Windows 11, Node 24.14.1, npm 11, rustc 1.99.1), on top of Feature 05 (`9e94df2`). The coder did not commit, tag, push or publish anything.

### Dependencies

- Rust: `tauri-plugin-updater = "2.12"` in `desktop/src-tauri/Cargo.toml`, locked at **2.14.1** (default features: rustls, system proxy, zip). It requires Rust 1.90, so the crate's `rust-version` went from 1.80 to **1.90**.
- No JavaScript dependency. The panel never uses `@tauri-apps/plugin-updater`; it only calls the four Rust commands below. The root `package.json` and `desktop/package.json` are unchanged.

### Files

| File | What changed |
| --- | --- |
| `desktop/src-tauri/tauri.conf.json` | `plugins.updater` gains `endpoints` (the `latest.json` URL below), `requireSignedVersion: true` and `windows.installMode: "passive"`. `pubkey` stays `""` until the owner commits it (Feature 05). `createUpdaterArtifacts` stays in `tauri.release.conf.json` (Feature 05, deviation 1). |
| `desktop/src-tauri/src/updates.rs` | **New.** `UpdateCore` (pure state machine), `UpdateManager` (orchestration, persistence, events), the traits `UpdateBackend` and `InstallHost`, `PluginBackend` (the real updater), `tray_item`, `auto_check_enabled`, `remove_stale_installers`, constants, and 13 unit tests. |
| `desktop/src-tauri/src/lib.rs` | Registers the plugin. In setup it reads the updater's `config.json` keys, builds the `UpdateManager` (managed state), wires its listener (tray plus `update-state` event), starts the scheduler, and cleans stale installer folders. Adds `AppInstallHost`, `install_update`, `tray_updates_clicked`, `set_store_value`, and the "first launch after an update" rule. |
| `desktop/src-tauri/src/commands.rs` | `update_state`, `update_check`, `update_install`, `update_skip`. `open_help` also accepts `"releases"`. |
| `desktop/src-tauri/src/windows.rs` | The tray item `check-for-updates` is enabled and wired. `Tray` gains `updates`. New: `update_tray_updates`, `open_control_at(app, section)`, `SECTION_UPDATES`, `SHOW_SECTION_EVENT`. |
| `desktop/src-tauri/build.rs`, `capabilities/control.json` | The four commands and their `allow-update-*` permissions, for the `control` window only. **No `updater:default`** (deviation 1). |
| `desktop/src/sections/UpdatesSection.jsx` | **New.** The Updates screen, replacing the Feature 04 placeholder. |
| `desktop/src/markdown.jsx` | **New.** A small Markdown-to-React renderer for release notes (no HTML injection; links render as text). |
| `desktop/src/App.jsx` | Opens on `#<section>` from the URL, listens to `show-section`, shows the Updates rail badge, renders `UpdatesSection`. Remote access stays a placeholder. |
| `desktop/src/api.js`, `hooks.js`, `validation.js`, `styles.css` | Wrappers `updateState`, `updateCheck`, `updateInstall`, `updateSkip`, `onUpdateState`, `onShowSection`; hook `useUpdateStatus()`; helpers `formatAgo`, `lastCheckLabel`; Updates styles. |
| `desktop/test-ui/panel.test.jsx` | Seven new tests (Updates screen and Markdown); the old placeholder test now covers Remote access only. |
| `desktop/scripts/release.mjs`, `desktop/test/release.test.mjs` | New export `updaterEndpoint(repo)`. `release.mjs check` also requires `plugins.updater.endpoints` to be exactly `[updaterEndpoint()]` and `requireSignedVersion` to be `true`. The tests cover both checks and the committed config. |
| `desktop/README.md` | New "Updates" section; the Control panel, Tests and Release assets text updated. |
| `README.md` | New "Updates" subsection under "Desktop app". |

### Configuration

```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/davidmarinangeli/wardrobe/releases/latest/download/latest.json"],
    "pubkey": "",
    "requireSignedVersion": true,
    "windows": { "installMode": "passive" }
  }
}
```

- `requireSignedVersion` follows Feature 05's suggestion. The CLI writes `version:<v>` into every `.sig` trusted comment, and `release.mjs latest-json` already checks it. With it, an older signed build cannot be served under a newer version number. No release exists yet, so no old unversioned signature can break this.
- `releases/latest` ignores drafts and prereleases. An installed app sees a release only after it is published.
- The plugin needs no other config. `tauri build` without the overlay still works with an empty `pubkey` (verified below).

### Environment variables

- `WARDROBE_DESKTOP_UPDATE_CHECKS=on|off`: forces the automatic checks on or off. By default they run in **release builds only** (deviation 4). Manual checks always work.
- `WARDROBE_DESKTOP_SECRETS=memory` (Feature 04) was used for every local run.

### `config.json` keys

These are owned by the updater, are not part of `DesktopConfig`, and are written with `store.set` or `store.delete`. `DesktopConfig::from_entries` ignores them.

- `update_last_check`: Unix seconds of the last successful check.
- `update_skipped_version`: for example `"0.1.1"` (`v` prefix and whitespace are normalized away). Removed by "Stop skipping".
- `update_installed_from`: the running version, written just before the installer runs and removed if the install fails. The next launch logs `updated from X to Y`, removes the key, exposes it as `updatedFrom` (left `null` when it equals the running version, which means the installer failed after the app exited), and **ignores `--hidden` and `start_hidden` once**. The plugin restarts the app with the same arguments (`/ARGS` on Windows, `process::restart` on macOS), so an autostarted, hidden copy would otherwise come back with no window, and the acceptance step "the Wardrobe window opens" would fail.

### Rust surface

`commands.rs` (listed in `build.rs` and granted only to `control`):

```rust
fn update_state(updates: State<UpdateManager>) -> UpdateStatus
async fn update_check(app: AppHandle) -> Result<UpdateStatus, String>      // manual check; Err only while installing
async fn update_install(app: AppHandle) -> Result<UpdateStatus, String>    // Err only when nothing is available / busy
fn update_skip(updates: State<UpdateManager>, version: Option<String>) -> Result<UpdateStatus, String>  // null = stop skipping
```

From JS: `invoke("update_skip", { version: "0.1.1" | null })`. The other three take no arguments.

`UpdateStatus` uses camelCase JSON, and the state is flattened into it:

```text
{ state: "idle" | "upToDate" | "available" | "downloading" | "ready" | "failed",
  // available:   version, date (latest.json pub_date), notes (Markdown), skipped
  // downloading: version, received, total (null when unknown)
  // ready:       version
  // failed:      reason, version (null for a failed manual check, the version for a failed install)
  current, checking, lastChecked, lastFailure: { at, reason } | null,
  skippedVersion, autoCheck, updatedFrom }
```

The plan's five states are all present. `idle` (no check finished yet) was added, and checking is a flag rather than a state, so an automatic check does not hide an offered update while it runs.

The `update-state` event carries the same payload on every change. Download progress is throttled to one event per 200 ms.

`updates.rs`:

- **Constants:** `FIRST_CHECK_DELAY` (15 s), `CHECK_INTERVAL` (6 h), `AUTO_CHECK_ENV`, `STORE_LAST_CHECK`, `STORE_SKIPPED`, `STORE_INSTALLED_FROM`. Network timeouts: connect 15 s, and a **per-read** timeout of 30 s rather than a total one, so a slow 60 MB download still finishes while a dead connection fails.
- **`UpdateCore` transitions:**
  - `begin_check(manual) -> Result<bool>`. A manual request joins a running check, and its failure is then shown.
  - `finish_check(result, now)`. Automatic failures only set `lastFailure`; manual failures become `failed`. A success clears `lastFailure`.
  - `skip(Option<&str>)`, `begin_install() -> Result<version>` (only from `available`, never while checking), `progress`, `downloaded`, `fail_install`.
  - A check is refused while installing, and an install is refused while checking.
- **`UpdateManager`:**
  - Construction: `new(core, backend, persist)` or `with_clock(...)`, then `set_listener`.
  - Calls: `status()`, `check(manual)`, `skip(version)`, `install(&dyn InstallHost)`. All are blocking; the commands run them on `spawn_blocking`.
- **`UpdateBackend`:** `check()`, `download(version, &mut progress)` and `install()`. `PluginBackend` keeps the `Update` and the bytes between calls. It uses `app.updater_builder()`, so the plugin's default `on_before_exit` (`cleanup_before_exit`) still runs before the Windows exit. It refuses to download when `pubkey` is empty, with a message that sends the user to the release page.
- **`InstallHost`:** `install_with_server_stopped(&mut install)` and `restart_app()`. `AppInstallHost` in `lib.rs` implements it:
  1. Stops the sidecar and takes `AppState::lifecycle`, so no restart can start the server during the install.
  2. Writes `update_installed_from`.
  3. Runs the install.
  4. On failure, removes the key and starts the server again.

  `restart_app` calls `AppHandle::request_restart()`. That is used instead of `restart()`, which diverges, so `RunEvent::Exit` still runs.
- **`tray_item(status) -> (text, enabled)`:**

  | Status | Text | Enabled |
  | --- | --- | --- |
  | `available`, not skipped | `Update to vX.Y.Z…` | yes |
  | `downloading` | `Downloading update… N%` | no |
  | `ready` | `Installing update…` | no |
  | a check is running | `Checking for updates…` | no |
  | anything else | `Check for updates…` | yes |
- **Error wording:** `describe()` maps reqwest timeout, connect and body errors to "The connection timed out / could not be reached / was lost during the download (…)", and `ReleaseNotFound` (a 404 or an unparsable `latest.json`) to "No release information was found at the update server." Download failures are prefixed "The download failed:", install failures "The update could not be installed:".
- **Installer cleanup:** `remove_stale_installers(temp_dir, product)` runs at launch on a background thread. It deletes `<temp>/Wardrobe-<ver>-updater-*` folders (deviation 5).

`lib.rs`:

- `pub fn install_update(app) -> Result<UpdateStatus, String>`.
- `pub fn tray_updates_clicked(app)`: opens the control window on Updates (`open_control_at(app, Some("updates"))`). Unless an update is already offered or installing, it also starts a manual check on a thread. The tray never installs.
- The scheduler is a plain thread: it sleeps 15 s, then checks, sleeps 6 h, and repeats.

Install sequence:

1. `available` → `downloading`: download and verify while the server keeps running (deviation 2).
2. `ready`: stop the server under the lifecycle lock and write the marker.
3. `install()`:
   - **Windows:** the plugin writes the installer to `%TEMP%\Wardrobe-<ver>-updater-XXXXXX\`, runs `cleanup_before_exit`, and starts it with `/P /UPDATE /R /ARGS <args>`. The process then exits, and NSIS restarts the app.
   - **macOS:** the bundle is replaced in place, then `request_restart()`.
4. On failure: `failed { version }`, and the server is started again.

### Control panel

- **Updates section:**
  - Header: "This is Wardrobe vX", plus "Updated from vY" on the first launch after an update.
  - The state body:
    - Up to date.
    - Available: version, release date, release notes as Markdown in a scrolling box, **Install and restart**, and a **Skip this version** link.
    - Skipped: "You skipped vX", with **Install vX anyway** and **Stop skipping**.
    - Downloading: a progress bar and percentage.
    - Ready: "Installing… Wardrobe will restart".
    - Failed: the reason, and for a failed install "This version keeps working".
  - Buttons: **Check for updates** and **All releases** (`open_help("releases")`).
  - The last-check line: "Checked 3 minutes ago", "Last check failed 2 minutes ago: …" or "Not checked yet". It is re-rendered every 30 s.
  - A note when automatic checks are off in the build.
- **Rail:** the Updates item shows a badge while an unskipped update is offered.
- **Opening on a section:** a new control window opens on the section in `index.html#updates`. An open one gets the `show-section` event (`core:event:default` already allows listening).

### Decisions and deviations, with reasons

1. **The control window does not get `updater:default`.** The plan grants it, but the panel never needs the plugin's JavaScript API: it calls the four Rust commands. Granting it would let the control webview call `plugin:updater|download_and_install` directly, which bypasses the sidecar stop (files in use on Windows), the state machine, the skip logic and the marker. That also contradicts Feature 04's rule of no plugin permissions for the frontend. The local run confirmed the result: `plugin:updater|check` from the control window is refused by the ACL ("Permissions associated with this command: updater:allow-check, updater:default"), and the Wardrobe window is refused `update_check` and `update_install`.
2. **The download runs before the server stops; the plan said stop first, then `download_and_install()`.** The plugin's `download()` and `install()` are separate calls, and only `install()` touches the bundle. With the download first, a network failure (the plan's "killing the network during a download") leaves the server running and the app untouched, and the user never waits 30 s or more with a dead server. The server stops only for `install()`, which is the step the plan's Windows file-in-use concern is about. If `install()` fails, the server is started again, as planned.
3. **Skipped versions stay visible but quiet.** A check that finds the skipped version reports `available` with `skipped: true`: no tray text, no rail badge, and only a one-line note in the panel with "Install anyway" and "Stop skipping". A newer version (`0.1.2`) has `skipped: false` and is offered normally. The skip is not cleared automatically, so it stays recorded as `0.1.1`, which is harmless.
4. **Automatic checks run in release builds only.** A `tauri dev` build has the repository version and runs from `target/debug`. Offering to "update" it would run a real installer over a development tree. `WARDROBE_DESKTOP_UPDATE_CHECKS=on` turns them on for testing; that is how the scheduler was verified below.
5. **Stale installer folders are deleted at launch.** On Windows the plugin creates the folder with `tempfile::Builder::tempdir().keep()` and calls `std::process::exit(0)` right after starting the installer, so nothing ever deletes it, and the installer (62 MB for a real release) stays in `%TEMP%`. This was observed in the local run. The next launch deletes `Wardrobe-*-updater-*` folders; a folder still in use is left for a later launch.
6. **The first launch after an update ignores `--hidden` and `start_hidden`.** See `update_installed_from` above.
7. **`release.mjs check` now also guards the updater config:** the exact endpoint and `requireSignedVersion: true`. A tag can therefore never ship an app that polls the wrong place.
8. **`idle` state and the `checking` flag** were added to the planned states (see "Rust surface"). Commands return the status even for handled failures; `Err` is reserved for refused requests, so the panel renders a single source of truth.
9. **No counselor was consulted.** The workflow asked for an Agent-tool counselor (model "fable"), but this session had no Agent tool, as in Features 03 to 05; a tool search found none. Deviations 1, 2 and 4 are the ones a counselor would have reviewed. They were settled by reading the plugin source (`tauri-plugin-updater` 2.14.1 `updater.rs` and `config.rs`, and `tauri` 2.12.7 `AppHandle::restart` and `request_restart`) and by the local run below.

### Verification run (Windows 11, x86_64-pc-windows-msvc)

- **`cargo test`** in `desktop/src-tauri`: 44 unit tests (13 of them new, in `updates::tests`), 1 import-data test and 8 lifecycle tests, all pass. `cargo clippy --all-targets` reports no warnings, and `cargo fmt --check` is clean. The updater tests drive a scripted `MockBackend` (mocked `latest.json` responses, download and install results) and a `MockHost` that records server stops and starts. They cover:
  - Idle, then up to date, then available, with `lastChecked` persisted and the event stream.
  - The flat camelCase JSON.
  - Silent automatic failures (an offer is kept), and manual failures becoming `failed`.
  - A success clearing the failure.
  - A manual check joining a running one.
  - **Skip:** `0.1.1` skipped is not nagged, including after a restart that reads `config.json` back, and `0.1.2` is offered with the tray text. Stop skipping works.
  - **Install order:** `download → stop server → install → restart app`.
  - **A failed download:** the server is never stopped.
  - **A failed install:** `stop → install → start server`.
  - Refusals (install while checking, check or skip while installing), progress percentages and tray texts.
  - `remove_stale_installers`.
  - Version normalization and the auto-check switch.
- **`npm test`** in `desktop/`: 18 node tests (release script, including the new endpoint checks) and 28 Vitest tests pass. The new Vitest tests cover:
  - Check on demand, then the release notes rendered as Markdown. A raw `<img onerror>` in the notes stays text.
  - The rail badge, then Install and restart.
  - Skip, then Stop skipping (with the badge gone while skipped).
  - `update-state` events for progress and a failed install, which re-enables Check for updates.
  - Opening on `#updates` and on `show-section`.
  - A manual check that joins a running one: its late `checking: true` reply does not overwrite the result the event already delivered (added in review round 1; the panel now ignores such a reply).
  - The last-check wording, and the Markdown renderer.
- **`npm run build`** passes in `desktop/` and at the root.
- **`node desktop/scripts/release.mjs check --tag v1.0.0`:** exit 1 with only "plugins.updater.pubkey is empty", so the new endpoint and `requireSignedVersion` checks pass on the committed config.
- **`npm run tauri build`** (no overlay, no signing key, empty `pubkey`): exit 0, `Wardrobe_1.0.0_x64-setup.exe` (63.09 MiB). Local builds keep working with the plugin registered.
- **Real plugin, end to end, without publishing.** Setup:
  - `npm run tauri dev -- --config <overlay>`, with `plugins.updater.endpoints = ["http://127.0.0.1:8765/latest.json"]`, `dangerousInsecureTransportProtocol: true` and a throwaway `pubkey`.
  - A local Node server serving `latest.json` (version 1.0.1, Markdown notes, `windows-x86_64` and `windows-x86_64-nsis`) and a "setup.exe".
  - The setup.exe was a tiny program that only writes its arguments to a file and exits. It was signed with `tauri signer sign --app-version 1.0.1`.
  - The app ran with `WARDROBE_DESKTOP_SECRETS=memory` and the provider keys removed from its environment. It was driven over WebView2's remote debugging port.
  - The app data folders did not exist before and were deleted afterwards, together with the throwaway key.

  Results:
  - `update_state` was `idle`. `update_check` returned `available` with version, date and notes, and `update_last_check` appeared in `config.json`.
  - The panel rendered "Wardrobe v1.0.1 is available", "Released November 27, 2026", the notes (heading, bold, the link as text), Install and restart, Skip this version, "Checked just now" and the auto-check note. The rail showed the badge.
  - `update_skip("1.0.1")` gave `skipped: true`, with `update_skipped_version` stored. A re-check stayed skipped; `update_skip(null)` cleared it.
  - **Dropped connection mid-download:** `failed`, "The download failed: The connection was lost during the download (error decoding response body)". `/api/health` was still answering.
  - **Stalled connection** (half the file, then silence): `failed` after **31 s** (the read timeout), with the server still up.
  - **Tampered artifact:** "The signature verification failed". Server still up.
  - **Signature without `version:`:** rejected by `requireSignedVersion`. Server still up.
  - **`latest.json` 404 on a manual check:** `failed`, "No release information was found at the update server.", with `lastFailure` set.
  - **Successful install:**
    - `server.log` shows `stopping the server` → `server stopped (exit code 0)` → `installing an update: server stopped`.
    - `config.json` gained `update_installed_from: "1.0.0"`.
    - The fake installer ran with **`/P /UPDATE /R /ARGS`**, and the app process exited.
    - Port 5173 closed, and no node or Vite process was left.
  - **Next launch with `--hidden`:** logged `updated from 1.0.0 to 1.0.0`. The control window opened despite `--hidden`, the marker was removed, `lastChecked` was kept, and `update_state.updatedFrom` was `"1.0.0"`. (Review round 1 since made `updatedFrom` `null` when the version did not change, as here with a fake installer; the window still opens.)
  - **ACL:**
    - `plugin:updater|check` from the control window was refused.
    - After a fake MiniMax key opened the Wardrobe window, `update_check` and `update_install` from it were refused ("allowed on: [windows: \"control\", URL: local]").
  - **Automatic checks** with `WARDROBE_DESKTOP_UPDATE_CHECKS=on`: `idle` at 5 s and `available 1.0.1` at about 19 s, matching the local server's request log (the 15 s first check).
  - The plugin's leftover `%TEMP%\Wardrobe-1.0.1-updater-OONtgO\Wardrobe-1.0.1-installer.exe` was found, which led to deviation 5, and deleted.
- **Release executable** (`target/release`, real GitHub endpoint, which answers 404 because nothing is published): about 15 s after launch, the automatic check failed silently. The state stayed `idle`, `lastFailure` was "No release information was found at the update server.", and the panel showed "Last check failed just now: …".
- **Root:** `npm run build` passes. `node --test test/standalone-server.test.mjs test/desktop-feature02.test.mjs` gives 24 pass and 1 skipped. This feature changed no root code. The full suite, `node --test --test-timeout=60000 test/*.test.mjs`, gives 463 tests: 391 pass, 70 fail, 1 cancelled, 1 skipped, the same totals as Feature 05. Every failure is in a file already known to fail on Windows: `google-drive-feature02` to `04`, `archive-store`, `bulk-import-archive-acceptance`, `mirror-fixtures` and `mirror-invariants`.

### Pending manual verification

- **Owner setup (Feature 05):**
  - Generate the updater keypair, commit `plugins.updater.pubkey`, and add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  - Set the root version for the first real release (`npm version 0.1.0`). It is still `1.0.0`, which is newer than the plan's `v0.1.x`, so a `1.0.0` build would never see `0.1.1` as an update.
- **The plan's real two-version run on both platforms:**
  1. Publish `v0.1.0` and install it from the release page on a Mac and a Windows PC.
  2. Publish `v0.1.1` with a visible change. Remember to refresh `latest.json` with the notes before publishing (Feature 05, deviation 5).
  3. On both machines, check:
     - `v0.1.1` shows within the launch check, with the tray reading "Update to v0.1.1…".
     - Install and restart replaces the app, the new version starts, the Wardrobe window opens and Settings › Updates says "Updated from v0.1.0".
     - The data directory, `config.json` and keychain entries are intact.
- **macOS after the in-place replacement:** whether Gatekeeper prompts. It is expected not to, because the app downloaded the file itself and it carries no quarantine attribute. If it does, record it here and add the step to `README.md` › Desktop app. Also check:
  - The Keychain "Always Allow" prompt after the update (Feature 04).
  - That `request_restart()` relaunches the new bundle.
  - That single-instance does not block the relaunch.
- **Windows with the real NSIS installer:** the passive progress window, `/R` restarting the app, and the current-user install directory being replaced while `%APPDATA%` and Credential Manager stay. Also check that the next launch deletes the `%TEMP%\Wardrobe-<ver>-updater-*` folder. Here a fake installer stood in, and the real `Wardrobe_<ver>_x64-setup.exe` was never run.
- **Skip across real releases:** skip `v0.1.1`, restart, confirm no tray text or badge, then publish `v0.1.2` and confirm it is offered.
- **Network killed during a real download:** Wi-Fi off mid-download should give `failed` within about 30 s with the app still working. Here it was simulated with a local server that drops or stalls the connection.
- **Tray clicks** (not automatable here): "Check for updates…" opens Settings › Updates and checks; "Update to vX.Y.Z…" opens it without checking; the disabled progress texts appear during an install. The tray text logic itself is unit-tested.
- **CI:** `desktop-rust` compiling `tauri-plugin-updater` (rustls) on macOS and Windows; nothing was pushed.
