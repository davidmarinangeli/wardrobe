# Settings and Google Drive on mobile

The gear opens the same **Settings** modal on every screen size, with the same two tabs (**AI**, **Archive**). Below the 860px breakpoint nothing is mobile-specific in code: the modal reuses the setup wizard's shell (`onboarding-overlay` / `onboarding-entry` / `.onboarding`), and that shell already turns into the app's shared bottom sheet on a phone.

## How it behaves on a phone

- **Entry point:** the gear in the large-title row (`MobileHeadRow`) calls the same `openSettings` as the desktop top bar, and carries the same Gemini TEST/PROD badge.
- **Presentation:** a bottom sheet up to 92dvh tall that scrolls internally. Swipe-down closes it, except while a Drive activation/restore preview is open (the swipe is disabled so a decision is never dismissed by accident) or while a Drive action is running (close is disabled).
- **Tabs:** the same tab bar as desktop. Archive is greyed out until the four `GOOGLE_DRIVE_*` values are in `.env`; tapping it shows what to configure.
- **OAuth return:** after Google's consent screen the app reloads with `?googleDrive=…` and opens Settings on the Archive tab, as on desktop.
- **Offline notice:** rendered by `SettingsModal` even while it is closed, pinned to the top of the viewport (`.drive-offline-notice`, 8px from the top under 860px).

## Wiring

| Piece | File |
| --- | --- |
| Modal, tabs, Escape/close gate, offline notice | `src/settings-modal.jsx`, `src/settings-modal.css` |
| Drive controller hook and Archive tab body | `src/google-drive-storage.jsx` (`useGoogleDriveStorage`, `ArchiveSettings`) |
| AI tab body | `src/onboarding.jsx` (`AiSettings`) |
| Mobile gear | `src/components/MobileHeader.jsx` |
| Sheet styles | `src/onboarding.css` (`@media (max-width: 860px)`) |

## Not done yet

- **No device pass:** the layout has only been checked through the shared sheet CSS, not on a real phone. Check the Archive tab first: it is the longest content, and the account/action rows were sized for the old 610px drawer.
- **Narrow tab bar:** fine with two short labels; revisit if a third tab is added.
- **Sheet height:** the old Drive sheet allowed 94dvh. The shared sheet allows 92dvh. If the Archive tab feels cramped, override `.settings-entry` / `.settings-panel` in the mobile media query instead of changing the shared wizard sheet.
