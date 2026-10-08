# Google Drive backup implementation

This document records the approved scope and sequential implementation workflow.

## Product contract

The existing backend and local disk remain the source of truth. Google Drive holds a complete copy of the latest synchronized user archive, without version history. Only one backend may modify the archive at a time; several browsers may use that backend.

Settings offer local-only storage or local storage plus Google Drive. Environment configuration provides the Drive folder, OAuth client ID, client secret, and callback URL. Operations must stay inside the configured folder, and access errors must never be treated as an empty folder.

The archive includes wardrobe, outfits, wishlist, inspirations, cheat sheets, preferences, history, color profile, reference photos, original imports, and associated media. Credentials, tokens, caches, and temporary processing files are excluded. Preserve every new original before AI processing, including bulk and agent imports. Old deleted originals cannot be recovered automatically.

Catalogs use portable local relative paths, never required Drive IDs. A size/checksum/path inventory verifies integrity and avoids duplicate transfers. Local changes, overwrites, and deletions synchronize in the background through a persistent queue that survives restarts. Local state wins over remote modifications during normal synchronization. The user-facing outage warning is:

> Le modifiche vengono salvate sul computer. Quando il collegamento sarà ripristinato, l’archivio locale sovrascriverà quello su Google Drive.

Activation handles these cases:

| Local | Drive | Required behavior |
| --- | --- | --- |
| Populated | Empty | Confirm upload, then back up |
| Empty | Valid archive | Restore the complete archive |
| Equivalent | Equivalent | Enable without unnecessary transfers |
| Different | Different | Offer use local, use Drive, or cancel |
| Empty | Empty | Initialize a new archive |
| Any | Incomplete or invalid archive | Report the problem; never replace automatically |

Manual restore replaces the complete archive instead of merging. After confirmation, block new mutations, wait for already-running work, and suspend outbound synchronization. Download to staging, verify before replacement, and invalidate previous queued operations. Failure preserves previous local data. Disabling Drive stops synchronization and keeps both copies available.

Settings show a Google icon, account, folder, connection state, transfer progress, pending changes, and the last completed backup, with an explicit “Ripristina da Google Drive” action.

## Sequential features

| Feature | Responsibility | Detailed plan |
| --- | --- | --- |
| 01 — Complete portable local archive | Preserve source files before AI; consolidate browser state into backend data; portable catalogs; define persistent archive boundaries and reusable file inventory primitives. | `docs/google-drive-feature-01.md` |
| 02 — Google OAuth and folder access | Backend-only credentials/tokens; OAuth state and refresh; verify configured folder and permissions; bounded Drive client; safe status and API integration. | `docs/google-drive-feature-02.md` |
| 03 — Persistent background synchronization | Checksummed inventory; persistent queue; upload/update/delete reconciliation; retry/restart recovery; detect script changes; remote errors never become emptiness. | `docs/google-drive-feature-03.md` |
| 04 — Activation and atomic restore | Activation matrix and explicit decisions; complete verified staged restore; mutation/process coordination; rollback; invalidate obsolete sync work. | `docs/google-drive-feature-04.md` |
| 05 — Settings and documentation | Storage mode and account/folder/status/progress UI; activation/conflict/restore confirmations; outage notice; configuration and operational documentation; final integration validation. | `docs/google-drive-feature-05.md` |

## Agent workflow

For each feature, a fresh OWNER (`gpt-6.1-sol`, `xhigh`) explores the relevant code and writes the detailed implementation plan. OWNER delegates implementation to the `CODER` role, then spawns a REVIEWER (`gpt-6.1-sol`, `high`). All actionable review findings are fixed and verified before OWNER spawns PUSHER (`gpt-6-luna`, `high`) to commit the feature. PUSHER commits locally; the request does not include pushing a remote branch. Only after completion does the coordinating agent spawn OWNER for the next feature.

All agents share the checkout. Do not revert another agent’s edits. Keep the existing React/Vite/Node architecture. Never commit `.env`, credentials, tokens, user data, or generated private media. Tests use isolated temporary directories and mocked Google responses; do not invoke paid AI services or modify the real archive for verification.

Each OWNER records implementation decisions, test evidence, review resolution, commit SHA, and any configuration or limitations in its feature plan and reports the interfaces the next OWNER will use.

## Delivery record

All five features are implemented in the existing React/Vite/Node architecture. Features 01–04 are locally committed as `2b41e75`, `ebfdd52`, `c9e4e2e`, and `69e1340`; feature 05 completes the settings and operations documentation after independent review clearance. Its final logic suite passed 408/408 with zero skips; the final UI wording delta passed focused tests and build. Detailed validation, browser evidence, review resolutions, interfaces, and live-service limits are recorded in `docs/google-drive-feature-05.md`. The final feature commit is made locally by PUSHER; no remote push is included in this delivery.

## Decisive acceptance checks

- Restore a valid backup into an empty installation.
- Copy the local archive between installations and back with functional relative references.
- Retry transfers without creating duplicate remote files.
- Resume interrupted transfers after restart.
- Overwrite remote changes with local state after an outage.
- Preserve previous local data when restore or validation fails.
- Preserve original image bytes before web, bulk, and agent AI processing.
- Include all persistent user domains while excluding secrets, tokens, caches, and processing temporary files.
