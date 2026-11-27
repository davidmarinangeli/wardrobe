# Feature 05 — GitHub release pipeline

## Scope and ownership

Build and publish the desktop installers from a manual tag. One workflow produces the macOS Apple Silicon bundle and the Windows x64 installer, signs the updater artifacts with the project's own key, uploads everything with `latest.json` to a draft GitHub release on `davidmarinangeli/wardrobe`, and the owner publishes it after writing the notes. Also the user-facing installation documentation for unsigned builds.

The CODER owns `.github/workflows/release.yml`, the version single source, the updater keypair setup instructions, `desktop/README.md` release section, and the README install section. Feature 06 consumes the artifacts; do both before the first public tag.

## Design

### Version single source

`package.json` at the root holds the version. `desktop/src-tauri/tauri.conf.json` sets `"version": "../../package.json"`, which Tauri 2 resolves to that file's `version` field. `desktop/package.json` does not carry a meaningful version. The release tag must equal `v<version>`; the workflow fails early when they differ.

Release procedure, documented in `desktop/README.md`:

```bash
git checkout main && git pull
npm version minor          # bumps package.json, commits, creates tag vX.Y.0
git push --follow-tags
```

### Workflow `release.yml`

Trigger: `push` of tags matching `v*`. Permissions: `contents: write`.

Jobs:

1. `verify` on `ubuntu-latest`: `npm ci`, `npm run check`, assert tag equals `v$(node -p "require('./package.json').version")`.
2. `build` matrix after `verify`:
   - `macos-14`, `target: aarch64-apple-darwin`, `tauri_args: --target aarch64-apple-darwin`.
   - `windows-latest`, `target: x86_64-pc-windows-msvc`.
   Steps: checkout, Node from `desktop/node-version.txt` for the build tools, Rust stable with the target, `npm ci` at root and in `desktop/`, `node desktop/scripts/prepare.mjs --target <target>` (web build, server bundle, native install, Node download), then `tauri-apps/tauri-action@v0` with `projectPath: desktop`, `tagName: ${{ github.ref_name }}`, `releaseName: "Wardrobe ${{ github.ref_name }}"`, `releaseDraft: true`, `prerelease: false`, `includeUpdaterJson: true`, `args: ${{ matrix.tauri_args }}`. Environment: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from repository secrets, `APPLE_SIGNING_IDENTITY: "-"` on macOS for ad-hoc signing.
3. The two matrix legs upload to the same draft release; `tauri-action` merges `latest.json` across platforms when both legs finish. Verify the final `latest.json` contains both `darwin-aarch64` and `windows-x86_64` entries; if the merge is unreliable, add a final `finalize` job that downloads both partial JSON files and writes one, as a documented fallback.

Artifacts per release: `Wardrobe_<ver>_aarch64.dmg`, `Wardrobe.app.tar.gz` plus `.sig`, `Wardrobe_<ver>_x64-setup.exe` plus `.sig`, `latest.json`. Bundle targets in `tauri.conf.json`: `dmg` and `app` on macOS, `nsis` on Windows. No MSI.

### Ad-hoc signing on macOS

Tauri's bundler signs with the identity in `APPLE_SIGNING_IDENTITY`; the value `-` means ad-hoc. Apple Silicon refuses to launch a completely unsigned binary, so this step is not optional. Acceptance checks `codesign -dv --verbose=2 Wardrobe.app` on the downloaded bundle and expects `Signature=adhoc`. If the bundler does not accept `-`, a `beforeBundleCommand` hook is not enough because it runs before the `.app` exists. Split the build instead: `tauri build --no-bundle`, then `codesign --force --deep --sign - target/release/bundle/macos/Wardrobe.app`, then `tauri bundle`. Record which path was needed.

### Updater keypair

Generated once by the owner with `npm run tauri signer generate -- -w ~/.tauri/wardrobe.key`. The public key goes into `tauri.conf.json` under `plugins.updater.pubkey` (committed; it is public). The private key and its password go into the repository secrets named above. The procedure and the warning that losing the private key means existing installs can never auto-update again go in `desktop/README.md`.

### Installation documentation

README section "Desktop app" with:

- Download links pattern (`Releases` page), which file for which machine.
- macOS: the app is not notarized. After copying to Applications, either run `xattr -cr /Applications/Wardrobe.app` once, or open it, dismiss the warning, then allow it in System Settings › Privacy & Security › Open Anyway. State that this is needed once per fresh download and not after in-app updates.
- Windows: SmartScreen shows "Windows protected your PC"; choose More info › Run anyway. WebView2 is present on Windows 10 and 11; the NSIS installer downloads it when it is missing.
- Where data lives on each platform, and that uninstalling keeps the data directory.
- First launch: open Settings from the tray, add a provider key, optionally import an existing `data/` folder.

`AGENTS.md` gains a short paragraph pointing agents to the desktop app as a third way to run Wardrobe, with the data directory locations.

## Implementation sequence

1. Version single source and the tag check.
2. `release.yml` with the matrix, `prepare.mjs` reuse, `tauri-action`.
3. Updater keypair generation procedure; the owner generates and stores the secrets; the public key is committed.
4. Dry run on a throwaway tag `v0.0.1-rc1` (allowed by the glob) against a draft release; delete the tag and the draft afterwards.
5. Installation docs; implementation notes with the artifact names and the measured sizes.

## Verification and acceptance

- The dry-run tag produces a draft release with all artifacts listed above and a `latest.json` naming both platforms with the right URLs and signatures.
- The `.dmg` downloaded in Safari on a Mac without the repo opens after the documented one-time step; `codesign -dv` reports an ad-hoc signature; the app reaches the Wardrobe window.
- The `-setup.exe` downloaded in Edge installs after the SmartScreen step, and the app reaches the Wardrobe window.
- A tag whose version does not match `package.json` fails in `verify` before any build starts.
- The CI `verify` job reuses the existing `npm run check`; the existing `ci.yml` is unchanged.
