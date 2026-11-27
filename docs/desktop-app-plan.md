# Desktop app, GitHub releases and Tailscale remote access

This document records the approved scope and the sequential implementation workflow for three improvements. The sequence is binding: each feature builds on the interfaces recorded by the previous one. Plan written on 2026-11-26 against HEAD `ceebabf` on `feat/google-drive-archive`.

## Goals

1. **Installable desktop app** for macOS (Apple Silicon) and Windows (x64). The app runs the Wardrobe server locally, shows the Wardrobe UI in its own window, manages API keys and configuration through a native control panel, and can also be used from any browser on the same computer.
2. **Distribution through GitHub Releases** on the public fork `davidmarinangeli/wardrobe`. A manual `v*` tag builds both installers in CI, publishes them as a draft release, and the installed app notices a new version and installs it on request.
3. **Remote access through Tailscale**, so the existing mobile layout of the web app can be used from a phone, or from another computer in the same tailnet, by opening an HTTPS URL. No dedicated mobile app, no account layer beyond the tailnet.

## Decisions taken with the owner

| Topic | Decision |
| --- | --- |
| Shell technology | **Tauri 2** with Node shipped as a sidecar. See "Why Tauri" below. |
| App window | The app opens the Wardrobe web UI in a Tauri window. A separate bundled **control panel** window manages keys, configuration, storage, remote access and updates. |
| Data location | Per-user application data directory, never inside the installed bundle or a repo clone. Existing `data/` folders are imported through the control panel. |
| Secrets | API keys and the Google Drive client secret live in the OS keychain (macOS Keychain, Windows Credential Manager). They are injected into the server process as environment variables and never travel over HTTP. |
| Code signing | **None.** No Apple Developer account, no Windows certificate. Builds are ad-hoc signed on macOS. Installation docs explain the Gatekeeper and SmartScreen prompts. This is a hobby app for friends. |
| Targets | `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` only. |
| Lifecycle | Optional launch at login. Closing the window keeps the server running in the tray or menu bar; Quit stops it. |
| Port | Fixed `5173` by default, overridable in the control panel. The Google Drive redirect URI keeps assuming `localhost:5173`. |
| Release repo | `davidmarinangeli/wardrobe`, public. |
| Updates | Tauri updater: check on launch and on demand, show the new version in the control panel, install and restart on click. Everything (shell, server bundle, native modules) ships and updates together. |
| Release trigger | Manual tag `v*`. No beta channel. CI builds on macOS and Windows runners and uploads to a draft release. |
| Tailscale | Already installed and logged in on every device. `tailscale serve` publishes the local server over HTTPS at the machine's `*.ts.net` name. Being in the tailnet is the only authentication. |
| Remote capabilities | A remote browser uses the app. It cannot manage keys or configuration, which is guaranteed structurally: those only exist in the native control panel. |
| Google Drive from a phone | Out of scope. Connect Drive from the desktop and use it from the phone. The decision on a phone login flow is deferred. |
| Mobile UI | Out of scope. The existing sub-860px layout is what the phone gets. No PWA manifest work. |

## Why Tauri

The owner prefers Tauri. The recommendation is the same, with the trade-off stated plainly.

The server side is not a classic Node server: it is fifteen Vite plugins that mount `connect` middlewares and depend on native modules (`sharp`, `onnxruntime-node` through `@huggingface/transformers`, `ipx`). Any shell must ship a Node runtime plus those native binaries. Electron includes Node, so the server could run in its utility process with no sidecar work. Tauri needs a Node binary and the native modules shipped as resources and a process the Rust side spawns, watches and kills.

Tauri still wins for this project:

- **Updates work without Apple signing.** `electron-updater` refuses to update unsigned macOS apps. The Tauri updater verifies its own minisign signature and does not depend on Apple code signing, which this project will never have.
- **Size.** The Tauri shell is a few megabytes on top of the sidecar. Electron adds about 150 MB per platform before the sidecar. The sidecar itself is roughly 60 MB on macOS and 150 MB on Windows because of `onnxruntime-node`.
- **The sidecar cost is paid once** in Feature 03 and then stays stable. The server bundle is a single CommonJS file produced by esbuild, the native modules are installed per target in CI, and the Node binary is downloaded from nodejs.org. None of that depends on Electron-specific tooling.

The cost is honest: Feature 03 is the riskiest step of the plan. Its acceptance criteria are therefore the strictest.

## Architecture after this plan

```text
┌───────────────────────────────── Wardrobe.app / Wardrobe.exe ─────────────────────────────────┐
│ Tauri shell (Rust)                                                                            │
│  ├─ tray / menu bar: Open Wardrobe · Open in browser · Settings · Check for updates · Quit    │
│  ├─ window "wardrobe"  → http://127.0.0.1:5173/            (the existing React app)           │
│  ├─ window "control"   → bundled control-panel frontend    (keys, storage, remote, updates)   │
│  ├─ keychain (keyring crate) · config store (JSON in app config dir) · updater · autostart    │
│  └─ sidecar manager ── spawns ──▶ node resources/server/server.cjs --port 5173 --host 127.0.0.1│
│                                     --data-dir <app data>/data --cache-dir <app data>/cache    │
│                                     env: WARDROBE_MANAGED_CONFIG=1, OPENAI_API_KEY=…, …        │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                                      ▲
            browser on the same computer ─────────────┤  http://localhost:5173
            phone / other computer in the tailnet ────┘  https://<machine>.<tailnet>.ts.net  (tailscale serve → 127.0.0.1:5173)
```

The web app is unchanged for users of `npm run dev`. Every new behaviour is opt-in through flags or environment variables that the desktop shell sets.

## Sequential features

| Feature | Responsibility | Detailed plan |
| --- | --- | --- |
| 01 — Standalone server | Run the existing API plugins and the built frontend from one `node scripts/server.mjs` command, without Vite. Shared plugin registry, host allow-list, health endpoint, graceful shutdown, CLI flags. | `docs/desktop-app-feature-01.md` |
| 02 — Managed configuration and data locations | Absolute data and cache directories, no runtime writes into the install root, `WARDROBE_MANAGED_CONFIG` mode that turns key management off in the web UI, data folder import command. | `docs/desktop-app-feature-02.md` |
| 03 — Tauri shell and Node sidecar | `desktop/` project, server bundle, per-target native modules, Node binary as external binary, sidecar lifecycle, windows, tray, single instance, autostart, dev workflow. | `docs/desktop-app-feature-03.md` |
| 04 — Control panel | Bundled frontend and Rust commands for provider and keys in the keychain, advanced environment overrides, storage and cache, Google Drive credentials, server status and logs, general options. | `docs/desktop-app-feature-04.md` |
| 05 — GitHub release pipeline | `release.yml` on `v*` tags, macOS and Windows runners, ad-hoc signing, updater artifacts and `latest.json`, draft release, version single source, installation docs for unsigned builds. | `docs/desktop-app-feature-05.md` |
| 06 — In-app updates | Tauri updater against the latest release, check on launch and on demand, control panel and tray surfaces, install and restart, first real update verified across two published versions. | `docs/desktop-app-feature-06.md` |
| 07 — Tailscale remote access | `tailscale serve` driven from the control panel, allowed hosts and same-origin checks behind the proxy, URL and QR code, remote restrictions, operations documentation. | `docs/desktop-app-feature-07.md` |

Features 01 and 02 are pure Node and React work in the existing tree and can be verified with the existing test runner. Feature 03 introduces Rust and the `desktop/` tree. Features 05 and 06 must be done together before the first public release because the updater needs the artifacts the pipeline produces. Feature 07 only depends on 01, 02 and 04 and can be scheduled last.

## Working rules for every feature

- Record what was actually built at the end of each feature document, in a section named **Implementation notes**: exact file names, command names, environment variables, Rust command signatures, and any deviation from the plan with its reason. Later features read those notes instead of the source.
- Keep `npm run dev`, `npm run build`, `npm test` and the Codex skills working exactly as today. The desktop shell is additive.
- Tests use temporary directories and mocked AI. Neither the real `data/`, the real `.env`, nor the keychain is a fixture. Rust tests use a mock keyring (the `keyring` crate's mock credential store) in CI.
- No secret ever reaches the control panel frontend. Rust commands return presence and the last four characters only.
- The server binds `127.0.0.1` when started by the shell. Exposure to other machines happens only through `tailscale serve`, never through binding `0.0.0.0`.
- Do not add dependencies to the root `package.json` beyond what a feature document names.

## Risks and how the plan handles them

| Risk | Handling |
| --- | --- |
| Sidecar packaging breaks on one platform (wrong native binary, missing `.node` file, Node version drift). | Feature 03 installs native modules per target with `npm install --os --cpu`, pins the Node version in one place, and ships a smoke test that launches the packaged sidecar and hits `/api/health` on both targets in CI. |
| The background-removal model (BiRefNet, about 470 MB) is downloaded on first use into `node_modules/@huggingface/transformers/.cache` today, which is read-only in a bundle. | Feature 02 moves the cache to the app cache directory through `env.cacheDir` and surfaces the download in the control panel. The model is not bundled. |
| `public/drapes/` is written at runtime today. | Feature 02 moves it to the cache directory and serves it from there. |
| Unsigned macOS app. Apple Silicon refuses to launch a bundle with no signature at all, and Gatekeeper quarantines downloads. | Feature 05 ad-hoc signs the bundle in CI and documents the one-time `xattr -cr` or "Open Anyway" step. Acceptance includes a fresh download on a clean Mac. |
| Updater on an unsigned macOS app has not been proven in this project. | Feature 06 ends only after a real update from one published version to the next is observed on both platforms. |
| `keyring` on macOS prompts for keychain access when the ad-hoc signature changes between builds. | Documented in Feature 04 as expected behaviour for unsigned builds. Entries are stored under one service name so a reinstall finds them again. |
| `tailscale serve` forwards headers in a way that the server's host allow-list or same-origin check rejects. | Feature 07 verifies the forwarded `Host` and `X-Forwarded-Host` empirically on the first run and makes the server accept the tailnet name explicitly. |
| Port 5173 taken by a dev server on the same machine. | The shell detects the conflict, reports it in the control panel, and offers the port override. It never silently picks another port because the Drive redirect URI depends on it. |

## Deferred and explicitly out of scope

- Google Drive login from a phone through Tailscale. Needs HTTPS and an extra redirect URI in Google Cloud Console. Revisit after Feature 07 ships.
- Mobile UI improvements, PWA manifest, "Add to Home Screen" polish.
- Linux builds, macOS x64 builds.
- Code signing and notarization.
- Multi-user access control inside the tailnet.
- Tailscale Funnel (public internet exposure). Not wanted.
