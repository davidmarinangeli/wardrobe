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
