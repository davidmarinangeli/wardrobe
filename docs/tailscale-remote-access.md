# Remote access with Tailscale

Use Wardrobe from your phone, or from another computer, while it keeps running on your own computer. The phone opens an HTTPS address that only devices in your [Tailscale](https://tailscale.com) network (your *tailnet*) can reach. There is no Wardrobe account and no password: being logged into the tailnet is the only way in.

What the phone gets is the normal Wardrobe web app with its mobile layout. There is no separate mobile app.

## Before you start (one time)

1. **Tailscale on both devices.** Install Tailscale on the computer that runs Wardrobe and on the phone, and log in with the same account (or into the same tailnet) on both. Download: <https://tailscale.com/download>.
2. **MagicDNS and HTTPS Certificates in the admin console.** Open the [Tailscale admin console](https://login.tailscale.com/admin/dns) and go to the **DNS** page:
   - Under **MagicDNS**, choose **Enable MagicDNS** (on by default in new tailnets).
   - Under **HTTPS Certificates**, choose **Enable HTTPS** and confirm.

   Without HTTPS Certificates Tailscale cannot give the address a certificate. If you skip this step, turning remote access on shows a `https://login.tailscale.com/f/serve?...` link that leads to the same switch.
3. **Keep the computer awake.** The address answers only while the computer is awake, Tailscale is connected and Wardrobe is running. If the computer sleeps while you are away, change its sleep settings (macOS: **System Settings › Energy** or **Battery**; Windows: **Settings › System › Power & battery › Screen and sleep**). Keeping the computer awake is up to you; Wardrobe does not change these settings.

## Turn it on in the desktop app

1. Open **Settings** from the tray icon (Windows) or the menu bar icon (macOS) and choose **Remote access**.
2. The first line shows what Tailscale is doing: *not installed*, *not logged in*, *turned off*, or **Connected as `<machine>.<tailnet>.ts.net`**.
3. Tick **Enable remote access**.

Wardrobe runs `tailscale serve`, restarts its server so that it accepts the tailnet name, and then shows:

- the address, `https://<machine>.<tailnet>.ts.net/`, with a **Copy** button;
- a QR code of the address: scan it with the phone's camera;
- the result of a check that opens `https://<machine>.<tailnet>.ts.net/api/health` through Tailscale. The first check after turning remote access on can take up to a minute while Tailscale issues the certificate.

The setting is remembered. After a restart of the app or of the computer, Wardrobe accepts the tailnet name again and checks that Tailscale still serves it. Tailscale keeps its own rule across reboots, too.

The address has the form `https://<machine>.<tailnet>.ts.net/`, for example `https://studio-mac.tail1234.ts.net/`. `<machine>` is the computer's name in Tailscale and `<tailnet>` is your tailnet's DNS name, both shown on the admin console's **Machines** and **DNS** pages.

## What the phone can and cannot do

| From the phone | |
| --- | --- |
| Browse the wardrobe, pieces, outfits, Overview, Inspo, Mirror, My Colors | Yes |
| Import a photo (also from the camera roll), generate images, create outfits | Yes |
| Gemini TEST/PROD switch | Yes. The computer sees the change after a reload: the mode is stored by the server. |
| Settings › Archive: status, backup on/off, restore, check access, disconnect | Yes |
| Settings › Archive: **connect** a Google account | No. Connect Google Drive on the computer; the phone then uses that connection. The tab says *"Collega Google Drive dal computer su cui è in esecuzione Wardrobe."* |
| API keys, provider, port, data folder, any other setting | No. They exist only in the desktop app's Settings window on the computer. In Wardrobe › Settings › AI the phone sees the same read-only state the desktop shows. |

Why Google Drive connect is excluded: Google sends the sign-in back to `http://localhost:5173/…`, and on the phone `localhost` is the phone itself. A phone sign-in flow is a later decision.

Your preferences (the server-side browser state) are shared: a filter or sort chosen on the phone is the same on the computer.

## Turn it off

Untick **Enable remote access**. Wardrobe runs `tailscale serve --https=443 off` and restarts its server without the tailnet name. The address stops answering within seconds; `http://localhost:5173` on the computer keeps working.

Wardrobe removes the Tailscale rule only when it still points at Wardrobe. If you changed it to something else in the meantime, it is left alone.

**Quit** in the tray also stops the server, so the address stops answering until Wardrobe runs again (Tailscale then answers with an error page). Remote access stays on for the next launch.

## What is exposed, and to whom

- The Wardrobe server only ever listens on `127.0.0.1` (this computer). Other devices on your Wi-Fi cannot reach it.
- `tailscale serve` forwards `https://<machine>.<tailnet>.ts.net/` (port 443) to `http://127.0.0.1:<port>`. Only devices in your tailnet can open it, subject to your tailnet's access rules.
- Wardrobe never turns on **Tailscale Funnel**, which would publish the address on the public internet. If Funnel is on for this address anyway (turned on by hand), the Remote access screen shows a red warning; turn it off with `tailscale funnel --https=443 off`.
- Everyone in your tailnet who opens the address uses Wardrobe as you do. There are no per-person accounts inside the tailnet.
- The server accepts only the exact tailnet name of this computer, plus `localhost` and IP addresses. Requests that change something must come from a page of that same address (same-origin check), also behind Tailscale.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| *Tailscale is not installed on this computer* | Install it from <https://tailscale.com/download>, log in, then choose **Refresh**. |
| *Tailscale is installed but not running* / *turned off* / *not logged in* | Open the Tailscale app, log in or turn it on, then **Refresh**. |
| Turning on fails with *MagicDNS is off for your tailnet* | Admin console › **DNS** › enable MagicDNS (and HTTPS Certificates), then try again. |
| Turning on fails with a `https://login.tailscale.com/f/serve?...` link | HTTPS Certificates are off. Open the link (or admin console › **DNS** › **HTTPS Certificates** › **Enable HTTPS**), then turn remote access on again. |
| The check says *Not reachable yet* right after turning on | The certificate may still be pending. Wait a minute and choose **Check again**, or reload the page on the phone. |
| The phone cannot open the address | The phone must be logged into the same tailnet with Tailscale connected (check its VPN switch). The computer must be awake and Wardrobe running. |
| *Tailscale no longer serves Wardrobe at this address* | The rule was removed or changed outside Wardrobe (for example `tailscale serve reset`). Choose **Turn on again**. |
| *Wardrobe refused the tailnet name* | Restart the server from **Settings › Status**, then **Check again**. |
| You changed the port in **Settings › Storage** | Nothing to do: with remote access on, Wardrobe points the Tailscale rule at the new port. |
| *This Tailscale version is too old* | Update Tailscale. Wardrobe needs `tailscale serve --bg` (Tailscale 1.52 or later). |

The server log (**Settings › Status**) records each step with a `remote access` prefix.

## Without the desktop app (`npm run start`)

The standalone server can be published the same way by hand:

```bash
npm run build
WARDROBE_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net npm run start
# in another terminal:
tailscale serve --bg 5173
```

`tailscale serve --bg 5173` is the short form of `tailscale serve --bg --https=443 http://127.0.0.1:5173`. Find the machine's name with `tailscale status --json` (`Self.DNSName`, without the trailing dot), or use `WARDROBE_ALLOWED_HOSTS=.ts.net` to accept any name in the tailnet domain. To stop: `tailscale serve --https=443 off`.

On Windows PowerShell, set the variable first: `$env:WARDROBE_ALLOWED_HOSTS = "<machine>.<tailnet>.ts.net"; npm run start`.

`npm run dev` (Vite) is not meant for this: its own host check rejects the tailnet name.

## For developers

- Shell side: `desktop/src-tauri/src/tailscale.rs` (CLI location, `status --json` and `serve status --json` parsing, `serve` arguments, the health poll) and the `tailscale_*` commands in `commands.rs`. The CLI is looked up at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (macOS) or `%ProgramFiles%\Tailscale\tailscale.exe` (Windows), then on `PATH`; `WARDROBE_DESKTOP_TAILSCALE=<path>` overrides it.
- Server side: `scripts/same-origin.mjs` accepts an Origin that matches `Host` or the first `X-Forwarded-Host`; the host allow-list (`scripts/host-allowlist.mjs`) gets the name through `--allowed-hosts`.
- Web app: `isRemoteHostname()` in `src/google-drive-storage.js` hides Drive's connect button when the page is not opened on `localhost`, `127.0.0.1` or `[::1]`.
- Design and decisions: [desktop-app-feature-07.md](desktop-app-feature-07.md).
