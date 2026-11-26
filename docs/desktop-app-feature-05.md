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

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-27 (Windows 11, Node 24.14.1, npm 11, rustc 1.99.1, `@tauri-apps/cli 2.12.6`), on top of Feature 04 (`10cc6c9`). The coder did not commit, tag, push or create a release.

### Files

| File | What it is |
| --- | --- |
| `.github/workflows/release.yml` | New. The release workflow, with the jobs `verify`, `draft`, `build` (matrix) and `finalize` (see below). |
| `desktop/scripts/release.mjs` | New. Release helpers and CLI. Plain Node with no dependencies, so `verify` runs it before `npm ci`. |
| `desktop/src-tauri/tauri.release.conf.json` | New. The release overlay `{ "bundle": { "createUpdaterArtifacts": true } }`, passed with `--config` in CI only (deviation 1). |
| `desktop/src-tauri/tauri.conf.json` | Two additions: `bundle.macOS.signingIdentity: "-"` and `hardenedRuntime: false`, and `plugins.updater.pubkey: ""`, which the owner fills in. `version` was already `"../../package.json"`. Targets stay `app`, `dmg`, `nsis`. |
| `desktop/scripts/smoke-sidecar.mjs` | New `--app <bundle>` option and exported `sidecarLayout({ target, app })`. The smoke test can now run against a built `Wardrobe.app` or a Windows folder holding `node.exe`, `server/` and `web/`. |
| `desktop/test/release.test.mjs` | New. 11 tests, no network (see "Verification run"). |
| `desktop/README.md` | New "Releases" section: version, cutting a release, assets, updater signing key, macOS/Windows signing, dry run. |
| `README.md` | New "Desktop app" section, placed before "More setup options". It covers download, macOS and Windows install for unsigned builds, first launch, where data lives, and uninstall behaviour. |
| `AGENTS.md` | New "Desktop app" paragraph under "For agents": a third way to run Wardrobe, the data directories, and no `.env`. |

`ci.yml`, `desktop.yml` and the root `package.json` are unchanged.

### Version single source

- The root `package.json` `version` is the only version.
- `tauri.conf.json` already had `"version": "../../package.json"` (Feature 03). `tauri-action` resolves it the same way (`getInfo` reads the referenced JSON), and so does `bundle-server.mjs` for `/api/health`.
- `release.mjs check` fails unless the tag is exactly `v<version>` and the version is semver. Prereleases such as `0.0.1-rc1` pass, and NSIS accepts them; a local build of `Wardrobe_0.0.1-rc1_x64-setup.exe` was verified.
- The root version is still `1.0.0`. Feature 06's plan publishes `v0.1.0` and `v0.1.1`, so the owner must run `npm version 0.1.0` first, or adapt those numbers.

### `release.mjs` CLI

```text
node desktop/scripts/release.mjs check --tag <tag>
node desktop/scripts/release.mjs draft --tag <tag> [--repo owner/name]          # default repo davidmarinangeli/wardrobe
node desktop/scripts/release.mjs latest-json --tag <tag> [--repo owner/name] [--release-id N] [--upload] [--verify-artifacts] [--out file]
```

**`check`** runs `tagProblems(tag, version)` and `configProblems(config, overlay)`. It requires:

- `version` set to `"../../package.json"`.
- Targets that include `app`, `dmg` and `nsis`, and no MSI.
- `macOS.signingIdentity` set to `"-"` and `macOS.hardenedRuntime` set to `false`.
- No `createUpdaterArtifacts` in the main config, and `createUpdaterArtifacts: true` in the overlay.
- A `plugins.updater.pubkey` that decodes to an Ed25519 minisign public key.

It exits 1 and lists every problem.

**`draft`** finds the release whose `tag_name` equals the tag, or creates it: `name: "Wardrobe <tag>"`, `draft: true`, `prerelease: false`, `body: ""`. It writes `release_id=<id>` to `$GITHUB_OUTPUT`. It refuses when that tag already has a published release, or when there are several drafts for it.

**`latest-json`** works as follows:

1. Lists the release's assets and picks, per platform, the updater artifact and its `.sig`:
   - `darwin-aarch64` is `*_aarch64.app.tar.gz`.
   - `windows-x86_64` is `*_x64-setup.exe`.
2. Downloads the `.sig` contents. With `--verify-artifacts` it also downloads the artifacts and computes their BLAKE2b-512.
3. Builds `{ version, notes: <release body>, pub_date: now, platforms }`. The platforms are `darwin-aarch64`, `darwin-aarch64-app`, `windows-x86_64` and `windows-x86_64-nsis`, the same shape `tauri-action` writes. URLs are `https://github.com/<repo>/releases/download/<tag>/<asset>`.
4. Validates every entry:
   - The URL is on the tag.
   - The trusted comment's `version:` equals the release version, and `file:` matches the platform.
   - The key id equals the committed public key's.
   - The global signature verifies, and, when the artifacts were downloaded, so does the file signature.
5. With `--upload`, and only when there are no problems, it deletes the release's `latest.json` and uploads the new one.

GitHub access is a small `fetch` client in `githubClient()`. The token comes from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

Exported pure helpers, used by the tests:

- Constants: `UPDATER_PLATFORMS`, `DEFAULT_REPO`, `TAURI_CONFIG`, `RELEASE_OVERLAY`.
- Checks: `tagProblems`, `configProblems`, `checkRelease`.
- minisign: `parsePublicKey`, `parseSignature`, `trustedCommentFields`, `signatureProblems`, `hashFile`.
- latest.json: `assetUrl`, `pickUpdaterAssets`, `buildLatestJson`, `latestJsonProblems`.
- GitHub: `githubClient`, `findOrCreateDraft`, `refreshLatestJson`.

The minisign verifier was checked against real `tauri signer` output. A local `.sig` verified with its key; it was rejected with another key ("signed by key 39C250C6B6642254, but the committed public key is 9AD363EAE2EEB5FF") and against another file.

### Workflow `release.yml`

Trigger: `push` of tags `v*`. Permissions: `contents: write`. Concurrency group `release-<tag>`, with no cancellation. The tag, repository and release id reach the `run:` scripts through `env` (`$TAG`, `$REPO`, `$RELEASE_ID`), never as `${{ }}` text spliced into the shell, because a git tag name may contain `$(...)`; the workflow test enforces this.

1. **`verify`** (ubuntu-latest, Node 22 as in `ci.yml`): `node desktop/scripts/release.mjs check --tag <ref_name>` runs first, so a wrong tag fails within seconds. Then `npm ci` and `npm run check`.
2. **`draft`** (`needs: verify`): `release.mjs draft` with `GH_TOKEN: github.token`. Output `release_id`.
3. **`build`** (`needs: [verify, draft]`, `fail-fast: false`):

   | Leg | `target` | `tauri_args` |
   | --- | --- | --- |
   | `macos-14` | `aarch64-apple-darwin` | `--target aarch64-apple-darwin` |
   | `windows-latest` | `x86_64-pc-windows-msvc` | none |

   Steps:
   1. Checkout.
   2. Fail early with an `::error::` when `secrets.TAURI_SIGNING_PRIVATE_KEY` is empty.
   3. `setup-node` with `node-version-file: desktop/node-version.txt`, npm cache over both lockfiles.
   4. `dtolnay/rust-toolchain@stable` with the target, and `Swatinem/rust-cache@v2` (`key: release-<target>`).
   5. `npm ci` at the root and in `desktop/`.
   6. `node desktop/scripts/prepare.mjs --target <target>`.
   7. `tauri-apps/tauri-action@v0` with:
      - `projectPath: desktop`, `tauriScript: npm run tauri`.
      - `releaseId: needs.draft.outputs.release_id`, `tagName: github.ref_name`, `releaseName: "Wardrobe <tag>"`.
      - `releaseDraft: true`, `prerelease: false`, `includeUpdaterJson: true`.
      - `args: --config src-tauri/tauri.release.conf.json <tauri_args>`.

      Its environment has `GITHUB_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and `APPLE_SIGNING_IDENTITY` (`-` on macOS, empty elsewhere).
   8. macOS only:
      - `codesign -dv --verbose=2 Wardrobe.app` must contain `Signature=adhoc`.
      - `codesign --verify --deep --strict --verbose=2` must pass.
      - The signature of `Contents/MacOS/node` is printed.
   9. `node desktop/scripts/smoke-sidecar.mjs --target <t> --app <bundle>`. The bundle is `…/aarch64-apple-darwin/release/bundle/macos/Wardrobe.app` on macOS and `desktop/src-tauri/target/release` on Windows. It loads the native modules with the bundled Node, starts `server.cjs` and checks `/api/health`.
   10. Artifact sizes.
4. **`finalize`** (`needs: [draft, build]`, ubuntu): `release.mjs latest-json --tag … --repo … --release-id … --verify-artifacts --upload --out latest.json`, then uploads `latest.json` as a workflow artifact.

Repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the key file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. No other secret is needed; `github.token` covers the release API.

Expected release assets:

- `Wardrobe_<ver>_aarch64.dmg`
- `Wardrobe_aarch64.app.tar.gz` and `.sig`
- `Wardrobe_<ver>_x64-setup.exe` and `.sig`
- `latest.json`

### Ad-hoc signing path

The plan's first path was used. The bundler signs with `signingIdentity` `"-"` (in `tauri.conf.json`, and also `APPLE_SIGNING_IDENTITY=-` in CI); there is no split `--no-bundle` / `codesign` / `tauri bundle` build. This is unproven on macOS. The CI codesign step is the check: if it fails, apply the split-build fallback described in "Ad-hoc signing on macOS".

### Updater keypair (owner action)

The procedure is in `desktop/README.md` › "Updater signing key":

1. `cd desktop && npm run tauri signer generate -- -w ~/.tauri/wardrobe.key`.
2. Commit the `.pub` content as `plugins.updater.pubkey`.
3. Add the two repository secrets.
4. Back up the key and password.

The README also warns that losing the private key means installed copies can never auto-update again.

The coder did **not** generate the project key. The local tests used throwaway keypairs in the session scratchpad, which were deleted afterwards. Until the owner commits the public key, `release.mjs check`, and therefore every tag, fails with "plugins.updater.pubkey is empty".

### Decisions and deviations, with reasons

1. **`createUpdaterArtifacts` lives in `tauri.release.conf.json`, not in `tauri.conf.json`.** Feature 06's design text puts it in the main bundle section. Local runs showed why it cannot go there:
   - With it and no `plugins.updater`, `tauri build` fails: "plugins > updater doesn't exist".
   - With a public key but no `TAURI_SIGNING_PRIVATE_KEY`, it builds the installer and then **exits with an error**: "A public key has been found, but no private key".

   With it in the main config, `npm run tauri build` would have broken for every developer without the release key. `tauri-action` merges `--config` files when it locates artifacts (`mergeUserConfig`), so it still finds and uploads the `.sig` files. `release.mjs check` rejects the flag in the main config. Feature 06 should keep it in the overlay.
2. **`bundle.macOS.hardenedRuntime: false`.**
   - Tauri enables the hardened runtime by default and re-signs every binary, including the Node sidecar from `externalBin`.
   - Under the hardened runtime, V8's JIT (`MAP_JIT`) needs `com.apple.security.cs.allow-jit`, and loading the third-party `.node`/`.dylib` files needs library-validation exemptions.
   - The hardened runtime only matters for notarization, which is out of scope.

   Turning it off avoids a likely sidecar crash on Apple Silicon. Entitlements were the alternative, but it is unclear whether Tauri applies them to sidecars. The macOS smoke step in CI (bundled Node plus native modules, run from the signed `.app`) verifies the decision.
3. **A separate `draft` job creates the release, and `tauri-action` gets `releaseId`.** `tauri-action`'s `getOrCreateRelease` lists releases and creates one when it finds none. Two legs finishing at the same moment could create two drafts. `tagName` is still passed, because `tauri-action` uses it to rewrite `untagged-…` draft URLs in `latest.json`. `releaseName`, `releaseDraft` and `prerelease` are kept as the plan lists them, but they are inert when `releaseId` is set.
4. **The `finalize` job always rebuilds `latest.json`; it is not just a fallback.** `tauri-action`'s `uploadVersionJSON` reads the existing `latest.json`, merges its own platform, then deletes and re-uploads it with no locking. When the two legs finish close together, one platform can be lost. Rebuilding deterministically from the `.sig` assets after both legs makes the race harmless. It also adds checks `tauri-action` never makes:
   - The CLI only **warns** when the private key does not match `plugins.updater.pubkey`; this was observed locally. `finalize` fails on it.
   - The full signature check runs against the downloaded artifacts.

   `includeUpdaterJson: true` stays as the plan says; its output is replaced.
5. **Release notes reach `latest.json` through a re-run.** The owner writes the notes after the build, so `latest.json` built in CI has empty `notes`. Running `node desktop/scripts/release.mjs latest-json --tag <tag> --upload` locally, after editing the draft and before publishing, refreshes it with the release body. This is documented in `desktop/README.md`.
6. **The macOS updater archive is `Wardrobe_aarch64.app.tar.gz`, not `Wardrobe.app.tar.gz`.** `tauri-action` adds the arch suffix to `.app.tar.gz` assets (`getAssetName`). The trusted comment inside its `.sig` still says `file:Wardrobe.app.tar.gz`.
7. **Additional CI checks:**
   - The early secret-present check.
   - The `codesign --verify --deep --strict` step. If it ever fails only because of nested Mach-O files under `Contents/Resources/server/node_modules`, drop `--strict` and keep the `Signature=adhoc` assertion.
   - The smoke test run on the built bundle.
8. **`verify` uses Node 22**, mirroring `ci.yml`, where `npm run check` is known to pass. The build legs use `desktop/node-version.txt` (24.22.3), as planned.
9. **The dry-run step (implementation sequence 4) was not performed.** The working rules forbid tags and releases from this session. The procedure is documented in `desktop/README.md` › "Dry run".
10. **No counselor was consulted.** The workflow asked for an Agent-tool counselor (model "fable"), but this session has no Agent tool, as in Feature 03. Decisions 1 to 4 were settled by experiment, by reading `tauri-action` v0's source (`create-release.ts`, `upload-version-json.ts`, `config.ts`, `runner.ts`), and by the CLI changelog.

### Verification run (Windows 11)

- **`node --test test/release.test.mjs`** (in `desktop/`): 11 of 11 pass. They cover:
  - The tag check, including a prerelease.
  - The config check: all gaps named, and the committed config clean except the empty pubkey.
  - minisign parse and verify: matching key, wrong key id, same id with a different key, tampered data, edited trusted comment.
  - Asset picking.
  - latest.json build and validation: a lost platform, an untagged URL, a wrong version, a wrong key, a swapped artifact.
  - Draft find-or-create: create, reuse, published refused, duplicates refused.
  - `refreshLatestJson`: replaces a stale `latest.json`, downloads the artifacts, and never uploads when signed by another key.
  - The CLI exiting 1 on a mismatched tag.
  - `sidecarLayout`.
  - The shape of `release.yml`.
- **`npm test` in `desktop/`:** 18 node tests and 21 Vitest tests pass.
- **`cargo test --locked` in `desktop/src-tauri`** with the changed `tauri.conf.json`: 31 unit tests, 8 lifecycle tests and 1 storage test pass.
- **Root:** `npm run build` passes, and `node --test test/standalone-server.test.mjs test/desktop-feature02.test.mjs` gives 24 pass and 1 skipped.
  - The full suite, `node --test --test-timeout=60000 test/*.test.mjs`, gives 463 tests: 391 pass, 70 fail, 1 cancelled, 1 skipped.
  - The failures are only in the files already known to fail on Windows (Features 01 to 03): Google Drive features 02 to 04, `archive-store`, `bulk-import-archive-acceptance`, and `mirror-fixtures` and `mirror-invariants`, which need a real `data/library.json`.
  - This feature changed no root code, so `npm run check` remains a Linux CI matter, as before.
- **`release.mjs check`:**
  - `--tag v1.0.0`: exit 1, only "plugins.updater.pubkey is empty".
  - `--tag v2.0.0`: also "tag "v2.0.0" does not match package.json: expected v1.0.0".
- **Local release builds** (`npm run tauri build` in `desktop/`, NSIS):

  | Config | Result |
  | --- | --- |
  | Overlay without `plugins.updater` | Error "plugins > updater doesn't exist" |
  | Public key, no private key | Installer built, then exit 1 "A public key has been found, but no private key" |
  | Non-base64 placeholder public key | Exit 1 "failed to decode pubkey" |
  | Mismatched public key | Only a warning; `.sig` produced |
  | `--config src-tauri/tauri.release.conf.json --config <throwaway pubkey>`, as `tauri-action` runs it from `desktop/` | Exit 0: `Wardrobe_1.0.0_x64-setup.exe` (**62.39 MiB**, 65,415,860 bytes) and `Wardrobe_1.0.0_x64-setup.exe.sig` (436 bytes). Trusted comment `file:Wardrobe_1.0.0_x64-setup.exe version:1.0.0`, and `release.mjs`'s verifier accepts it. |

  The `--config` path resolves relative to `desktop/`. The test `.sig` and the rc1 installer were deleted afterwards.
- **`node scripts/smoke-sidecar.mjs --app src-tauri/target/release`:** the bundled Node v24.22.3 loads sharp 0.34.5, onnxruntime-node 1.24.3 (`cpu`, `dml`, `webgpu`), transformers and ipx. `/api/health` reports `ok`, `managed` and `1.0.0`, and the server exits 0 after stdin closes.
- **`release.yml`** parses as YAML, with the jobs `verify`, `draft`, `build` and `finalize`.

### Pending manual verification

- **Owner setup:** generate the updater keypair, commit `plugins.updater.pubkey`, and add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets on `davidmarinangeli/wardrobe`.
- **Dry run in CI** (`v0.0.1-rc1` on a throwaway branch with `npm version 0.0.1-rc1`):
  - All four jobs green.
  - The draft has the five artifacts plus `latest.json`, with `darwin-aarch64[-app]` and `windows-x86_64[-nsis]` URLs on the tag and signatures verified by `finalize`.
  - Record the measured `.dmg` and `.app.tar.gz` sizes.
  - Then delete the draft and the tag.
- **macOS ad-hoc signing in CI:**
  - The bundler accepts `signingIdentity "-"`, and `codesign -dv` shows `Signature=adhoc`.
  - `--verify --deep --strict` passes (otherwise use the fallback in deviation 7).
  - The bundled Node runs from the signed `.app` with the hardened runtime off (the smoke step).
- **Wrong-tag run:** push a tag that does not match `package.json` and confirm `verify` fails at the first step and no build starts. This is covered locally by the CLI test.
- **Clean Mac:** download the `.dmg` in Safari on a Mac without the repo, run the documented `xattr -cr` or Open Anyway step, and check that `codesign -dv` reports ad-hoc and the app reaches the Wardrobe window.
- **Clean Windows:** download `-setup.exe` in Edge, go through SmartScreen (More info › Run anyway), install, and check the app reaches the Wardrobe window. Also check whether the NSIS uninstaller's "Delete the application data" checkbox behaves as the README says.
- **Release notes:** after editing a draft's notes, `release.mjs latest-json --tag <tag> --upload` run locally replaces `latest.json` with the notes.
- **Feature 06:** register `tauri-plugin-updater`, add `endpoints`, keep `createUpdaterArtifacts` in the overlay, and consider `requireSignedVersion` (the CLI already writes `version:` into the trusted comment).
