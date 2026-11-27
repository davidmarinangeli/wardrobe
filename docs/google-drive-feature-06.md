# Feature 06 — Guided Google Cloud setup for the Drive archive

## Goal and baseline

Today a user who opens **Settings › Cloud backup** without the four `GOOGLE_DRIVE_*` values sees one paragraph naming the variables and pointing at `docs/google-drive-operations.md` (`src/settings-modal.jsx:113-123`). The operations doc describes the Google Cloud steps in prose but links none of the console pages, so the user has to find each screen on their own.

This feature replaces that dead end with a step-by-step guide where every step has a clickable link that opens the exact Google page where that step is done: create the project, enable the Drive API, configure the consent screen, add the test user, create the OAuth client, pick the Drive folder, publish the app. The same steps and links go into the operations doc, so the README/AGENTS path and the in-app path say the same thing.

Plan written against HEAD `776ade5` on `feat/google-drive-archive`. React/Vite/Node architecture unchanged, no new dependencies. The working tree has uncommitted Drive work in `scripts/google-drive-*.mjs`, `src/google-drive-storage.*`, `src/settings-modal.jsx` and tests: rebase this feature on top of it once it lands, and do not overwrite it.

## The steps and their links

One ordered list, used by both the UI and the doc. Console URLs open the currently selected project; the guide tells the user to check the project picker in the console header before each step (every console link also accepts `?project=<PROJECT_ID>`, see the optional item in phase 2).

| # | Step | Link | What the user does there | Produces |
| --- | --- | --- | --- | --- |
| 1 | Create a Google Cloud project | `https://console.cloud.google.com/projectcreate` | Name it (e.g. "Wardrobe"), create it, select it in the header. | — |
| 2 | Enable the Google Drive API | `https://console.cloud.google.com/apis/library/drive.googleapis.com` | Press **Enable**. | — |
| 3 | Configure the Google Auth Platform (consent screen) | `https://console.cloud.google.com/auth/overview` | **Get started**: app name, support email, audience **External**, contact email. | — |
| 4 | Add the Drive scope | `https://console.cloud.google.com/auth/scopes` | **Add or remove scopes** → `https://www.googleapis.com/auth/drive`. Explain it is a restricted scope and why `drive.file` is not enough (link to the existing section in the operations doc). | — |
| 5 | Add yourself as a test user | `https://console.cloud.google.com/auth/audience` | **Add users** → the Google account that will hold the archive. | — |
| 6 | Create the OAuth client | `https://console.cloud.google.com/auth/clients/create` | Type **Web application**; under **Authorized redirect URIs** paste the exact callback shown by the guide (see below). Copy client ID and secret (the secret is shown in full only at creation). | `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REDIRECT_URI` |
| 7 | Choose the Drive folder | `https://drive.google.com/drive/my-drive` | Create or open the folder; the ID is the last segment of `https://drive.google.com/drive/folders/<ID>`. | `GOOGLE_DRIVE_FOLDER_ID` |
| 8 | Write `.env` and restart | — (local) | Paste the four values, restart the backend (phase 2 does this from the UI). | — |
| 9 | Publish the app (avoids the weekly expiry) | `https://console.cloud.google.com/auth/audience` | After the first successful connection, **Publish app** → **In production**, **without** submitting for verification. At sign-in choose **Advanced** → continue. | — |
| — | Troubleshooting / revoking access | `https://myaccount.google.com/connections` | Remove Wardrobe's access; then reconnect from Settings. | — |

Fallback for older console layouts: `https://console.cloud.google.com/apis/credentials` (clients) and `https://console.cloud.google.com/apis/credentials/consent` (consent screen). Google moves these pages from time to time: **before merging, open every link while signed in and confirm it lands on the described screen**, and update the table if not.

### The redirect URI is computed, not typed

The most common setup error is a callback that differs from the page origin. The server accepts only `https://…` or loopback `http://…`, no query/hash/credentials, path exactly `/api/google-drive/oauth/callback` (`scripts/google-drive-auth.mjs:80-93`). The guide shows `${window.location.origin}/api/google-drive/oauth/callback` with a **Copy** button, to paste into step 6 and into `GOOGLE_DRIVE_REDIRECT_URI`. If the origin is plain HTTP on a non-loopback host, the guide says HTTPS is required instead of offering a value that will be rejected.

## Phase 1 — Guide in the app and in the docs (required)

1. **`src/google-drive-setup-guide.js`** (new, no React): exports `GOOGLE_DRIVE_SETUP_STEPS` — `{ id, title, url, urlLabel, body, produces? }` in Italian, matching the archive panel's copy — plus `callbackUrlFor(origin)` returning `{ url }` or `{ error: "https_required" }` using the same rules as the server. Importable by Node tests, like `google-drive-storage.js`.
2. **`src/google-drive-setup-guide.jsx`** (new): `<GoogleDriveSetupGuide status={status} />`. Numbered list; each step has the title, one or two short sentences, and a link `target="_blank" rel="noreferrer"` with a visible label (e.g. `console.cloud.google.com/auth/clients/create`), the same pattern as `getKeyUrl`/`getKeyLabel` in `src/onboarding.jsx:48-74,253`. Step 6 shows the computed callback + Copy; step 8 shows the `.env` block with the four variable names and the callback already filled in (Copy button), never real values.
3. **`src/settings-modal.jsx`**: in the greyed-out state replace the paragraph at lines 113-123 with `<GoogleDriveSetupGuide />`. The tab stays `aria-disabled` and clickable as it is now. Keep the existing focus/Escape behavior; the guide adds no dialogs.
4. **Make the error point at the right step.** `configured` alone does not distinguish "nothing set", "something missing" and "something invalid". Extend the base status in `scripts/google-drive-auth.mjs` `getStatus()` with two safe fields:
   - `configMissing`: names of the unset variables (names only, never values);
   - `configProblem`: `"folder" | "callback" | "credentials" | "placement" | null`, derived from the reason `readConfig` currently throws and then flattens into `configuration_invalid`.
   The guide highlights the corresponding step (folder → 7, callback → 6, credentials → 6, missing → 8; `placement` is a data-dir problem, shown as a message without a step). States `unconfigured` / `configuration_incomplete` / `configuration_invalid` stay the same: these fields add information, they change no behavior.
5. **Also reachable once configured.** In `ArchiveSettings`, a small collapsed "Guida alla configurazione" link that opens the same guide, useful for step 9 (publishing) and when `lastAuthError` reports a `redirect_uri_mismatch` or an expired session.
6. **`docs/google-drive-operations.md`**: rewrite "Configure a personal Google account" as the numbered list from the table, with the same links as Markdown links, keeping the sections on scope, publishing and recovery that are already there. Update the `.env.example` comment (lines 66-74) with the step-6 and step-7 links, and the variable rows in `AGENTS.md`/README if they mention the setup.
7. **Styles** in `src/settings-modal.css` (or a dedicated `google-drive-setup-guide.css` if it grows past ~40 lines): reuse the existing tokens/classes (`onboarding-eyebrow`, buttons). Check mobile width: long URLs in the labels have to wrap (`overflow-wrap: anywhere`).

## Phase 2 — Save the values from the guide (optional, recommended)

The AI tab already writes keys to `.env` through `POST /api/setup/config` with `upsertEnvValues`, a same-origin check, and Vite restarting on its own (`scripts/setup-api.mjs:8,93-110`). The guide can do the same and save the user from hand-editing the file:

- a small form under step 8: client ID, client secret (`type="password"`, write-only, never read back), folder ID or the **whole folder URL** (the client extracts the ID from `/folders/<ID>`), and a read-only redirect URI precomputed from the origin;
- server side, a separate endpoint `POST /api/setup/google-drive` (or extend `WRITABLE_KEYS` with the four `GOOGLE_DRIVE_*` keys) that validates with the same rules as `readConfig` **before** writing, so an invalid `.env` is never saved, and rejects line breaks like the existing endpoint;
- after the save, Vite's restart reloads the page; the guide reopens on the Cloud backup tab, which is now active, with the **Connetti** button available.
- Optional input: the Google Cloud project ID, used only to append `?project=<ID>` to the console links so they always open in the right project. Kept only in component state.

If phase 2 is skipped, step 8 stays "copy the block into `.env` and restart".

## Tests

All in `node --test`, no real `.env`, no real Google calls (same conventions as the `google-drive-feature0*` tests):

- `test/google-drive-feature06.test.mjs`:
  - every step has an `https://` URL on an expected host (`console.cloud.google.com`, `drive.google.com`, `myaccount.google.com`) and a non-empty label;
  - `callbackUrlFor`: `http://localhost:5173` → correct callback; `https://wardrobe.example` → ok; `http://192.168.1.10:5173` → `https_required`; a temporary config built with that callback yields `configured: true` from `getStatus()` (checks that client and server rules match);
  - **drift guard**: every URL in `GOOGLE_DRIVE_SETUP_STEPS` also appears in `docs/google-drive-operations.md`;
  - `getStatus()` with temporary configs: nothing set → `configMissing` has all four names; missing folder → only that one; malformed folder → `configProblem: "folder"`; non-loopback HTTP callback → `"callback"`; no value appears in the payload.
- If phase 2 is done: the endpoint saves the four keys, refuses invalid values without touching `.env`, refuses cross-origin requests, never returns the secret.
- Manual check with `npm run dev`: greyed tab → guide visible, links open in a new tab on the right screens, Copy works, mobile layout OK; with the four values set the tab becomes active and the guide is reachable from the "Guida alla configurazione" link (phase 1, item 5).

`npm run check` must pass.

## Out of scope

- Automating Google Cloud project creation (`gcloud`, Resource Manager API): it needs credentials we don't have before setup, and the manual steps take a few minutes.
- Screenshots of the console: they go stale faster than the links; the text describes the button to press.
- Changes to OAuth, scopes, sync or restore.
