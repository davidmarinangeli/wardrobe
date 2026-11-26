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

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-26 (Windows 11, Node 24.14.1, npm 11, rustc 1.99.1), on top of Feature 02 (`cf17d4f`). Nothing was committed by the coder.

### Identifier and versions

- Identifier: **`app.wardrobe.desktop`** (the example in this document; the owner did not pick another). It must never change: `config.json`, the data directory and Feature 04's keychain entries are keyed on it.
- Product name `Wardrobe`. In `tauri.conf.json`, `version` is `"../../package.json"`, so the app version **is** the root `package.json` version. `bundle-server.mjs` defines the same value as `WARDROBE_VERSION`, and `/api/health` reports it. `Cargo.toml` says `1.0.0` but is not used for the app version. Feature 05 can keep this as the single source.
- Tauri crates (2.x):
  - `tauri 2.12.7` (feature `tray-icon`), `tauri-build 2.7.6`.
  - Plugins: `tauri-plugin-shell 2.6.0`, `-store 2.5.1`, `-opener 2.7.3`, `-window-state 2.5.0`, `-single-instance 2.5.5`, `-autostart 2.7.0`, `-log 2.10.2`.

  `Cargo.lock` is committed and CI uses `--locked`.
- `desktop/package.json` has its own package and lockfile; the root `package.json` is unchanged.
  - Dependencies: `@tauri-apps/api 2.12.5`, `react` and `react-dom 19.2.0`.
  - Dev dependencies: `@tauri-apps/cli 2.12.6`, `@vitejs/plugin-react 5.0.4`, `esbuild 0.25.12`, `vite 6.4.3` (the root's versions).
- Sidecar Node: `desktop/node-version.txt` = **`24.22.3`**, the latest Node 24 LTS patch (released 2026-11-10).

### Files

| File | What it is |
| --- | --- |
| `desktop/package.json` | Scripts: `dev` and `build` (control panel, Vite on `localhost:1420`), `tauri`, `prepare:app`, `bundle-server`, `install-native`, `fetch-node`, `smoke`, `test`. |
| `desktop/node-version.txt` | The pinned sidecar Node version. |
| `desktop/scripts/common.mjs` | Shared helpers. Paths and constants: `TARGETS`, `NATIVE_PACKAGES`, `ESBUILD_EXTERNALS`. Targets and versions: `hostTarget()`, `targetFromArgv()`, `readNodeVersion()`, `readAppVersion()`, `nodeBinaryPath(triple)`, `nativeDependencyVersions(lock)`. Packaging: `serverPackageJson()`, `parseShasums()`, `nodeArchive()`, `pruneNativeModules(nodeModules, triple)`, `treeSize()`, `run()`. |
| `desktop/scripts/bundle-server.mjs` | `bundleServer({ outDir, version, entry })` writes `src-tauri/resources/server/server.cjs`, `server.cjs.map` and `server.cjs.LEGAL.txt`. |
| `desktop/scripts/install-native.mjs` | `installNative({ target, dir })`. |
| `desktop/scripts/fetch-node.mjs` | `fetchNode({ target, version, cacheDir })`. |
| `desktop/scripts/prepare.mjs` | `prepare({ target, skipWebBuild })`. Writes `resources/server/prepared.json`: target, versions, SHA-256, pruned paths and sizes. |
| `desktop/scripts/smoke-sidecar.mjs` | `smoke({ target, port, keep })`, the CI smoke test (see below). |
| `desktop/test/scripts.test.mjs` | Node tests for the scripts (7 tests, no network). |
| `desktop/index.html`, `desktop/vite.config.mjs`, `desktop/src/{main.jsx,App.jsx,api.js,styles.css}` | Control-panel scaffold; Feature 04 replaces the screens. It shows the server status (with the failure reason and last lines) and the buttons Open Wardrobe, Open in browser and Restart server. While no key exists it shows a session-only provider key form. It also has launch at login, the locations, and a log viewer. `src/api.js` wraps every command and provides `onServerState(handler)`. |
| `desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `Info.plist`, `capabilities/control.json`, `icons/` | Tauri project. The icons come from `tauri icon ../public/icon.svg`, with the mobile and Store sizes removed. `Info.plist` sets `NSAppTransportSecurity › NSAllowsLocalNetworking`. |
| `desktop/src-tauri/src/{main.rs,lib.rs,sidecar.rs,config.rs,secrets.rs,windows.rs,commands.rs}` | The shell (see "Rust surface"). |
| `desktop/src-tauri/tests/sidecar_lifecycle.rs` | Lifecycle tests against the real `scripts/server.mjs` (8 tests). |
| `desktop/.gitignore` | `node_modules/`, `dist/`, `.cache/`, `src-tauri/target/`, `src-tauri/gen/`, `.test-bundle-*/`, `src-tauri/permissions/autogenerated/`, plus `src-tauri/binaries/*` and `src-tauri/resources/*` (each folder keeps a `.gitkeep`). |
| `desktop/README.md` | Developer workflow, build, paths, tests. |
| `.github/workflows/desktop.yml` | Jobs `desktop-smoke` and `desktop-rust` (see "CI"). |
| `vite.config.mjs` (root) | One change: `server.watch.ignored` now also ignores `**/desktop/**` (deviation 6). |

### Commands

```text
cd desktop
npm install
npm run tauri dev                                  # needs `npm run build` at the root once; no prepare
npm run prepare:app [-- --target <triple>] [-- --skip-web-build]
npm run smoke                                      # after prepare, host target only
npm run tauri build                                # after prepare; refuses to compile without the sidecar
npm test                                           # script tests
npm run build && cd src-tauri && cargo test        # Rust tests (generate_context! needs desktop/dist)
```

`bundle-server`, `install-native` and `fetch-node` also run alone; the last two take `-- --target <triple>`.

### Server bundle and native modules

- The esbuild options are exactly as planned:
  - `platform: "node"`, `format: "cjs"`, `target: "node24"`, `bundle: true`, `sourcemap: "external"`.
  - `external: ["sharp", "@img/*", "onnxruntime-node", "@huggingface/transformers", "ipx"]`.
  - `define`: `process.env.NODE_ENV="production"` and `WARDROBE_VERSION`.

  The `empty-import-meta` warning is silenced, because server.mjs only uses `import.meta.url` when unbundled. The bundle is 0.9 MB. Its real externals are `@huggingface/transformers`, `ipx` and `sharp`; onnxruntime-node is reached only through transformers.
- `resources/server/package.json` is `{ name: "wardrobe-server", version: <app>, private, main: "server.cjs", dependencies: { sharp 0.34.5, onnxruntime-node 1.24.3, @huggingface/transformers 4.2.0, ipx 3.1.1 } }`. The versions are read from the root lockfile.
- `install-native` first deletes any previous `node_modules`, then runs `npm install --omit=dev --no-audit --no-fund --ignore-scripts --package-lock=false --install-links=false --os=<darwin|win32> --cpu=<arm64|x64>`. Afterwards it removes the other platforms' `onnxruntime-node/bin/napi-v6/*`, **`onnxruntime-web`** and `.bin` (deviation 3).
- Sizes, from `prepared.json` and a cross-install:

  | Target | Node binary | `node_modules` | `server/` total | Web copy |
  | --- | --- | --- | --- | --- |
  | `x86_64-pc-windows-msvc` (measured) | 89.6 MB | 114.5 MB | 116.9 MB | 25.1 MB |
  | `aarch64-apple-darwin` (cross-installed on Windows, Node not extracted) | ~110 MB unpacked (53 MB `.tar.gz`) | 86.3 MB | ~89 MB | 25.1 MB |

  The NSIS installer `Wardrobe_1.0.0_x64-setup.exe` is **62.3 MiB**, and the shell executable is 5.2 MB. Both sidecars are larger than the plan's estimate (60 MB and 150 MB), because the Node binary alone is 90 to 110 MB. On Windows `onnxruntime-node` is 60 MB, because it includes DirectML and dxcompiler.
- `fetch-node` downloads `SHASUMS256.txt` and the archive from `https://nodejs.org/dist/v<ver>/`, verifies the SHA-256 and caches the archive in `desktop/.cache/node/`. It extracts only `node-v<ver>-<dist>/bin/node` or `node.exe`, with bsdtar. On Windows that is `%SystemRoot%\System32\tar.exe`, because Git Bash's GNU tar cannot read zip files.

### Rust surface

`lib.rs`:

- `pub struct AppState { pub sidecar: SidecarManager, pub dirs: AppDirs, pub layout: ServerLayout, pub secrets: Box<dyn SecretStore>, /* config, auto_open */ }`. Methods:
  - `config() -> DesktopConfig` and `replace_config(DesktopConfig)`.
  - `has_provider_key() -> bool`: a provider secret in the store **or** a non-empty provider key in the inherited environment.
  - `launch_spec() -> LaunchSpec`.
- Functions:
  - `pub fn save_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String>`.
  - `pub fn start_sidecar(app: &AppHandle) -> ServerState`.
  - `pub fn restart_sidecar(app: &AppHandle) -> ServerState`: the single restart path. It stops the server, checks the layout, creates the data and cache directories, and starts it.
  - `pub fn quit(app: &AppHandle)`.
- Constants: `HIDDEN_ARG = "--hidden"` (passed by the autostart entry). `SIDECAR_ENV = "WARDROBE_DESKTOP_SIDECAR"` and `DEV_NODE_ENV = "WARDROBE_DESKTOP_NODE"` apply to debug builds only (see "Spawning" under `sidecar.rs`).
- Events go to all webviews, but only `control` may listen:
  - `server-state` (payload `ServerState`) on every change.
  - `server-ready` (same payload) whenever the state becomes Running.

  On Running the shell also points an existing Wardrobe window at the port, which may have changed. If there is no Wardrobe window yet, it opens one the first time, provided a provider key exists and the launch was not hidden.

`commands.rs`: every command is listed in `build.rs`'s app manifest, so each one needs an `allow-<name>` permission. Only `capabilities/control.json` grants them, and only to the `control` window.

```rust
fn server_state(state: State<AppState>) -> ServerState
async fn server_restart(app: AppHandle) -> Result<ServerState, String>
fn server_logs(state: State<AppState>, limit: Option<usize>) -> Vec<LogLine>
async fn open_wardrobe(app: AppHandle) -> Result<(), String>          // opens the control window and errs if not running
fn open_in_browser(app: AppHandle) -> Result<(), String>               // http://localhost:<port>/
fn get_config(state: State<AppState>) -> ConfigView
async fn set_config(app: AppHandle, patch: ConfigPatch) -> Result<ConfigView, String>   // restarts when a server setting changed
fn autostart_get(app: AppHandle) -> Result<bool, String>
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> // also stores launch_at_login
fn secret_status(state: State<AppState>) -> BTreeMap<String, SecretStatus>
async fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String>  // restarts
async fn secret_delete(app: AppHandle, name: String) -> Result<(), String>              // restarts
fn app_info(app: AppHandle) -> AppInfo
```

From JS: `invoke("set_config", { patch: {...} })`, `invoke("secret_set", { name, value })`, `invoke("server_logs", { limit })`, `invoke("autostart_set", { enabled })`.

- `ServerState` serializes as one of:
  - `{ "state": "stopped" }`
  - `{ "state": "starting", "port" }`
  - `{ "state": "running", "port", "url", "pid", "version", "managed", "dataDir", "cacheDir", "adopted" }`. An adopted server has `pid: null` and `adopted: true`. `url` is `http://localhost:<port>/`.
  - `{ "state": "failed", "port", "reason", "lastLines" }`, with the last 40 log lines as `"<stream>: <text>"`.
- `LogLine { time: "YYYY-MM-DDTHH:MM:SSZ", stream: "out" | "err" | "app", text }`.
- `ConfigView { config: DesktopConfig, data_dir, cache_dir, default_data_dir, default_cache_dir, default_port, config_file }`, with snake_case keys.
- `AppInfo { version, identifier, sidecar_mode: "bundled" | "dev", data_dir, cache_dir, config_dir, log_dir, server_log, has_provider_key, secrets_persistent: false }`, with snake_case keys.
- `SecretStatus { present: bool, hint: Option<String> }`; the hint looks like `"…ab12"`. A value shorter than 8 characters gets the hint `"…"` alone, so the last four characters are never most of the secret.

`config.rs`:

- `DesktopConfig { port: u16 (5173), data_dir: Option<PathBuf>, cache_dir: Option<PathBuf>, allowed_hosts: Vec<String>, launch_at_login: bool, start_hidden: bool, overrides: Vec<OverrideEntry { key, value }>, provider: Option<String> }`.
- Each field is one key in `<app config dir>/config.json`, named after the field. Loading is per key: an invalid value keeps its default and logs a warning.
- `ConfigPatch` has the same fields as `Option`s. For `data_dir`, `cache_dir` and `provider`, an empty string resets the field to its default.
- `DesktopConfig::apply(patch) -> Result<(DesktopConfig, bool /* restart */), String>`.
- Validation:
  - The port is not 0, directories are absolute, hosts are host names, and `provider` is one of `openai|openrouter|gemini|minimax`.
  - Override keys match `^[A-Z0-9_]+$`, values are single lines, and keys are not duplicated.
  - Secret names, including the legacy `GEMINI_API_KEY`, are rejected as overrides with the message "use the key fields above".
  - `SHELL_OWNED_KEYS` are also rejected as overrides: `WARDROBE_DATA_DIR`, `WARDROBE_CACHE_DIR`, `WARDROBE_MANAGED_CONFIG`, `WARDROBE_ALLOWED_HOSTS`, `AI_PROVIDER`, `NODE_OPTIONS`.
- `AppDirs { data, cache, config, log }` has `default_data_dir()` = `<data>/data`, `default_cache_dir()` = `<cache>`, `store_file()` and `server_log()`.

`secrets.rs`:

- `SECRET_NAMES` (the six names of Feature 04) and `PROVIDER_KEY_NAMES`.
- `trait SecretStore: Send + Sync { get, set, delete }`.
- `MemorySecretStore` is the stub: session-only and in memory. It is never persisted and never touches the keychain.
- Functions: `set`, `delete`, `status`, `present`, `validate_name`, `normalize_value` (trims; rejects empty or multi-line values), `hint`.
- Feature 04 swaps `MemorySecretStore` for a keyring store in `lib.rs` setup and sets `secrets_persistent` to true.

`sidecar.rs` has no Tauri dependency.

- **Layout.** `ServerLayout::{Bundled { resource_dir }, Dev { repo_root }}` with `script()`, `root()`, `dist()`, `mode()` and `check()`. A missing script or `index.html` becomes a Failed state with a reason the user can act on.
- **Arguments.** `build_args(layout, port, data_dir, cache_dir, allowed_hosts)` returns `[script, --port, N, --host, 127.0.0.1, --root, root, --dist, dist, --data-dir, D, --cache-dir, C, --watch-stdin, on]`, plus `--allowed-hosts a,b` when the list is not empty.
- **Environment.** `build_env(inherited, config, secrets)` builds the map in this order:
  1. The inherited environment minus `STRIPPED_ENV_KEYS` (`NODE_OPTIONS`, `WARDROBE_DATA_DIR`, `WARDROBE_CACHE_DIR`, `WARDROBE_ALLOWED_HOSTS`, `WARDROBE_MANAGED_CONFIG`; case-insensitive on Windows).
  2. `WARDROBE_MANAGED_CONFIG=1`.
  3. The overrides, in order.
  4. `AI_PROVIDER`, if configured.
  5. Every present secret.

  The command is spawned with `env_clear()` plus this map. `build_launch(LaunchInputs) -> LaunchSpec { port, args, env, cwd }`; `cwd` is the app data directory.
- **Probes.** `port_status(port) -> PortStatus::{Free, InUse, Unavailable(String)}` connects to `127.0.0.1` and `[::1]`, then binds `127.0.0.1`. `probe_health(port, timeout) -> Option<Health>` sends an HTTP/1.0 `GET /api/health` over a raw `TcpStream`; no HTTP client crate.
- **Manager.** `SidecarManager::new(factory, expected_version, LogBuffer, Timing)`, with `set_listener`, `state`, `logs`, `child_pid`, `start(&LaunchSpec)`, `stop()`, `restart(&LaunchSpec)` and `fail(port, reason)`. `Timing` defaults: ready 30 s, stop 10 s, poll 250 ms, adopted-server poll 2 s.
  - **Readiness.** The server is ready on the `READY` stdout line or a successful health poll (every 250 ms).
    - On timeout the process is killed: `Failed { "The server did not become ready within 30 s" }`.
    - If the process exits first: `Failed { "The server exited before it was ready (exit code N)" }`, with the server's own `wardrobe-server failed to start: …` line in `lastLines`.
  - **Unexpected exit.** A watcher thread turns it into `Failed { "The server stopped unexpectedly (…)" }` and emits the event.
  - **Busy port.** The manager never picks another port.
    - If `/api/health` answers with the app's own version, the manager **adopts** that server: `Running { adopted: true, pid: null }`. It polls its health every 2 s, and 3 misses make it Failed. `stop()` never touches an adopted server.
    - A Wardrobe server of another version gives "Port N is in use by another Wardrobe server (version X, this app is Y)…".
    - Anything else gives "Port N is in use by another program. Stop it or choose another port in Settings."
  - **Stop.** `stop()` closes stdin (the server's graceful path), waits up to 10 s, then kills. It also interrupts a `start()` that is still waiting for readiness.
  - **Logs.** `LogBuffer` keeps 500 lines in memory and appends `"<time> <stream> | <text>"` to `<app log dir>/server.log`. The file rotates to `server.log.1` at 5 MB, keeping one previous file. The shell adds its own `app` lines (start, pid, ready, stop, failures). The environment and secrets are never logged.
- **Spawning.**
  - Release builds call `app.shell().sidecar("node")` and convert the result with `From<tauri_plugin_shell::process::Command> for std::process::Command`. That keeps the plugin's path resolution next to the executable and `CREATE_NO_WINDOW`, while the manager owns stdin (deviation 2).
  - Debug builds spawn `node` from `PATH` (or `WARDROBE_DESKTOP_NODE`) with the repo's `scripts/server.mjs --root <repo> --dist <repo>/dist`.
  - `WARDROBE_DESKTOP_SIDECAR=bundled` makes a debug build use the packaged layout instead.

`windows.rs`:

- **Ids.** Window labels `wardrobe` and `control`; tray id `wardrobe-tray`. Menu ids: `open-wardrobe`, `open-in-browser`, `settings`, `quit`, and `check-for-updates` (present but **disabled** until Feature 06). A disabled status line reads `Wardrobe: Starting… | Running on port N | Failed | Stopped`; the tooltip shows the same text.
- **Functions.** `open_wardrobe`, `reload_wardrobe(app, port)`, `open_control`, `open_in_browser`, `focus_existing`, `build_tray`, `update_tray`, `app_url(port)`, `is_server_url(url, port)`.
- **Wardrobe window.** 1280×860 (minimum 380×560). It loads `http://localhost:<port>/` (deviation 1) and has no capability. `target="_blank"` and `window.open` requests go to the default browser through `tauri-plugin-opener`. Same-window navigation is allowed, because the Drive sign-in must return to the window with its cookie.
- **Control window.** 520×720; it loads the bundled `index.html`.
- **Closing.**
  - Closing the Wardrobe window hides it, and closing the control window destroys it.
  - Closing the last window keeps the app in the tray: `ExitRequested { code: None }` is prevented.
  - `RunEvent::Exit` stops the sidecar and waits.
- **Platforms.** On Windows a left click on the tray icon brings the app forward and a right click opens the menu. On macOS the menu opens on click, and clicking the Dock icon (`RunEvent::Reopen`) brings the app forward.

Plugins:

- single-instance, registered first. A second launch calls `focus_existing`.
- log: stdout plus `<log dir>/desktop.log`, 5 MB.
- shell, store, opener.
- window-state: all flags except `VISIBLE`; `control` is on the denylist.
- autostart: `MacosLauncher::LaunchAgent`, argument `--hidden`.

Launch behaviour:

- With `--hidden` or `start_hidden`, no window opens.
- Otherwise, if no provider key exists, the control window opens at once.
- The Wardrobe window opens the first time the server is Running and a key exists.
- Setting a key through `secret_set` restarts the server, and the Running event then opens the Wardrobe window.

### CI

`.github/workflows/desktop.yml` runs on `workflow_dispatch` and on any `pull_request` that touches `desktop/**`, `scripts/**`, `shared/**`, `package.json`, `package-lock.json` or the workflow itself. Its matrix is `macos-14` / `aarch64-apple-darwin` and `windows-latest` / `x86_64-pc-windows-msvc`.

- `desktop-smoke`:
  1. Node 24, then `npm ci` at the root and in `desktop/`.
  2. `npm test` in `desktop/`.
  3. `npm run prepare:app -- --target <triple>`, then `npm run smoke`.
  4. Prints `prepared.json`.
- `desktop-rust`:
  1. `npm ci` and `npm run build` at the root (the lifecycle tests serve `dist/`).
  2. `npm ci` and `npm run build` in `desktop/`.
  3. Stable Rust with `Swatinem/rust-cache`, then `cargo test --locked`.

The existing `ci.yml` is unchanged. Neither job has run yet (pending).

### Decisions and deviations, with reasons

1. **The Wardrobe window loads `http://localhost:<port>/`, not `http://127.0.0.1:<port>/`.** From `127.0.0.1`, the Archive connect flow fails with `cross_origin_request`, for two reasons:
   - Google Drive's `oauth/start` checks the request origin against the redirect URI's origin (`http://localhost:5173`).
   - The OAuth nonce cookie is per origin.

   `localhost` also gives the window the same origin, storage and cookies as "Open in browser". Both WebView2 and WKWebView treat `localhost` as a secure context, and `NSAllowsLocalNetworking` covers it. Health checks and the bind stay on `127.0.0.1`.
2. **The sidecar is spawned as a `std::process::Command` built by `tauri-plugin-shell`.** Closing stdin is the server's graceful stop on Windows, which has no SIGTERM. The plugin's `CommandChild` can write to stdin and kill the process, but it cannot close stdin and still keep the handle for a later kill. The plugin's `From<Command> for std::process::Command` keeps its sidecar path resolution and `CREATE_NO_WINDOW`.
3. **`onnxruntime-web` (130 MB) is removed from the sidecar.** The Node build of `@huggingface/transformers` (`dist/transformers.node.{mjs,cjs}`) imports only `onnxruntime-node` and `onnxruntime-common`. The smoke test proves that transformers, onnxruntime-node, sharp and ipx all load with the packaged Node after pruning; on Windows onnxruntime-node reports the backends `cpu`, `dml` and `webgpu`. An actual BiRefNet inference was not run, because it needs a 470 MB download.
4. **`npm run prepare:app`, not `npm run prepare`.** npm runs a script named `prepare` on every `npm install` or `npm ci` in `desktop/`, which would download Node and build the whole app each time. `scripts/prepare.mjs` keeps its name.
5. **`build.rs` writes placeholders for debug builds and refuses release builds without the sidecar.** `tauri-build` fails at compile time when `bundle.externalBin` or `bundle.resources` are missing, even for `tauri dev` and `cargo test`.
   - Debug builds never use those files. They get a text placeholder at `binaries/node-<triple>[.exe]`, and a `PLACEHOLDER.txt` in `resources/server` and `resources/web` when those folders are empty. `prepare.mjs` removes or overwrites the placeholders.
   - A release build panics unless the Node binary is at least 1 MB and `server.cjs`, `node_modules/` and `web/index.html` exist.

   `npm run tauri build` therefore works exactly as planned and can never produce an installer without the server. The alternative was a separate `tauri.bundle.conf.json` passed with `--config`. It was rejected because a plain `tauri build` would then silently ship a broken app.
6. **The root `vite.config.mjs` now also has `**/desktop/**` in `server.watch.ignored`.** Otherwise Vite's dev watcher follows `desktop/src-tauri/target` (gigabytes of build output) and the sidecar resources. It is the only change outside `desktop/` and the workflow.
7. **The secrets stub is a session-only in-memory store**, not commands that always answer "not configured". The acceptance step "after a provider key is faked through the stub it opens the Wardrobe window" needs a stub that holds a value. Nothing is persisted, the keychain is never touched, and the panel says so.
8. **`has_provider_key()` also counts provider keys in the inherited environment**, because the sidecar inherits them (the plan says "the OS environment"). On this development machine, an `OPENAI_API_KEY` in the environment means the control window does not open first.
9. **An inherited `AI_PROVIDER` passes through** unless the panel sets `provider`. Only `NODE_OPTIONS` and the four `WARDROBE_*` location and host keys are stripped. `AI_PROVIDER` and `NODE_OPTIONS` are rejected as overrides.
10. **Extra commands and states.**
    - `secret_status`, `secret_set`, `secret_delete` and `app_info` were added to the planned command list.
    - `ServerState` also has `Stopped`, and `Running` carries the health data.
    - `--allowed-hosts` is omitted when the list is empty, and `--watch-stdin on` is always passed.
11. **On Windows the default cache directory is `%LOCALAPPDATA%\app.wardrobe.desktop`.** Tauri also puts `logs\` and WebView2's `EBWebView\` there. This follows the plan (`<app cache>`), and the server only writes `transformers\` and `drapes\` in it. Feature 04's "Clear model cache" must delete only `<cache>/transformers`.
12. **No counselor was consulted.** The workflow asked for a counselor subagent (model "fable"), but this session had no Agent tool, and the one delegation tool available refused (`parent_not_active`). A counselor would have reviewed decisions 1, 2, 4 and 5.

### Verification run (Windows 11, x86_64-pc-windows-msvc)

- **`npm test` in `desktop/`:** 7 of 7 pass. They cover:
  - Targets, Node archive names, SHASUMS parsing, lockfile pins, pruning and the app version.
  - The CommonJS bundle starting with `--root` and `--dist`, and reporting the defined version and `managed: true`.
- **`cargo test` in `desktop/src-tauri`:** 20 unit tests and 8 lifecycle tests, all pass. `cargo clippy --all-targets` reports no warnings, and `cargo fmt --check` is clean. The lifecycle tests run `node scripts/server.mjs` from the repo with temporary data and cache directories, and check:
  - Running with `managed: true`, the given paths and the app version, with `READY` both in memory and in `server.log`.
  - A graceful stop through stdin, well under 10 s, with no node process left.
  - An external `taskkill /F` turns the state into Failed ("stopped unexpectedly", last lines included) and emits the event; a restart then works.
  - Adoption of a same-version server: no second process, and the adopter's stop leaves it running.
  - Refusal of a different-version server and of a non-HTTP listener, without picking another port.
  - A restart moving to a new port.
  - A startup failure (missing `index.html`) reporting the server's own error.
  - The readiness timeout (shortened from 30 s to 2 s) killing the process.
  - `stop()` interrupting a pending start.
- **`npm run prepare:app` (host target):** 34 s.
- **`npm run smoke`:**
  - The packaged Node v24.22.3 loads sharp 0.34.5 (libvips 8.17.3), onnxruntime-node 1.24.3, transformers and ipx from `resources/server`.
  - `server.cjs` reaches `READY`. `/api/health` reports `ok`, `managed: true`, the temporary data and cache paths and version 1.0.0.
  - `/` serves `resources/web/index.html`, and `/api/setup/providers` is managed.
  - The server exits with code 0 after stdin closes.
- **Debug build without the sidecar:** with `binaries/` and `resources/server` moved away, `cargo check` failed before deviation 5 and passes after it, using the placeholders.
- **`npm run tauri build`:** produced `target/release/wardrobe-desktop.exe` (5.2 MB) and `bundle/nsis/Wardrobe_1.0.0_x64-setup.exe` (62.3 MiB). The installer itself was not installed.
- **Release executable**, run from `target/release` (resources next to it) with `OPENAI_API_KEY` removed from its environment. It was driven over WebView2's remote debugging port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`) and Win32 window enumeration.
  - **Launch:** only "Wardrobe Settings" opened. `/api/health` on `127.0.0.1:5173` answered `managed: true`, with data `C:\Users\<user>\AppData\Roaming\app.wardrobe.desktop\data` and cache `C:\Users\<user>\AppData\Local\app.wardrobe.desktop`.
  - **Single instance:** a second launch exited with code 0 in 92 ms, and the first instance stayed. With the Wardrobe window hidden, a second launch showed it again.
  - **External kill:** after `taskkill /F` on the sidecar, `server.log` recorded `server failed: The server stopped unexpectedly (exit code 1)` and health went down. The tray label itself was not observed (pending).
  - **Faked key, from the control window:** `set_config({ provider: "minimax" })`, then `secret_set("MINIMAX_API_KEY", <fake>)`.
    - The server restarted, and the "Wardrobe" window opened at `http://localhost:5173/` with the empty-wardrobe state: "0 PIECES", "DROP, PASTE, OR ADD A PHOTO TO IMPORT YOUR FIRST PIECE", and the managed wizard at "STEP 2 OF 2".
    - `/api/setup/providers` reported `minimax: true, managed: true`.
    - `secret_status` returned only `present` and `hint: "…1234"`, and `secret_set("PATH", …)` was rejected.
    - The fake key appears in none of `server.log`, `desktop.log` or `config.json`.
  - **IPC from the Wardrobe window:** `invoke("server_state")`, `invoke("secret_status")` and `plugin:event|listen` all failed with "not allowed by ACL".
  - **Port change:** after `set_config({ port: 5174 })`, 5173 closed, 5174 answered, and the Wardrobe window moved to `http://localhost:5174/`. Switching back to 5173 worked the same way. Port 99999 and an `OPENAI_API_KEY` override were rejected.
  - **Closing windows:** closing the Wardrobe window (WM_CLOSE) hid it, and `http://localhost:5173` kept answering. Closing the control window left the app and the server running in the tray.
  - **Killing the app:** after `taskkill /F` on the app itself, the node sidecar exited on its own (its stdin closed) and released the port. No node process was left.
  - **Paths created under the user profile:**
    - `%APPDATA%\app.wardrobe.desktop\`: `config.json`, and `data\` with `library.json`, `archive-metadata.json`, `imported\`, `*-assets\`, `jobs\` and `.google-drive\`.
    - `%LOCALAPPDATA%\app.wardrobe.desktop\`: `logs\desktop.log`, `logs\server.log` and `EBWebView\`.

    No autostart registry entry was created. Both folders were deleted after the test.
- **`npm run tauri dev`** (with `OPENAI_API_KEY` removed): the debug build started `sidecar dev (…\scripts\server.mjs)`, health reported `managed: true` with the app data paths, and the control window opened. No `prepare:app` was needed.
- **Root:**
  - `npm run build` passes.
  - `npm run dev` with the `vite.config.mjs` change: `/` and `/api/setup/providers` answer 200.
  - `node --test test/standalone-server.test.mjs test/desktop-feature02.test.mjs`: 24 pass, 1 skipped (the POSIX SIGTERM test).
  - Full suite, `node --test --test-timeout=60000 test/*.test.mjs`, run while the machine was also compiling Rust: 463 tests, 390 pass, 70 fail, 2 cancelled, 1 skipped.
    - The failures are in files already known to fail on Windows: Google Drive features 02 to 04, `archive-store`, `bulk-import-archive-acceptance`, and the `mirror-*` files, which need a real `data/library.json`. One `variants-v2` test also timed out.
    - The five non-Drive files were rerun on an idle machine, with and without the `vite.config.mjs` change. The results were identical: 13 tests, 7 pass, 6 fail, and `variants-v2` passes.

  `npm run check` therefore still cannot pass on Windows, as recorded in Features 01 and 02.

### Review round 1 fixes

- The control-panel scaffold read `AppInfo` and `ConfigView` with camelCase keys (`hasProviderKey`, `dataDir`, …), but both serialize snake_case. The key form therefore never went away and the locations were blank. `src/App.jsx` now reads `has_provider_key`, `sidecar_mode`, `server_log`, `data_dir`, `cache_dir` and `config_file`.
- `secrets::hint` no longer reveals values shorter than 8 characters.
- The `Info.plist` comment now names `http://localhost:<port>/` (deviation 1).

### Pending manual verification

- **CI:** the `desktop-smoke` and `desktop-rust` jobs have not run, because nothing was pushed from this session. The macOS job matters most:
  - `npm run prepare:app -- --target aarch64-apple-darwin`.
  - The native module check, including sharp's libvips dylib and `libonnxruntime.1.24.3.dylib`.
  - The packaged sidecar's health.
  - The Rust lifecycle tests on macOS.
- **macOS app** (`npm run tauri build` on Apple Silicon):
  - The `Info.plist` merge (`NSAllowsLocalNetworking`), and the Wardrobe window loading `http://localhost:5173` in WKWebView.
  - The menu-bar icon and menu, and reopening from the Dock.
  - Tauri's resource copy keeping `node_modules` intact. No symlinks are expected once `.bin` is removed.
  - The plan's clean-user-account run (new macOS user, no repo clone): the control window first, then the Wardrobe window with the empty wardrobe after a faked key. Record the created paths: `~/Library/Application Support/app.wardrobe.desktop`, `~/Library/Caches/app.wardrobe.desktop`, `~/Library/Logs/app.wardrobe.desktop`.
- **Windows VM or clean account:** install `Wardrobe_1.0.0_x64-setup.exe` (current-user NSIS install) and repeat the first-launch flow. Here only the unpacked release executable from `target/release` was run.
- **Tray:** tray clicks could not be automated here; the same stop path is covered by the Rust tests and by the forced-kill run above. To check by hand:
  - Quit: no node process left, and `server stopped` in `server.log`.
  - The status line flipping to "Failed" after an external kill.
  - Open in browser and Settings…, and the macOS menu-bar equivalents.
- **Launch at login:**
  - `autostart_set(true)` creates the Run entry (Windows) or LaunchAgent (macOS) with `--hidden`.
  - The app starts hidden at login.
  - `autostart_set(false)` removes the entry.
- **Window state:** size and position should be restored after a real Quit. The tests only force-killed the app, which skips the save.
- **Google Drive connect inside the Wardrobe window:**
  - WebView2 should work.
  - WKWebView may be refused by Google's embedded-browser policy (`disallowed_useragent`). The fallback is Open in browser, which shares the `localhost:<port>` origin and the server-side connection.
- **Adoption, interactively:** the tests adopt a second `scripts/server.mjs` of the same version. Two cases are still to be checked by hand:
  - `npm run start` on 5173 before launching the app: the app should adopt it.
  - A Vite dev server on 5173: the app should fail with "in use by another program".

### Notes for later features

- **Feature 04:**
  - Replace `MemorySecretStore` in `lib.rs` setup with the keyring store, and set `AppInfo.secrets_persistent`. Keep `SecretStore`, `SECRET_NAMES` and the command shapes.
  - Already in place: `set_config` validates overrides and restarts when needed, and the `server-state` and `server-ready` events and `reload_wardrobe` exist.
  - Add `data_import` and the dialog plugin there.
  - `ConfigView`, `AppInfo` and `DesktopConfig` use snake_case JSON keys; `ServerState` and `Health` use camelCase.
- **Feature 05:**
  - Run `npm run prepare:app -- --target <triple>`, then `npm run tauri build`. A release build fails fast without the sidecar.
  - The app version is the root `package.json` version, through `"version": "../../package.json"` in `tauri.conf.json`.
  - Bundle targets are `app`, `dmg` and `nsis` (NSIS `installMode: currentUser`).
  - Nothing is signed yet. On macOS, the packaged Node from nodejs.org carries its own Developer ID signature.
- **Feature 06:** wire the tray item `check-for-updates` (currently disabled) and the updater plugin. `quit()` already stops the sidecar before exiting.
- **Feature 07:** `allowed_hosts` in `config.json` becomes `--allowed-hosts`, and `set_config({ allowed_hosts })` restarts the server.
