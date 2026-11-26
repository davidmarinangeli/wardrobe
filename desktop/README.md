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
| API keys, Drive client secret | Keychain, service `wardrobe (app.wardrobe.desktop)`, one item per name | Credential Manager, generic credentials `<NAME>.wardrobe` |
| WebView data | managed by WKWebView | `%LOCALAPPDATA%\app.wardrobe.desktop\EBWebView` |

On Windows the default cache directory is the same folder as the logs and the
WebView2 data; the server only creates `transformers/` and `drapes/` in it.
The installed bundle is never written to.

## Control panel

The control window (tray › Settings…) has the sections Status, AI provider,
Storage, Google Drive, General, Updates, plus a placeholder for Remote access
(Feature 07). It replaces `.env` editing:

- API keys and the Google Drive client secret go to the OS keychain and reach
  the server only as environment variables. The panel only ever sees
  "Set, ends with …ab12".
- Provider, non-secret overrides (`KEY=value` lines), port, data directory,
  Drive client ID / redirect URI / folder ID and the general options are in
  `config.json`.
- Every change that affects the server restarts it; the Wardrobe window
  reloads when it is back.
- **Import existing data…** runs `import-data` (Feature 02) with the sidecar's
  Node while the server is stopped, then starts it again.

On macOS, an unsigned build changes its signature with every update, so the
Keychain asks "Wardrobe wants to use your confidential information" once per
key after an update. Choose **Always Allow**.

`WARDROBE_DESKTOP_SECRETS=memory` keeps secrets in memory for the session
instead of the keychain (manual testing on a machine whose keychain must not be
touched).

## Updates

The app updates itself from the latest GitHub release with
`tauri-plugin-updater` (`plugins.updater` in `src-tauri/tauri.conf.json`):

- It reads
  `https://github.com/davidmarinangeli/wardrobe/releases/latest/download/latest.json`
  15 s after launch, every 6 hours while running, from the tray item
  **Check for updates…** and from **Check for updates** in Settings › Updates.
  Drafts and prereleases are invisible to `releases/latest`.
- A newer version shows in Settings › Updates with its release notes, an
  **Install and restart** button and **Skip this version**. The tray item then
  reads **Update to vX.Y.Z…** (not for a skipped version) and opens that screen.
  Nothing installs without the click.
- Install downloads and verifies the update while the server keeps running,
  then stops the server, installs and restarts. On Windows the NSIS installer
  runs in passive mode (a progress bar, no questions) and starts the new
  version; on macOS the bundle is replaced in place and the app relaunches.
  A failed download leaves everything as it was; a failed install starts the
  server again. Both show the reason in Settings.
- Failed automatic checks are silent apart from the "Last check failed…" line;
  a failed manual check shows its error.
- The signature must verify against `plugins.updater.pubkey` and, with
  `requireSignedVersion`, carry the version `latest.json` announces, so an
  older signed build cannot be passed off as a newer one.
- `config.json` keeps `update_last_check`, `update_skipped_version`, and
  `update_installed_from` (written just before an install, removed at the next
  launch, which then always opens its windows even with `--hidden`).

Automatic checks run in release builds only. `WARDROBE_DESKTOP_UPDATE_CHECKS=on`
(or `off`) forces them either way; manual checks always work.

To exercise the updater without publishing anything, run `npm run tauri dev --
--config <overlay.json>` with an overlay that points `plugins.updater.endpoints`
at a local server, sets `"dangerousInsecureTransportProtocol": true` and a
throwaway `pubkey`, and serve a `latest.json` whose artifact is signed with
`npm run tauri signer sign -- -f <key> -p "" --app-version <version> <file>`.
Feature 06's implementation notes describe the run done this way.

## Tests

```bash
cd desktop
npm test                         # build-script tests (no network), then the
                                 # control-panel tests (Vitest, jsdom, mocked IPC)
npm run build                    # control panel, needed once by cargo
cd src-tauri && cargo test       # config, secrets (keyring mock store), sidecar,
                                 # storage, updater state machine (mocked updater);
                                 # lifecycle and import-data tests run the
                                 # real server with node from PATH and the root dist/
```

CI (`.github/workflows/desktop.yml`) runs `desktop-smoke` (prepare, then the
packaged sidecar's `/api/health`) and `desktop-rust` (`cargo test`) on
`macos-14` and `windows-latest` for pull requests touching `desktop/`,
`scripts/`, `shared/` or `package.json`.

## Releases

Releases are built by `.github/workflows/release.yml` from a manual `v*` tag
and land as a **draft** on
[davidmarinangeli/wardrobe](https://github.com/davidmarinangeli/wardrobe/releases).
Nothing is published until the owner publishes the draft.

### Version

The root `package.json` is the only version. `src-tauri/tauri.conf.json` says
`"version": "../../package.json"`, the server bundle reports the same value on
`/api/health`, and `desktop/package.json` (`0.0.0`) and `Cargo.toml` are not
used for it. The tag must be exactly `v<version>`; the workflow's first step
fails otherwise.

### Cutting a release

```bash
git checkout main && git pull
npm version minor          # or patch / major / 0.1.0: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

Then, in the Actions tab, wait for the **Release** run to be green:

1. `verify` (Ubuntu): `node desktop/scripts/release.mjs check --tag <tag>`
   (tag equals `v<package.json version>`, bundle targets `app`/`dmg`/`nsis`,
   ad-hoc signing, updater public key present, release overlay present), then
   `npm ci` and `npm run check`.
2. `draft`: finds or creates the draft release `Wardrobe <tag>` (`release.mjs draft`).
3. `build` on `macos-14` (`aarch64-apple-darwin`) and `windows-latest`
   (`x86_64-pc-windows-msvc`): `npm ci` at the root and here,
   `node desktop/scripts/prepare.mjs --target <triple>`, then
   `tauri-apps/tauri-action@v0` builds with
   `--config src-tauri/tauri.release.conf.json` and uploads to the draft. On
   macOS the job then checks `codesign -dv` reports `Signature=adhoc` and
   `codesign --verify --deep --strict` passes. Both legs then run the smoke
   test against the built app (`smoke-sidecar.mjs --app <bundle>`).
4. `finalize`: `release.mjs latest-json --verify-artifacts --upload` rebuilds
   `latest.json` from both legs' `.sig` files, downloads both updater artifacts
   and verifies their signatures against the committed public key, then
   replaces the release's `latest.json`.

Finally write the release notes in the draft, run

```bash
node desktop/scripts/release.mjs latest-json --tag vX.Y.Z --upload
```

so `latest.json` carries the notes the updater shows (it uses `GH_TOKEN`, or
`gh auth token`), and publish the draft. Only publish a draft whose run was
entirely green: a failed leg leaves an incomplete draft, which you delete
(together with the tag, if the version is abandoned).

A broken tag can be rebuilt while its release is still a draft: delete the
draft's assets or the draft itself, fix, move the tag
(`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`) and the workflow runs again.
`release.mjs draft` refuses a tag whose release is already published; bump the
version instead.

### Release assets

| Asset | What it is |
| --- | --- |
| `Wardrobe_<ver>_aarch64.dmg` | macOS installer (drag to Applications) |
| `Wardrobe_aarch64.app.tar.gz` + `.sig` | macOS updater archive and its signature (`tauri-action` adds the `_aarch64` suffix) |
| `Wardrobe_<ver>_x64-setup.exe` + `.sig` | Windows NSIS installer (current-user), also the Windows updater payload |
| `latest.json` | Updater manifest with `darwin-aarch64`, `darwin-aarch64-app`, `windows-x86_64` and `windows-x86_64-nsis` |

There is no MSI. The updater (see "Updates" above) reads
`https://github.com/davidmarinangeli/wardrobe/releases/latest/download/latest.json`,
so an installed app sees a release only once it is **published**.

### Updater signing key

The updater only installs files signed with the project's own minisign key.
This has nothing to do with Apple or Windows code signing. Generate it once:

```bash
cd desktop
npm run tauri signer generate -- -w ~/.tauri/wardrobe.key
```

Choose a password when asked. Then:

1. Put the content of `~/.tauri/wardrobe.key.pub` (one base64 line) into
   `src-tauri/tauri.conf.json` as `plugins.updater.pubkey` and commit it. It is
   public. Until it is there, `release.mjs check` fails every tag.
2. In GitHub › Settings › Secrets and variables › Actions, add the repository
   secrets `TAURI_SIGNING_PRIVATE_KEY` (the content of `~/.tauri/wardrobe.key`)
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep a backup of the private key and its password outside this computer
   (a password manager).

**If the private key or its password is lost, installed copies can never
auto-update again**: every user would have to download and install a new
version by hand once, after a new key is committed. Never commit the private key.

Local builds do not need the key: `bundle.createUpdaterArtifacts` lives only in
`src-tauri/tauri.release.conf.json`. To produce the updater files locally, set
`TAURI_SIGNING_PRIVATE_KEY` (a path or the key itself) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then run
`npm run tauri build -- --config src-tauri/tauri.release.conf.json`.

### Signing on macOS and Windows

There is no Apple Developer ID and no Windows certificate.

- macOS: `bundle.macOS.signingIdentity` is `"-"` (CI also sets
  `APPLE_SIGNING_IDENTITY=-`), so the bundler **ad-hoc signs** the app,
  including the Node sidecar. Apple Silicon refuses to run unsigned code, so
  this is required. `bundle.macOS.hardenedRuntime` is `false`. The hardened
  runtime only matters for notarization, and it would stop the re-signed Node
  from using its JIT without extra entitlements. Users clear the quarantine once
  per download (README, "Install on macOS").
- Windows: unsigned; SmartScreen asks once (README, "Install on Windows").

### Dry run

To exercise the pipeline without a real version, on a throwaway branch: set
the root version to a prerelease such as `0.0.1-rc1` (`npm version 0.0.1-rc1`),
push the branch and the tag `v0.0.1-rc1`, and check the draft's assets and
`latest.json`. Afterwards delete the draft and the tag
(`git push origin :refs/tags/v0.0.1-rc1`). NSIS accepts prerelease versions.
