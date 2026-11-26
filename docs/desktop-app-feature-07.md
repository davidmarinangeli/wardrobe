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
