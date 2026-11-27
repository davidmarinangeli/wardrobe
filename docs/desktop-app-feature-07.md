# Feature 07 — Tailscale remote access

## Scope and ownership

Make the locally running server reachable from the owner's phone and other computers in the same tailnet at `https://<machine>.<tailnet>.ts.net`, driven from the control panel. The web app's existing mobile layout is what the phone shows; no mobile-specific work. Being in the tailnet is the only authentication.

The CODER owns the Tailscale integration in Rust and in the control panel, the server-side host and origin handling behind the proxy, the remote guard in the web app, and `docs/tailscale-remote-access.md`.

## Preconditions the plan assumes

- Tailscale is installed and logged in on the computer and on the phone. The plan does not install Tailscale.
- In the tailnet admin console, DNS › MagicDNS and HTTPS Certificates are enabled. This is a one-time step the documentation describes with the exact page names. Without it `tailscale serve` cannot issue a certificate.
- The computer is awake. The documentation says so and points at the energy settings; keeping the machine awake is out of scope.

## Design

### Server side

- The sidecar always binds `127.0.0.1` (Feature 03), so the LAN never sees the port. `tailscale serve` is the only door.
- Allowed hosts: the shell passes `--allowed-hosts <machine>.<tailnet>.ts.net` when remote access is on. The Feature 01 allow-list already supports exact names.
- Same-origin checks (`isSameOriginRequest` in `scripts/import-job-api.mjs`): a browser on the phone sends `Origin: https://<machine>.<tailnet>.ts.net`. What `tailscale serve` forwards as `Host` must be measured on the first run (it also sets `X-Forwarded-Host` and `X-Forwarded-Proto`). Extend the check to accept a match against `X-Forwarded-Host` when present, with the same host comparison, and record the observed headers in the notes. Do not relax the check to "any origin".
- Cookies and storage: the app has none that are host-bound in a way that matters; the server-side browser state from Drive Feature 01 makes a phone and the desktop share the same preferences automatically. Confirm with a manual run.

### Shell side (`tailscale.rs`)

- Locate the CLI: macOS `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, then `tailscale` on `PATH`; Windows `C:\Program Files\Tailscale\tailscale.exe`, then `PATH`. Report "Tailscale not found" with the download link when absent.
- Status: `tailscale status --json`, read `BackendState`, `Self.DNSName` (strip the trailing dot), `Self.Online`, and `CurrentTailnet.MagicDNSEnabled`. `tailscale serve status --json` tells whether our port is already served.
- Enable: `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (the `--bg` form persists across reboots). Then restart the sidecar with the DNS name in the allowed hosts. On some Tailscale versions the first HTTPS request triggers certificate issuance and takes a few seconds; the panel polls `https://<dnsname>/api/health` through `reqwest` until it answers or 60 s pass, and reports accordingly.
- Disable: `tailscale serve --https=443 off`, then restart the sidecar without the host.
- Commands: `tailscale_status()`, `tailscale_enable()`, `tailscale_disable()`, `tailscale_url()`.
- The config store records `remote_access: bool` so the shell re-applies the allowed host after an app restart and re-checks that the serve rule still exists.

### Control panel: Remote access section

- State line: Tailscale not installed / not logged in / connected as `<dnsname>`.
- Toggle Enable remote access with the explanation "Anyone logged into your tailnet can open Wardrobe at this address. Keys and settings stay on this computer."
- When on: the URL as text with Copy, a QR code rendered client-side (a small QR library in the control panel only), and the health result.
- Troubleshooting lines: MagicDNS or HTTPS disabled in the admin console; machine asleep; certificate pending.

### Web app guard

The Google Drive "Connect" action in Settings › Archive would redirect the phone's browser to `http://localhost:5173/...`, which fails on the phone. Until the deferred decision on phone login, the Archive tab hides Connect and shows "Connect Google Drive from the computer that runs Wardrobe" when `location.hostname` is not `localhost` or `127.0.0.1`. Everything else in the Archive tab stays usable remotely. Nothing else in the web app needs to know it is remote: key management is already impossible over HTTP in managed mode (Feature 02).

### Documentation

`docs/tailscale-remote-access.md`: the admin-console prerequisites, the two-click enable from the panel, the URL shape, what is and is not reachable (keys and configuration never; Drive connect only from the desktop; imports, generation, outfits, mode toggle yes), how to disable, and the manual CLI equivalents for people running `npm run start` without the desktop app (`tailscale serve --bg 5173` plus `WARDROBE_ALLOWED_HOSTS=<dnsname>`).

## Implementation sequence

1. Server: `X-Forwarded-Host` in the same-origin check, tests with both header shapes.
2. `tailscale.rs` with status parsing from fixture JSON, enable, disable, URL.
3. Control panel section replacing the Feature 04 placeholder; QR code.
4. Web app Drive guard.
5. Manual run from a phone, header measurement, docs, implementation notes.

## Verification and acceptance

- Unit: status parsing fixtures for logged-out, logged-in without MagicDNS, logged-in with DNS name; command argument construction; same-origin acceptance with `Host` or `X-Forwarded-Host`.
- Manual, macOS and Windows: enable from the panel; the phone opens the URL in Safari or Chrome, sees the mobile layout, browses the wardrobe, opens an outfit, runs one import from a photo in the camera roll, and toggles Gemini TEST/PROD. The desktop sees the same change after a reload. Note the forwarded headers observed.
- From the phone, Settings › AI shows the managed read-only state; `POST /api/setup/config` from a phone-side `fetch` returns `409`.
- Disable from the panel; the URL stops answering within seconds; `localhost` keeps working.
- The server never listens on anything but `127.0.0.1`; `lsof -iTCP -sTCP:LISTEN` or `netstat -ano` output goes in the notes.

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-27 (Windows 11, Node 24.14.1, npm 11, rustc 1.99.1, Tailscale 1.104.6 installed and logged in on this machine), on top of Feature 06 (`4277691`). The coder did not commit, tag, push or publish anything, and never ran `tailscale serve` on this machine (see "Verification run").

### Dependencies

- Rust (`desktop/src-tauri/Cargo.toml`), all already in `Cargo.lock` through `tauri-plugin-updater`, so no new crate was downloaded:
  - `reqwest = { version = "0.13", default-features = false, features = ["rustls-no-provider"] }` (locked 0.13.5), for the health poll through the tailnet.
  - `rustls = { version = "0.23", default-features = false, features = ["ring"] }`: reqwest's `rustls-no-provider` needs a process-wide crypto provider; `tailscale.rs` installs ring's when none is set, exactly as the updater plugin does lazily.
  - `tokio = { version = "1", features = ["time"] }`, for the poll interval.
  - `Cargo.lock` stays at format version 3 (cargo 1.99 rewrote it as 4; it was set back and `cargo check --locked` passes).
- `desktop/package.json`: `qrcode-generator` **2.0.4** (exact, MIT, no dependencies, published 2025-08-07), used only by the control panel. The root `package.json` is unchanged.

### Files

| File | What it is |
| --- | --- |
| `scripts/same-origin.mjs` | **New.** `isSameOriginRequest(req)`, `isForwardedSameOriginRequest(req)`, `forwardedHost(req)`. |
| `scripts/import-job-api.mjs` | The old `isSameOriginRequest` body is gone; it imports and re-exports the one from `same-origin.mjs`, so `setup-api.mjs` and the tests keep their import. |
| `scripts/google-drive-api.mjs` | New `sameOriginOrProxied(req, service)`; every Drive control POST except `oauth/start` uses it (deviation 2). |
| `src/google-drive-storage.js` | New exports `isRemoteHostname(hostname)` and `GOOGLE_DRIVE_REMOTE_CONNECT_NOTICE`. |
| `src/google-drive-storage.jsx` | Settings › Archive: when `isRemoteHostname(location.hostname)`, the Connect / Reconnect button is replaced by the notice (`data-testid="drive-remote-connect"`). |
| `test/desktop-feature07.test.mjs` | **New.** 10 root tests (see "Verification run"). |
| `desktop/src-tauri/src/tailscale.rs` | **New.** CLI location, `CliRunner`/`ProcessCli`, argument builders, status and serve-status parsing, `query_status`, `enable`, `disable`, `serve`, the health poll; 17 unit tests. No Tauri dependency (the tests borrow `tauri::async_runtime::block_on`). |
| `desktop/src-tauri/fixtures/tailscale/*.json` | **New.** Synthetic CLI output (no real names): `status-logged-out`, `status-no-magicdns`, `status-connected`, `status-connected-no-https`, `serve-empty`, `serve-wardrobe`, `serve-other`. |
| `desktop/src-tauri/src/config.rs` | `DesktopConfig` gains `remote_access: bool` and `remote_host: Option<String>`, plus `effective_allowed_hosts()` and `remote_url()`. `affects_server` compares the effective allowed hosts. One new test; the round-trip test covers the two keys. |
| `desktop/src-tauri/src/sidecar.rs` | `build_launch` passes `config.effective_allowed_hosts()` to `--allowed-hosts`. One new test. |
| `desktop/src-tauri/src/lib.rs` | `pub mod tailscale`; `AppState.remote: Mutex<()>`; `remote_status`, `enable_remote`, `disable_remote`, `reapply_remote_serve`, the launch-time `reconcile_remote_access`; the five commands registered. |
| `desktop/src-tauri/src/commands.rs` | The five `tailscale_*` commands; `set_config` moves the serve rule after a port change; `open_help` gains three topics. |
| `desktop/src-tauri/build.rs`, `capabilities/control.json` | The five commands and their `allow-tailscale-*` permissions, for the `control` window only. |
| `desktop/src-tauri/tests/tailscale_cli.rs` | **New.** An `#[ignore]`d, read-only check against the installed CLI (`status --json`, `serve status --json`, `version` only). |
| `desktop/src/sections/RemoteSection.jsx` | **New.** The Remote access screen. Exports `RemoteSection`, `tailscaleStateLabel`, `REMOTE_EXPLANATION`. |
| `desktop/src/qr.jsx` | **New.** `qrMatrix(text, level)`, `qrPath(matrix, margin)`, `<QrCode text size label>`: one SVG `<path>`, always black on white. |
| `desktop/src/App.jsx`, `api.js`, `styles.css`, `sections/GeneralSection.jsx` | The Remote access rail entry renders `RemoteSection`; wrappers `tailscaleStatus`, `tailscaleEnable`, `tailscaleDisable`, `tailscaleUrl`, `tailscaleHealth(timeoutSecs)`; styles `.remote-url`, `.remote-qr`, `.qr`, `.troubleshooting`. `PlaceholderSection` was removed (no section uses it any more). |
| `desktop/test-ui/remote.test.jsx` | **New.** 11 Vitest tests. `panel.test.jsx`: the placeholder test now checks that the section renders. |
| `docs/tailscale-remote-access.md` | **New.** The user guide the plan asks for. |
| `README.md`, `desktop/README.md`, `AGENTS.md` | A "Use it from your phone" subsection, the Control panel and Tests text, and one sentence with the manual CLI equivalent. |

### Server side

- `isSameOriginRequest(req)`: the Origin must parse as an `http:` or `https:` URL; the request matches when its host equals the `Host` header **or** the first value of `X-Forwarded-Host` (a repeated header uses its first entry, a comma list its first item). Each candidate must be a bare `host[:port]` (`/^[a-z0-9.\-[\]:]+$/i`) and is compared as `new URL(<origin scheme>//<candidate>).host`, so letter case and an explicit default port (`:443`) do not matter. No Origin, `null`, `file:` or a mismatch is still refused; nothing was relaxed to "any origin". `X-Forwarded-Host` cannot be forged by a cross-site page: it is not CORS-safelisted, so a browser would need a preflight the server never approves.
- `isForwardedSameOriginRequest(req)`: the same comparison against `X-Forwarded-Host` only.
- Host allow-list: unchanged. The shell passes the **exact** tailnet name (`--allowed-hosts wardrobe-mac.tail1234.ts.net`), not `.ts.net`, so another machine's name in the same tailnet domain is refused (tested).
- Headers forwarded by `tailscale serve`: **not measured** (no second device here, and `tailscale serve` was not run; see pending). Tailscale's reverse proxy (`ipn/ipnlocal/serve.go`) is expected to keep the public name in `Host` and to set `X-Forwarded-Host`, `X-Forwarded-Proto: https` and `X-Forwarded-For`, plus `Tailscale-User-*` identity headers for user-owned devices. Both shapes, `Host: <name>` and `Host: 127.0.0.1:<port>` with `X-Forwarded-Host: <name>`, are accepted and tested, so the feature works whichever one the real proxy sends.

### Rust surface

`commands.rs` (listed in `build.rs`, granted only to `control`):

```rust
async fn tailscale_status(app: AppHandle) -> RemoteStatus
async fn tailscale_enable(app: AppHandle) -> Result<RemoteStatus, String>   // Err: nothing changed, the text says what to fix
async fn tailscale_disable(app: AppHandle) -> Result<RemoteStatus, String>  // Tailscale problems come back in `message`
fn tailscale_url(state: State<AppState>) -> Option<String>                  // "https://<name>/" while remote access is on
async fn tailscale_health(app: AppHandle, timeout_secs: Option<u64>) -> Result<RemoteHealth, String>  // Err only when remote access is off
```

From JS: `invoke("tailscale_health", { timeoutSecs })` (default 60, clamped to 1..120); the others take no arguments. `open_help` also accepts `"remote-access"` (this repo's guide), `"tailscale-download"` (`https://tailscale.com/download`) and `"tailscale-dns"` (`https://login.tailscale.com/admin/dns`).

`RemoteStatus` (camelCase JSON):

```text
{ state: "notInstalled" | "unavailable" | "stopped" | "loggedOut" | "starting" | "connected",
  enabled, cli, backendState, dnsName, tailnet, online, magicDns, https,
  served, serveTarget, funnel, port, remoteHost, url, health: [string], message,
  downloadUrl, adminUrl }
```

- `state` comes from `BackendState`: `Running` → connected, `Stopped` → stopped, `Starting` → starting, anything else (`NeedsLogin`, `NeedsMachineAuth`, `NoState`) → loggedOut. A CLI that cannot reach `tailscaled` (non-zero exit, no JSON) → unavailable with a message.
- `dnsName`: `Self.DNSName`, trailing dot stripped, lower-cased (only when connected).
- `magicDns`: `CurrentTailnet.MagicDNSEnabled`. `https`: the DNS name is in `CertDomains` (null while HTTPS Certificates are off; confirmed on this machine's real tailnet, where HTTPS is off).
- `served`: `tailscale serve status --json` has `Web["<name>:443"].Handlers["/"].Proxy` pointing at `http://127.0.0.1:<port>` (also `localhost`, `[::1]`, or without the scheme). `serveTarget` is that proxy value whatever it is. `funnel`: `AllowFunnel["<name>:443"]`.
- `url`: `https://<remoteHost>/` while enabled; otherwise the address enabling would publish.

`RemoteHealth` (camelCase): `{ url, ok, elapsedMs, attempts, status, version, error }`.

`tailscale.rs`:

- Constants: `CLI_ENV` = `"WARDROBE_DESKTOP_TAILSCALE"`, `DOWNLOAD_URL`, `ADMIN_DNS_URL`, `MACOS_APP_CLI` = `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `HTTPS_PORT` (443), `STATUS_TIMEOUT` (10 s), `SERVE_TIMEOUT` (20 s), `HEALTH_TIMEOUT` (60 s), `HEALTH_INTERVAL` (2 s); 10 s per health request, 5 s connect timeout.
- Location: `cli_candidates(os, lookup)` and `locate_cli(os, lookup, is_file)`. `WARDROBE_DESKTOP_TAILSCALE` alone when set; macOS: the app bundle's CLI, then `tailscale` on `PATH`; Windows: `%ProgramFiles%\Tailscale\tailscale.exe`, `C:\Program Files\Tailscale\tailscale.exe`, then `tailscale.exe` on `PATH`. `locate_installed_cli()` applies it to this machine.
- `trait CliRunner { fn run(&self, args: &[String], timeout: Duration) -> Result<CliOutput, String>; fn path(&self) -> Option<&Path> }`. `ProcessCli { path }`: stdin null, stdout and stderr captured, `CREATE_NO_WINDOW` on Windows, killed at the timeout (`CliOutput.timed_out`); output pipes are awaited at most 2 s after the process ends.
- Arguments: `status_args()` = `status --json`; `serve_status_args()` = `serve status --json`; `serve_enable_args(port)` = `serve --bg --https=443 http://127.0.0.1:<port>`; `serve_disable_args()` = `serve --https=443 off`.
- Parsing: `parse_status(json) -> TailnetInfo { backend_state, dns_name, online, magic_dns, https, tailnet, health }`, `parse_serve_status(json, dns_name, port) -> ServeInfo { target, served, funnel }`, `local_proxy_port(target)`, `approval_url(text)`.
- Operations: `read_status`, `read_serve`, `query_status(cli, port, enabled, remote_host)`, `ready_dns_name(info)`, `serve(cli, port)`, `enable(cli, port) -> Result<String /* dns name */, String>`, `disable(cli, dns_name, port)`, `probe_remote_health(base_url, port, timeout, interval)` (async), `classify_answer(status, body, port) -> Attempt::{Healthy, Fatal, Retry}`.

`lib.rs` flows (all blocking, run on `spawn_blocking`, serialized by `AppState.remote`):

- **Enable:** CLI found → `status --json` (must be Running, MagicDNS on, DNS name present) → `serve --bg --https=443 http://127.0.0.1:<port>` → `serve status --json` must show the rule pointing at the port (a rule pointing elsewhere is an error; an unreadable serve status is accepted, since `serve` itself succeeded) → `config.json` gets `remote_access: true` and `remote_host: <name>` → `restart_sidecar` (the name is now in `--allowed-hosts`) → returns the fresh status. The panel then calls `tailscale_health`.
- **Disable:** `serve status --json`; `serve --https=443 off` only if the rule points at our port (or the status is unreadable) → `remote_access: false`, `remote_host: null` → restart without the name. When Tailscale is missing or refuses, Wardrobe still stops accepting the name and the status carries the problem in `message`.
- **Launch** (after the first `start_sidecar`, on the same thread), only when `remote_access` is on: the first start already uses the recorded `remote_host`, so there is no wait for the CLI. Then `status --json`: a changed DNS name is saved and the server restarts with it; `serve status --json` is checked and a missing rule is logged ("turn it on again in Settings > Remote access"), not re-created (deviation 4).
- **Port change** (`set_config` with a new port while remote access is on): after the restart, `serve --bg --https=443 http://127.0.0.1:<new port>` is run again; the result is logged.
- The server log gets an `app` line for each step, prefixed `remote access`.

### `config.json` keys

- `remote_access` (bool, default `false`) and `remote_host` (string or `null`), both part of `DesktopConfig`, validated per key like the others (`remote_host` must be a host name). `ConfigPatch` does not have them: only the `tailscale_*` commands change them, so `set_config` can never point the allowed hosts at an arbitrary name through these fields. User `allowed_hosts` entries are kept separately and merged (`effective_allowed_hosts`, no duplicate).

### Control panel: Remote access

- State line (`data-testid="tailscale-state"`): "Tailscale is not installed on this computer." / "…installed but not running." / "…turned off." / "…not logged in." / "…starting…" / "Connected as `<dnsname>`" (plus " (offline)"). Refresh button. Not installed: **Download Tailscale**. Other non-connected states: "Open the Tailscale app … then choose Refresh."
- **Enable remote access** checkbox, enabled only when connected (or when already on, so it can always be turned off), with the plan's explanation verbatim: "Anyone logged into your tailnet can open Wardrobe at this address. Keys and settings stay on this computer."
- When on: the URL with **Copy** (`navigator.clipboard`), the QR code, and the health line: "Checking the address… The first time can take up to a minute while Tailscale issues the certificate." → "Reachable through Tailscale (answered in 3.4 s)." or "Not reachable yet. <reason>" with **Check again**. Health is checked after enabling and whenever the screen opens with remote access on; a late result after a disable is ignored.
- Warnings: the rule is gone or points elsewhere ("Tailscale no longer serves Wardrobe at this address" + **Turn on again**); remote access on while Tailscale is not connected; an existing rule on `https://<name>/` that enabling would replace; Funnel on (red, with the `tailscale funnel --https=443 off` command).
- Troubleshooting (a `<details>`, opened automatically when MagicDNS or HTTPS certificates are off): the MagicDNS and HTTPS flags, the admin-console step with **Open the DNS page**, "the computer is asleep" with the platform's power settings path, "the certificate is pending", and a link to the guide.

### Decisions and deviations, with reasons

1. **No counselor was consulted.** The workflow asks for an Agent-tool counselor (model "fable") on real doubts, but this session has no Agent tool (a tool search found none), as in Features 01 to 06. Decisions 2, 4 and 5 are the ones a counselor would have reviewed.
2. **The Google Drive control routes also accept a proxied same-origin request.** The plan says the Archive tab stays usable remotely except Connect, but the Drive plugin's own check (`sameOrigin`) accepts only the configured callback origin (`http://localhost:5173`), so from the phone every Archive action (verify, disconnect, activation preview/choice, restore preview/confirm, disable, retry) would have failed with `cross_origin_request`. The routes now accept `sameOrigin(req, service) || isForwardedSameOriginRequest(req)`: the Origin must equal the first `X-Forwarded-Host`, so only a request that came through a proxy naming that host qualifies, and a direct request from `http://127.0.0.1:5173` is still refused, as before (tested). **`oauth/start` keeps the strict callback-origin check**, because its nonce cookie and Google's redirect only work on the callback origin; the web guard hides Connect remotely anyway. This departs from Google Drive Feature 02's rule "require the request Origin and configured callback origin to agree for control POSTs" for these non-OAuth routes; CSRF protection is unchanged, because a cross-site page can set neither `Origin` nor `X-Forwarded-Host`.
3. **The same-origin helpers live in a new `scripts/same-origin.mjs`.** The Drive plugin needs them, and importing `import-job-api.mjs` from it would load `sharp` and the whole import pipeline into the Drive module. `import-job-api.mjs` re-exports `isSameOriginRequest`, so existing imports are unchanged.
4. **At launch a missing serve rule is reported, not re-created.** The plan says the shell "re-checks that the serve rule still exists". `--bg` rules persist in Tailscale's preferences, so a missing rule means someone removed it outside Wardrobe (`tailscale serve reset`, the Tailscale UI). Silently publishing again would override that choice. The panel shows the warning with **Turn on again**, and the log records it. A port change, by contrast, is a click in Wardrobe, so the rule follows the new port automatically.
5. **Disable removes only Wardrobe's rule.** `tailscale serve --https=443 off` clears the whole `:443` web config. It runs only when `serve status` shows the rule pointing at Wardrobe's port (or the status cannot be read); a rule someone else put there is left alone. Enabling over another rule is allowed, with a warning in the panel first. Known limitation: the check looks up the recorded `remote_host`, so if the machine is renamed in Tailscale while the app runs (the launch re-check refreshes the name only at the next start), disable finds no rule under the old name and leaves the `:443` rule in place; Wardrobe still drops the name from `--allowed-hosts`, and `tailscale serve --https=443 off` removes the rule by hand.
6. **`tailscale serve` waiting for HTTPS approval.** With HTTPS Certificates off, current CLIs print "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=…" and keep waiting. `serve` is killed after 20 s, and the error names that URL and the admin-console switch. The URL is shown as text (not opened by the app); **Open the DNS page** opens the fixed admin-console URL. Other recognised failures: a CLI without `--bg` ("too old … 1.52 or later") and access-denied errors.
7. **The tailnet name is a separate `remote_host` field, the exact name only.** Writing it into the user's `allowed_hosts` would mix user and shell entries and make "disable" guess what to remove. `.ts.net` would admit every machine name in the tailnet domain; the exact name is narrower and is what the plan asks for.
8. **`tailscale_health` is a fifth command**, beside the four the plan names, because the 60 s poll must not block the enable command. It polls every 2 s (10 s per request), stops early on a `403 host_not_allowed`, keeps polling on connection, TLS, timeout and `502`–`504` errors (certificate pending, server restarting), and reports the last reason.
9. **HTTPS detection uses `CertDomains`.** `tailscale status --json` has no "HTTPS enabled" flag, but `CertDomains` lists the machine's name only when HTTPS Certificates are on (verified on this machine, where it is `null` with HTTPS off). The panel uses it to open the troubleshooting; enabling is not blocked on it, so a CLI that does not report it still works.
10. **The web guard's notice is in Italian**, "Collega Google Drive dal computer su cui è in esecuzione Wardrobe.", because the whole Archive tab is in Italian; the plan's English sentence is its meaning. The guard also hides **Ricollega account** (reconnect), which starts the same OAuth flow. `[::1]` counts as local besides `localhost` and `127.0.0.1`.
11. **Funnel is detected and flagged, never touched.** The app never runs `tailscale funnel`; if Funnel is on for the address, the panel shows a red warning with the command to turn it off.
12. **`WARDROBE_DESKTOP_TAILSCALE`** overrides the CLI location (tests and unusual installs), in the style of the other `WARDROBE_DESKTOP_*` switches.
13. **QR code library:** `qrcode-generator` 2.0.4, drawn as one SVG path in React (no `innerHTML`, no canvas), black on white in both themes so phone cameras read it.

### Verification run (Windows 11, x86_64-pc-windows-msvc)

- **Root, new tests** (`node --test test/desktop-feature07.test.mjs`): 10 of 10 pass.
  - Same-origin unit cases for both header shapes: `Host: <name>` (also with `:443` and upper case) and `Host: 127.0.0.1:5173` plus `X-Forwarded-Host: <name>` (also a comma list and a repeated header); refusals for another port, another name, a non-first forwarded value, `user@host` and `host/path` values, no Origin, `null`, `file:`, and no host at all.
  - Through `startServer` with a temporary root: the tailnet name gets `403 host_not_allowed` until `allowedHosts` names it; then `/api/health` and `/` answer, and another machine's `*.ts.net` name is still refused.
  - `POST /api/import/mode` (the Gemini TEST/PROD switch) from the phone in both header shapes: 200, and the desktop then reads `test`; a cross-site Origin gets 403.
  - Managed mode: `POST /api/setup/config` from the phone in both shapes returns 409 `managedBy: "desktop"` and no `.env` is written; `/api/setup/providers` reports `managed: true`.
  - Google Drive with the four values configured: `disconnect` through the proxy shape answers 200; `oauth/start` through the proxy gets 403 `cross_origin_request`; a direct `http://127.0.0.1:<port>` Origin is still refused; a cross-site Origin is refused; the client secret appears in no response.
  - `isRemoteHostname` for `localhost`, `127.0.0.1`, `[::1]`, `localhost.` (local) and a `*.ts.net` name, Tailscale and LAN IPs, a `.local` name (remote).
- **Related root tests** (`desktop-feature07`, `standalone-server`, `desktop-feature02`, `setup-providers`, `feature01-review-regressions`, `google-drive-feature05-client`): 62 tests, 61 pass, 1 skipped (the POSIX `SIGTERM` test).
- **Full root suite**, `node --test --test-timeout=60000 test/*.test.mjs`: 473 tests, 400 pass, 71 fail, 1 cancelled, 1 skipped (Feature 06: 463 / 391 / 70 / 1 / 1; the 10 new tests all pass).
  - Every failure is in a file already known to fail on Windows: `google-drive-feature02` to `04`, `archive-store` (2, `/private/tmp`), `bulk-import-archive-acceptance` (2), `mirror-fixtures` and `mirror-invariants` (no real `data/library.json`).
  - Because this feature changed `scripts/google-drive-api.mjs`, the five `google-drive-feature0*` files were also run on a `git archive HEAD` export (linked to the same `node_modules`) and on the working tree, one file at a time: baseline 126 tests, 64 pass, 61 fail, 1 cancelled; after 126, 65 pass, 60 fail, 1 cancelled. The tests that differ (three only failing after, four only failing at baseline) are all `persistent Google Drive archive sync` cases ending in the known Windows `sync_state_invalid` error (Feature 01 notes); none failed with `cross_origin_request`, and the existing "serves OAuth only as a same-origin control flow" test fails identically in both runs on its macOS-only `/private/tmp` path. So `npm run check` still cannot pass on Windows, as recorded since Feature 01.
- **`npm run build`** passes at the root and in `desktop/`.
- **`npm test` in `desktop/`:** 18 node tests (the bundle test bundles `server.mjs` with the new `same-origin.mjs`) and 39 Vitest tests pass (11 new in `remote.test.jsx`). The new tests cover: the state line, the explanation and the toggle; enabling, then the URL, a QR `<path>` and the health line, with `set_config` never called; Copy; a health check on open when already on, its failure text and Check again; disabling; an enable error (MagicDNS off) shown as an alert with the troubleshooting open and both flags "Off", and **Open the DNS page** calling `open_help("tailscale-dns")`; not installed with the toggle disabled and **Download Tailscale**; the missing-rule warning and **Turn on again**; the replace and Funnel warnings; every state label; the QR matrix (finder pattern, square) and path.
- **`cargo test --locked`** in `desktop/src-tauri`: 63 unit tests (19 new: 17 in `tailscale::tests`, plus one each in `config` and `sidecar`), 1 import-data test and 8 lifecycle tests pass; `tailscale_cli` is ignored by default. `cargo clippy --all-targets` reports no warnings and `cargo fmt --check` is clean. The new tests cover:
  - Status parsing from the fixtures: logged out (`NeedsLogin`, no DNS name), logged in without MagicDNS (name present, enabling refused with the MagicDNS message), connected with the DNS name (trailing dot stripped, lower-cased, HTTPS on), connected with `CertDomains: null` (HTTPS off) and a health warning; malformed output; `Stopped`.
  - Serve status: empty, ours, another port, another machine name, a different target with Funnel on, malformed.
  - Argument construction for status, serve status, enable (per port) and disable; none mentions Funnel or `0.0.0.0`.
  - CLI location per platform, the override variable, and "not found".
  - The approval URL in the "Serve is not enabled" output.
  - `query_status` with a scripted CLI: not installed, service not running, logged out (no serve call), connected and served; the camelCase JSON.
  - `enable`: the call order `status → serve --bg … → serve status`; refusals when logged out (serve never runs) or MagicDNS is off; HTTPS approval timing out with the URL in the error; an old CLI; a rule left pointing at another port.
  - `disable`: removes our rule; leaves another target and an empty config alone; reports a failed `off`.
  - `ProcessCli` with the real shell: stdout and stderr captured, exit code, the 300 ms timeout killing a 5 s command (returns in about 2.4 s because of the pipe grace), a missing binary.
  - The health poll against a local HTTP server: `502` then `200` (two attempts, version read), `403 host_not_allowed` (stops after one attempt), a closed port (gives up at the timeout).
  - Config: the remote fields, `effective_allowed_hosts` (no duplicate), `remote_url`, restart on change, patches leaving them alone, an invalid stored name ignored with a warning. Sidecar: `--allowed-hosts <name>` only while on, merged after user entries, `--host 127.0.0.1` unchanged.
- **Read-only check against the real Tailscale here** (`cargo test --test tailscale_cli -- --ignored --nocapture`, which runs only `version`, `status --json` and `serve status --json`): Tailscale 1.104.6, state Connected, `BackendState` Running, online, MagicDNS on, HTTPS certificates **off** (`CertDomains: null`), nothing served, no Funnel. The parser read the real output as expected.
- **Listening addresses.** `node scripts/server.mjs --port 5191 --host 127.0.0.1 --data-dir <temp> --cache-dir <temp> --allowed-hosts wardrobe-mac.tail1234.ts.net`, the flags the shell passes with remote access on. `netstat -ano` showed one listener, `TCP 127.0.0.1:5191 0.0.0.0:0 LISTENING`. `Host: wardrobe-mac.tail1234.ts.net` got 200, `Host: evil.example` 403, and a `POST /api/import/mode` in the `X-Forwarded-Host` shape 200. The temporary folder was deleted.
- `tailscale serve` was **never run** on this machine: it would change the owner's tailnet configuration, and HTTPS Certificates are off in this tailnet, so it would only have stopped at the approval step. The app was not launched with `tauri dev` for this feature; the panel is covered by the Vitest tests and the CLI path by the read-only check above.

### Pending manual verification

- **First real enable, macOS and Windows** (admin console: MagicDNS and HTTPS Certificates on):
  - Settings › Remote access › Enable: the URL, the QR code, and the health line turning "Reachable" (record how long the first certificate took).
  - Record the headers `tailscale serve` actually forwards (`Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`, `Tailscale-User-*`), for example with a temporary log line in `createHostAllowlist`, and add them to these notes. Both possible shapes are handled.
  - Whether `tailscale serve --bg` needs elevation on Windows or the macOS App Store build, and how its errors read.
  - With HTTPS Certificates still off: the "Serve is not enabled" approval URL in the panel error after about 20 s, and that nothing was changed.
- **From the phone** (Safari on iOS, Chrome on Android): the mobile layout; browse the wardrobe; open an outfit; run one import from a camera-roll photo; toggle Gemini TEST/PROD and see it on the desktop after a reload; Settings › AI read-only (managed); a phone-side `fetch("/api/setup/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })` returns 409; Settings › Archive shows the notice instead of Connect, and the other Archive actions work; filters and sort preferences are shared with the desktop.
- **Disable** from the panel: the URL stops answering within seconds; `http://localhost:5173` keeps working; `tailscale serve status` is empty.
- **App restart and reboot** with remote access on: the first start passes the name, the log shows "tailscale serve still points at …", and the phone works again without a click. After `tailscale serve reset`: the panel shows **Turn on again**, which works.
- **Port change** with remote access on (Storage › port): `tailscale serve status` follows the new port and the phone keeps working.
- **Listening addresses on macOS**: `lsof -iTCP -sTCP:LISTEN -n -P | grep node` shows only `127.0.0.1:<port>`.
- **macOS CLI path**: the App Store and standalone builds' `/Applications/Tailscale.app/Contents/MacOS/Tailscale` answer `status --json` when called from the app; the Homebrew `tailscale` on `PATH` as the fallback.
- **Clipboard** (Copy) in WebView2 and WKWebView, and the QR code scanned by an iPhone and an Android camera.
- **CI**: `desktop-rust` compiling the new direct `reqwest`/`rustls`/`tokio` dependencies on macOS and Windows; nothing was pushed.
