# Feature 03 — Tauri shell and Node sidecar

## Scope and ownership

Create the desktop application: a Tauri 2 project under `desktop/` that ships Node and the server from Feature 01 as a sidecar, starts it with the locations and flags from Feature 02, shows the Wardrobe UI in a window, and lives in the tray or menu bar. The control panel content is Feature 04; this feature only gives it an empty window and the Rust commands it needs for server status.

The CODER owns `desktop/` (Rust, Tauri config, build scripts, control-panel frontend scaffold), the server bundling script, CI changes needed to build the sidecar on both targets, and the developer workflow documentation in `desktop/README.md`.

## Constraints

- Targets: `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`.
- Node version is pinned in one file, `desktop/node-version.txt`, to the current Node 24 LTS patch. The CI job for the web app may keep Node 22; the sidecar version is independent.
- Native modules to ship: `sharp` with its `@img/sharp-<os>-<cpu>` and `@img/sharp-libvips-*` packages, `onnxruntime-node` with only the target platform's `bin/napi-v6/<os>/<cpu>` folder, `@huggingface/transformers` (JavaScript, but it `require`s `onnxruntime-node` and cannot be bundled cleanly), `ipx` (depends on `sharp`). Everything else is bundled into one file.
- The installed bundle is read-only in practice. Every writable path comes from `app_data_dir()`, `app_cache_dir()`, `app_config_dir()`, `app_log_dir()`.
- Loading `http://127.0.0.1:5173` in WKWebView requires `NSAllowsLocalNetworking` under `NSAppTransportSecurity` in the app `Info.plist`. Tauri merges a `desktop/src-tauri/Info.plist` into the bundle.
- `localhost` and `127.0.0.1` are secure contexts in both WebView2 and WKWebView, so camera and clipboard features of the web app keep working in the window.

## Layout

```text
desktop/
  package.json              tauri CLI, control-panel Vite app (React), esbuild, scripts below
  node-version.txt          e.g. 24.11.1
  scripts/
    bundle-server.mjs       esbuild: ../scripts/server.mjs → src-tauri/resources/server/server.cjs
    install-native.mjs      npm install of the native packages for a target into resources/server/node_modules
    fetch-node.mjs          downloads the pinned Node for a target into src-tauri/binaries/node-<triple>[.exe]
    prepare.mjs             runs the three above plus `npm run build` at the repo root and copies ../dist → resources/web
  src/                      control-panel frontend (React, Vite), see Feature 04
  src-tauri/
    Cargo.toml, tauri.conf.json, build.rs, Info.plist, capabilities/
    binaries/               node-aarch64-apple-darwin, node-x86_64-pc-windows-msvc.exe (git-ignored)
    resources/server/       server.cjs, package.json, node_modules/ (git-ignored), web/ (dist copy, git-ignored)
    src/
      main.rs, lib.rs
      sidecar.rs            SidecarManager: spawn, readiness, restart, stop, log ring buffer
      config.rs             typed config on top of tauri-plugin-store
      secrets.rs            keyring access (Feature 04 fills it; this feature stubs get/set/delete)
      windows.rs            wardrobe window, control window, tray
      commands.rs           #[tauri::command] surface used by the control panel
```

### Server bundle

`bundle-server.mjs` runs esbuild with `platform: "node"`, `format: "cjs"`, `target: "node24"`, `bundle: true`, `external: ["sharp", "@img/*", "onnxruntime-node", "@huggingface/transformers", "ipx"]`, `define` for `process.env.NODE_ENV`, and `sourcemap: "external"`. It also copies `package.json` version into a `WARDROBE_VERSION` define so `/api/health` reports the app version. The server must not depend on `import.meta.url` to find `root`: Feature 01 gives it `--root`, and here `--root` is `resources/server`, with `--dist resources/web`.

`resources/server/package.json` declares exactly the external packages with the versions from the root lockfile. `install-native.mjs` runs `npm install --omit=dev --no-audit --no-fund --os=<darwin|win32> --cpu=<arm64|x64>` in that folder, then deletes the other platforms' `onnxruntime-node/bin/napi-v6/*` folders. Record the resulting size per target in the notes; expected roughly 60 MB macOS and 150 MB Windows.

### Node binary

`fetch-node.mjs` downloads `https://nodejs.org/dist/v<ver>/node-v<ver>-darwin-arm64.tar.gz` or `node-v<ver>-win-x64.zip`, verifies the checksum from `SHASUMS256.txt`, and extracts `bin/node` or `node.exe` to `src-tauri/binaries/node-<triple>[.exe]`. `tauri.conf.json` lists `bundle.externalBin: ["binaries/node"]`; Tauri appends the triple itself.

### Sidecar lifecycle (`sidecar.rs`)

- Spawn through `tauri_plugin_shell::ShellExt::sidecar("node")` with args `[resource_dir/server/server.cjs, "--port", port, "--host", "127.0.0.1", "--root", resource_dir/server, "--dist", resource_dir/web, "--data-dir", data_dir, "--cache-dir", cache_dir, "--allowed-hosts", hosts]` and environment: the OS environment, `WARDROBE_MANAGED_CONFIG=1`, every secret from the keychain, every non-secret override from the config store, `NODE_OPTIONS` cleared.
- Readiness: wait for the `READY` line on stdout or poll `/api/health` every 250 ms, with a 30 s timeout. On timeout, kill the child and report `ServerState::Failed { reason, last_lines }`.
- Port conflict: before spawning, try to bind the port in Rust and release it. If it is busy and `/api/health` on it answers with our own `version`, adopt that instance instead of failing (a browser-launched `npm run start` on the same machine). Otherwise report `Failed { reason: "port in use" }`. Never pick another port silently.
- Logs: keep the last 500 lines of stdout and stderr in memory and append to `<app log dir>/server.log` with size rotation at 5 MB.
- Restart: `restart()` is the single entry point used when a key, an override, the port, the data directory or the allowed hosts change. It stops with `SIGTERM` or stdin close and waits up to 10 s before killing.
- Exit: on app quit, stop the sidecar and wait. On unexpected child exit, set `Failed` and emit a `server-state` event so the control panel updates.

### Windows and tray (`windows.rs`)

- `wardrobe` window: created when the sidecar is ready, URL `http://127.0.0.1:<port>/`, 1280×860 default, remembers size and position (`tauri-plugin-window-state`). No Tauri IPC is granted to this window; it is a plain webview. External links open through `tauri-plugin-opener`.
- `control` window: bundled frontend, 520×720, opened at first launch when no provider key exists, or from the tray. Granted the command set in `capabilities/control.json` only.
- Close on `wardrobe` hides the window; the tray keeps the server alive. Quit from the tray stops everything.
- Tray or menu bar items: Open Wardrobe, Open in browser (`http://localhost:<port>`), Settings…, Check for updates… (Feature 06 wires it), Quit. A status line shows Running, Starting, Failed.
- Single instance (`tauri-plugin-single-instance`): a second launch focuses the existing one.
- Autostart (`tauri-plugin-autostart`) exposed as a command; the toggle lives in Feature 04.

### Configuration (`config.rs`)

`tauri-plugin-store` file `config.json` in `app_config_dir()` with typed accessors: `port` (u16, default 5173), `data_dir` (default `<app data>/data`), `cache_dir` (default `<app cache>`), `allowed_hosts` (Vec<String>, default empty), `launch_at_login`, `start_hidden`, `overrides` (ordered map of `KEY=value` non-secret environment entries), `provider` (`AI_PROVIDER`). Secrets are not in this file.

### Dev workflow

`npm run tauri dev` in `desktop/` must not require the bundle. In debug builds the sidecar manager spawns `node` from `PATH` with `../scripts/server.mjs` and `--root <repo root>`, `--dist <repo root>/dist`. Document that `npm run build` at the root must have run once. `npm run prepare && npm run tauri build` produces the installers locally.

## Implementation sequence

1. Scaffold `desktop/` with `create-tauri-app` (React + Vite template), plugins: shell, store, opener, window-state, single-instance, autostart, log. Set a reverse-DNS identifier chosen by the owner (for example `app.wardrobe.desktop`); record it, because it cannot change later without losing the keychain entries and the store locations.
2. `bundle-server.mjs`, `install-native.mjs`, `fetch-node.mjs`, `prepare.mjs`. Run the packaged sidecar by hand on macOS: `binaries/node-aarch64-apple-darwin resources/server/server.cjs …` must reach `READY`.
3. `sidecar.rs` with readiness, logs, restart, adoption of an existing instance.
4. Windows, tray, single instance, autostart command, `Info.plist`.
5. Commands for the control panel: `server_state`, `server_restart`, `server_logs`, `open_wardrobe`, `open_in_browser`, `get_config`, `set_config`, `autostart_get`, `autostart_set`. Secrets commands are stubbed to return "not configured".
6. CI: a `desktop-smoke` job on `macos-14` and `windows-latest` that runs `prepare.mjs`, launches the packaged sidecar headlessly, and curls `/api/health`. This job runs on pull requests touching `desktop/`, `scripts/` or `package.json`.
7. `desktop/README.md` and implementation notes.

## Verification and acceptance

- The packaged sidecar starts on both targets in CI and answers `/api/health` with `managed: true` and the data and cache paths it was given.
- Launching the built app on a clean macOS user account (new user, no repo clone) opens the control window, and after a provider key is faked through the stub it opens the Wardrobe window with the empty-wardrobe state. Same on a Windows VM. Record the exact paths created under the user profile.
- Quit leaves no `node` process behind on either platform. Verify with `pgrep`/Task Manager and note it.
- Killing the sidecar externally flips the tray status to Failed and the control window shows the last log lines.
- Closing the Wardrobe window keeps `http://localhost:5173` reachable from Safari or Edge.
- A second launch focuses the first instance.
- `npm run tauri dev` works against the repo's `scripts/server.mjs` without running `prepare.mjs`.
- `npm run check` at the root still passes; the root `package.json` is unchanged except for scripts Feature 01 and 02 added.
