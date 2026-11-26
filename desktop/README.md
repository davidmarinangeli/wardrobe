# Wardrobe desktop app

A Tauri 2 shell around the Wardrobe server. It ships Node as a sidecar, runs
the server from `scripts/server.mjs` on `127.0.0.1:5173`, shows the web app
in a window, keeps running in the tray (Windows) or menu bar (macOS), and has
a small control panel. The web app and `npm run dev` at the repo root are
unchanged; this folder is additive.

Targets: `aarch64-apple-darwin` (Apple Silicon) and `x86_64-pc-windows-msvc`.

## Prerequisites

- Node 24 and npm 11 (to build; the app ships its own Node).
- Rust stable (`rustup`), plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS (Xcode Command Line Tools on macOS; Microsoft C++ Build Tools and
  WebView2 on Windows, which Windows 11 already has).
- `npm install` at the repo root and in `desktop/`.

## Develop

```bash
npm run build            # at the repo root, once (the server serves dist/)
cd desktop
npm install
npm run tauri dev
```

Debug builds never use the packaged sidecar. They run `node` from `PATH` with
the repo's `scripts/server.mjs --root <repo> --dist <repo>/dist`, so
`prepare:app` is not needed. Server code changes need an app restart (or
**Restart server** in the control panel); web app changes need `npm run build`
at the root. The control panel itself is served by Vite on `localhost:1420`
with hot reload.

Debug builds use the same per-user directories as the installed app (see
"Where things live"), never the repo's `data/`.

Two environment variables exist for debug builds only:

| Variable | Effect |
| --- | --- |
| `WARDROBE_DESKTOP_SIDECAR=bundled` | Use the packaged sidecar from the resource directory, as a release build does. Needs `prepare:app`. |
| `WARDROBE_DESKTOP_NODE=<path>` | The Node binary for the dev sidecar (default `node` from `PATH`). |

## Build installers locally

```bash
cd desktop
npm run prepare:app      # host target; or: npm run prepare:app -- --target aarch64-apple-darwin
npm run smoke            # optional: start the packaged sidecar and check /api/health
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/` (`dmg/` and `macos/` on
macOS, `nsis/` on Windows). A release build refuses to compile until
`prepare:app` has produced the sidecar for that target, so an installer never
ships without its server.

`prepare:app` (`scripts/prepare.mjs`) runs, in order:

1. `npm run build` at the repo root, then copies `dist/` to `src-tauri/resources/web/`
   (`--skip-web-build` reuses an existing `dist/`).
2. `scripts/bundle-server.mjs`: esbuild bundles `scripts/server.mjs` and its imports
   into `src-tauri/resources/server/server.cjs` (CommonJS, `node24`,
   `WARDROBE_VERSION` defined from the root `package.json`, external source map).
   `sharp`, `@img/*`, `onnxruntime-node`, `@huggingface/transformers` and `ipx` stay external.
3. `scripts/install-native.mjs`: writes `resources/server/package.json` with exactly
   those packages at the root lockfile's versions and runs
   `npm install --omit=dev --ignore-scripts --os=<os> --cpu=<cpu>` there, then removes
   the other platforms' `onnxruntime-node/bin/napi-v6/*` folders, `onnxruntime-web`
   (only the browser build of transformers uses it) and `node_modules/.bin`.
4. `scripts/fetch-node.mjs`: downloads the Node version in `node-version.txt` from
   nodejs.org, verifies it against `SHASUMS256.txt`, and extracts it to
   `src-tauri/binaries/node-<triple>[.exe]` (archives are cached in `desktop/.cache/`).

Each step also runs alone: `npm run bundle-server`, `npm run install-native`,
`npm run fetch-node` (the last two take `-- --target <triple>`). Everything they
write is git-ignored.

Not named `prepare` on purpose: npm runs a script called `prepare` on every
`npm install`, and this one downloads Node and builds the whole app.

## Changing the Node version

Edit `node-version.txt` (one line, for example `24.22.3`) and run
`npm run prepare:app` again. The sidecar's Node is independent of the Node
used for CI or development.

## How the app runs the server

- Command (release): `<app>/node resources/server/server.cjs --port <port> --host 127.0.0.1
  --root resources/server --dist resources/web --data-dir <data> --cache-dir <cache>
  --watch-stdin on [--allowed-hosts …]`.
- Environment: the inherited environment minus `NODE_OPTIONS`, `WARDROBE_DATA_DIR`,
  `WARDROBE_CACHE_DIR`, `WARDROBE_ALLOWED_HOSTS` and `WARDROBE_MANAGED_CONFIG`; then
  `WARDROBE_MANAGED_CONFIG=1`, the non-secret overrides, `AI_PROVIDER` (when set
  in the panel) and every stored secret.
- Ready when the server prints `READY` or `/api/health` answers (polled every
  250 ms), within 30 s. Otherwise the process is killed and the state is Failed.
- Port: fixed (5173 unless changed in the panel). If the port is taken by a
  Wardrobe server of the same version (for example `npm run start`), the app
  uses it. Anything else on the port is a failure with a message; the app never
  picks another port by itself.
- Stop: closes the server's stdin (graceful shutdown) and kills it after 10 s.
  Quit from the tray stops the server; closing the Wardrobe window only hides it.
  If the app itself is killed, the server sees its stdin close and exits.
- Logs: the last 500 lines in memory (control panel) and
  `<log dir>/server.log`, rotated to `server.log.1` at 5 MB. The shell's own log is
  `<log dir>/desktop.log`.

## Where things live

Identifier: `app.wardrobe.desktop`. It must never change: the store location,
the data directory and (Feature 04) the keychain entries are keyed on it.

| What | macOS | Windows |
| --- | --- | --- |
| Data (`<app data>/data`) | `~/Library/Application Support/app.wardrobe.desktop/data` | `%APPDATA%\app.wardrobe.desktop\data` |
| Cache (model, drapes) | `~/Library/Caches/app.wardrobe.desktop` | `%LOCALAPPDATA%\app.wardrobe.desktop` |
| Settings (`config.json`) | `~/Library/Application Support/app.wardrobe.desktop/config.json` | `%APPDATA%\app.wardrobe.desktop\config.json` |
| Logs | `~/Library/Logs/app.wardrobe.desktop` | `%LOCALAPPDATA%\app.wardrobe.desktop\logs` |
| Window size and position | `.window-state.json` next to `config.json` | same |
| WebView data | managed by WKWebView | `%LOCALAPPDATA%\app.wardrobe.desktop\EBWebView` |

On Windows the default cache directory is the same folder as the logs and the
WebView2 data; the server only creates `transformers/` and `drapes/` in it.
The installed bundle is never written to.

## Tests

```bash
cd desktop
npm test                         # build-script tests (no network)
npm run build                    # control panel, needed once by cargo
cd src-tauri && cargo test       # config, secrets, sidecar; lifecycle tests run the
                                 # real server with node from PATH and the root dist/
```

CI (`.github/workflows/desktop.yml`) runs `desktop-smoke` (prepare, then the
packaged sidecar's `/api/health`) and `desktop-rust` (`cargo test`) on
`macos-14` and `windows-latest` for pull requests touching `desktop/`,
`scripts/`, `shared/` or `package.json`.
