# Google Drive archive: setup, portability, and recovery

Wardrobe remains a local-first app. Its configured data directory is authoritative; Google Drive can hold the latest completed portable snapshot. Storage settings work without an AI provider or AI key. Connecting a Google account does not enable backup: choose **Locale + Google Drive** explicitly after connection and folder verification.

## Configure a personal Google account

1. In Google Cloud Console, create or select a project and enable the Google Drive API.
2. Configure the OAuth consent screen. For an ordinary personal Google account, use the **External** audience and add that account as a test user while the app is in Testing. **Internal** is for an organization-managed audience. Once the connection works, set the publishing status to **In production** without submitting for verification, so the connection no longer expires every seven days (see [Google access and publication](#google-access-and-publication)).
3. Create an OAuth client ID of type **Web application**. Add the exact redirect URI for this Wardrobe instance, including scheme, host, port, and path. For the default local Vite origin, use:

   ```text
   http://localhost:5173/api/google-drive/oauth/callback
   ```

   Google permits HTTP for loopback development addresses. For a deployed instance, use HTTPS. The page origin must match the origin in the configured callback.
4. Put the four values below in the backend `.env` (copy `.env.example` if needed). Keep the client secret there; do not add it to browser code or share it. `GOOGLE_DRIVE_FOLDER_ID` is the ID of an existing Drive folder, not its URL.

   ```dotenv
   GOOGLE_DRIVE_CLIENT_ID=
   GOOGLE_DRIVE_CLIENT_SECRET=
   GOOGLE_DRIVE_REDIRECT_URI=http://localhost:5173/api/google-drive/oauth/callback
   GOOGLE_DRIVE_FOLDER_ID=
   ```

5. Restart the backend, open **Settings › Archive** from the gear (or the onboarding shortcut), connect the intended account, and verify access to the configured folder. Then explicitly select **Locale + Google Drive** and complete the archive decision shown by the app. The decision is required even for an empty folder. To use storage manually without enabling background synchronization, keep **Solo locale** selected and use **Ripristina da Google Drive** when needed.

Changing the account, OAuth client, callback, or folder requires a reconnect and a fresh archive decision. A successful OAuth callback never selects Drive mode for you. If the callback URI or page origin differs from the registered/configured values, correct the configuration and reconnect.

## Google access and publication

Wardrobe requests `https://www.googleapis.com/auth/drive`, a restricted scope that grants the OAuth token access to the user's Drive files. The application checks and uses the configured folder boundary in its own transport; that check does not narrow the scope Google grants to the token. Google's `drive.file` scope is limited to files individually created, opened, or selected for the app and does not provide general access to an arbitrary existing configured folder. See Google's [Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [scope definitions](https://developers.google.com/identity/protocols/oauth2/scopes).

During personal testing with an External consent screen in Testing, Google says refresh tokens expire after seven days when the requested scopes include Drive access. When that happens, the app keeps working locally, queues changes, and reports "La sessione Google Drive è scaduta. Ricollega l’account."; reconnecting the same account resumes the queued backup.

For personal use, avoid the weekly expiry by opening the OAuth consent screen in Google Cloud Console and choosing **Publish app** to move the publishing status to **In production**. Do not submit the app for verification. Google then shows a "Google hasn't verified this app" warning at sign-in; choose **Advanced** and continue to the app. Unverified apps are limited to a small number of users, which is fine for a single owner. Refresh tokens in production no longer have the seven-day limit, but can still expire or be revoked, for example after six months without use, when access is removed in Google Account settings, or after some password changes. Reconnect when prompted.

These limits are separate from publishing: publicly distributing an OAuth app that uses sensitive or restricted scopes can require verification, and restricted-scope use may require a security assessment under Google's rules. Verification or assessment approval is not guaranteed by this project. Consult Google's [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent), and [refresh-token expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration) for current requirements.

## What is archived

The archive uses a fixed allowlist, not a recursive copy of the data directory. It contains these catalogs when present:

- `library.json`, `outfits.json`, `inspo.json`, `wishlist.json`, and `cheat-sheets.json`;
- `preferences.json` (including durable history), `color-profile.json`, `browser-state.json`, `ai-mode.json`, and `archive-metadata.json`.

It also includes media under `imported/`, `outfits-assets/`, `outfit-images/`, `inspo-assets/`, `wishlist-assets/`, `cheat-sheets-assets/`, and `originals/`; and root-level `model-reference` and `model-reference-face` files with PNG, JPG, JPEG, or WebP extensions. New source originals are captured before AI processing and included. Deleting a garment also deletes its originals from `originals/` once no other garment, outfit, inspiration, wishlist entry, model reference, or pending import still uses them; the next sync removes them from Drive as well. Original photos deleted before that capture feature cannot be recovered automatically.

The archive excludes `.env` and API keys, OAuth credentials/tokens, the `.google-drive/` private control directory, locks, caches, temporary work, staging and rollback data, derived `style-dna.json` and `identity-profile.json`, and public drape images. The selected AI mode is archived; provider secrets are not. Keep secrets in the installation's `.env`.

Catalog media references use archive-relative paths, so the allowlisted catalog/media tree can be copied to another Wardrobe data directory without relying on Drive file IDs or the original machine's source paths. To make a manual filesystem copy, stop the app first and copy the persistent allowlisted catalogs and media while preserving their relative paths. Do not copy `.google-drive/` as archive content. A manual copy moves the selected current data; it does not create an automatic merge or version history.

Drive stores the selected completed snapshot with its portable inventory and commit descriptor. The app publishes a new completed snapshot rather than merging edits from separate installations. A Drive folder is not a version-history service: transient upload candidates or cleanup residue are not user-visible backups. Use one backend writer for an archive and target folder; multiple browsers can use that same backend. Do not run independent backends against the same archive target expecting conflict-free merging.

## Backup behavior and limits

While synchronization is enabled, changes are queued and the local archive remains usable during a Drive outage. The app warns that local changes will overwrite the configured Drive archive after the connection returns. Normal synchronization gives local state precedence over remote changes; it is not a two-way merge. Disabling synchronization drains/disables the worker and keeps both the local and Drive copies. Disconnecting removes this installation's saved connection; it neither deletes the Drive archive nor revokes the app's grant in Google Account settings.

The implementation bounds Drive folder ancestry to 32 levels, listings to 100 pages and 50,000 entries, in-memory content reads to 64 MiB per file, and streamed file verification/downloads to 2 GiB per file. Resumable upload chunks are at most 8 MiB. The background worker checks for work every 15 seconds and retries with exponential delay capped at five minutes; these are implementation bounds, not a completion-time guarantee.

## Restore and repair

**Ripristina da Google Drive** is separate from backup mode and remains available when connected while **Solo locale** is selected. The app first previews and validates a complete Drive snapshot. After the explicit whole-archive confirmation, it blocks new archive mutations, drains work already admitted, pauses outbound synchronization, downloads to private staging, verifies the inventory/catalogs/media, then replaces the complete allowlisted local archive. It does not merge. A successful manual restore advances archive generation to invalidate mounted browser caches and preserves the previously selected storage mode.

Before replacement, the app captures the previous local allowlisted bytes. If validation or replacement fails, it attempts to restore and verify those prior bytes. If recovery cannot be proven complete, the app keeps the private journal/recovery evidence and maintains the mutation gate until recovery can resolve it; the UI reports a repair/recovery error. Do not delete or rename files under `.google-drive/` to work around such an error. Reopen **Settings › Archive** and let startup recovery run, then follow the surfaced status. This protects the prior archive through tested transaction boundaries, but cannot protect against disk/device loss or a user manually deleting recovery data.

Activation previews distinguish an empty destination from an unreadable, incomplete, or invalid archive. Only a validated choice shown by the preview can enable synchronization. Cancel leaves both copies intact. A manual restore preserves the current local/Drive mode, and disabling Drive never deletes either copy.
