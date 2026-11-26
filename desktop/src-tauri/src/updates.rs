//! In-app updates (Feature 06): checks the GitHub release's `latest.json`
//! with `tauri-plugin-updater`, shows the result in the control panel and the
//! tray, and installs on request (never automatically).
//!
//! The state machine (`UpdateCore`) and the orchestration (`UpdateManager`)
//! know nothing about Tauri: the updater is behind `UpdateBackend` and the
//! server and app lifecycle behind `InstallHost`, so the unit tests drive
//! them with mocked updater responses. `PluginBackend` is the real backend.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// The first automatic check runs this long after launch.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
/// Then one automatic check every six hours while the app runs.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// `on` or `off` forces the automatic checks; by default they run in release
/// builds only (a `tauri dev` build would offer to replace itself).
pub const AUTO_CHECK_ENV: &str = "WARDROBE_DESKTOP_UPDATE_CHECKS";

/// `config.json` keys owned by the updater (not part of `DesktopConfig`).
pub const STORE_LAST_CHECK: &str = "update_last_check";
pub const STORE_SKIPPED: &str = "update_skipped_version";
/// Written right before an install, read and removed at the next launch.
pub const STORE_INSTALLED_FROM: &str = "update_installed_from";

/// Network timeouts for the check and the download. A per-read timeout (not
/// a total one) so a large download on a slow link still completes, while a
/// dropped connection fails within half a minute.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// At most one `Downloading` event per interval.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// A newer release announced by `latest.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundUpdate {
    pub version: String,
    /// `pub_date` as written in `latest.json` (RFC 3339).
    pub date: Option<String>,
    /// The GitHub release body (Markdown).
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateState {
    /// No check has finished since launch.
    Idle,
    UpToDate,
    Available {
        version: String,
        date: Option<String>,
        notes: Option<String>,
        /// The user chose "Skip this version": no tray nagging.
        skipped: bool,
    },
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified; the server is stopping and the app restarts.
    Ready {
        version: String,
    },
    Failed {
        reason: String,
        /// The version an install failed for; `None` for a failed manual check.
        version: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFailure {
    /// Unix seconds.
    pub at: u64,
    pub reason: String,
}

/// What `update_state()` returns and the `update-state` event carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    #[serde(flatten)]
    pub state: UpdateState,
    /// The running app version.
    pub current: String,
    /// A check is running (automatic or manual).
    pub checking: bool,
    /// Unix seconds of the last successful check (kept in `config.json`).
    pub last_checked: Option<u64>,
    /// The last failed check, when it is newer than the last successful one.
    pub last_failure: Option<CheckFailure>,
    pub skipped_version: Option<String>,
    /// Automatic checks are on (release builds, or `WARDROBE_DESKTOP_UPDATE_CHECKS=on`).
    pub auto_check: bool,
    /// Set at the first launch after an update: the version updated from.
    pub updated_from: Option<String>,
}

/// The updater values kept in `config.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Persisted {
    pub last_checked: Option<u64>,
    pub skipped_version: Option<String>,
}

/// "v0.1.1", " 0.1.1 " and "0.1.1" are the same version; empty is none.
pub fn normalize_version(version: &str) -> Option<String> {
    let trimmed = version.trim();
    let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed).trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The pure state machine. Every method is a transition; `UpdateManager`
/// adds the backend calls, persistence and events around it.
#[derive(Debug, Clone)]
pub struct UpdateCore {
    current: String,
    state: UpdateState,
    checking: bool,
    /// A manual check is waiting for the running check: its failure is shown.
    manual_waiting: bool,
    last_checked: Option<u64>,
    last_failure: Option<CheckFailure>,
    skipped: Option<String>,
    auto_check: bool,
    updated_from: Option<String>,
}

impl UpdateCore {
    pub fn new(current: impl Into<String>, persisted: Persisted, auto_check: bool) -> Self {
        Self {
            current: current.into(),
            state: UpdateState::Idle,
            checking: false,
            manual_waiting: false,
            last_checked: persisted.last_checked,
            last_failure: None,
            skipped: persisted
                .skipped_version
                .as_deref()
                .and_then(normalize_version),
            auto_check,
            updated_from: None,
        }
    }

    pub fn set_updated_from(&mut self, version: Option<String>) {
        self.updated_from = version;
    }

    pub fn state(&self) -> &UpdateState {
        &self.state
    }

    pub fn status(&self) -> UpdateStatus {
        UpdateStatus {
            state: self.state.clone(),
            current: self.current.clone(),
            checking: self.checking,
            last_checked: self.last_checked,
            last_failure: self.last_failure.clone(),
            skipped_version: self.skipped.clone(),
            auto_check: self.auto_check,
            updated_from: self.updated_from.clone(),
        }
    }

    pub fn persisted(&self) -> Persisted {
        Persisted {
            last_checked: self.last_checked,
            skipped_version: self.skipped.clone(),
        }
    }

    fn installing(&self) -> bool {
        matches!(
            self.state,
            UpdateState::Downloading { .. } | UpdateState::Ready { .. }
        )
    }

    /// Starts a check. `Ok(false)` when one is already running: a manual
    /// request then joins it, and its failure will be shown.
    pub fn begin_check(&mut self, manual: bool) -> Result<bool, String> {
        if self.installing() {
            return Err("An update is being installed.".into());
        }
        if self.checking {
            self.manual_waiting |= manual;
            return Ok(false);
        }
        self.checking = true;
        self.manual_waiting = manual;
        Ok(true)
    }

    /// Records a check result. A failed automatic check only updates the
    /// last-check line; a failed manual check becomes `Failed`.
    pub fn finish_check(&mut self, result: Result<Option<FoundUpdate>, String>, now: u64) {
        let manual = std::mem::take(&mut self.manual_waiting);
        self.checking = false;
        match result {
            Ok(None) => {
                self.state = UpdateState::UpToDate;
                self.last_checked = Some(now);
                self.last_failure = None;
            }
            Ok(Some(found)) => {
                let skipped = self.skipped.as_deref() == Some(found.version.as_str());
                self.state = UpdateState::Available {
                    version: found.version,
                    date: found.date,
                    notes: found.notes,
                    skipped,
                };
                self.last_checked = Some(now);
                self.last_failure = None;
            }
            Err(reason) => {
                self.last_failure = Some(CheckFailure {
                    at: now,
                    reason: reason.clone(),
                });
                if manual {
                    self.state = UpdateState::Failed {
                        reason,
                        version: None,
                    };
                }
            }
        }
    }

    /// Stores (or with `None`, clears) the skipped version.
    pub fn skip(&mut self, version: Option<&str>) -> Result<(), String> {
        if self.installing() {
            return Err("An update is being installed.".into());
        }
        self.skipped = version.and_then(normalize_version);
        if let UpdateState::Available {
            version, skipped, ..
        } = &mut self.state
        {
            *skipped = self.skipped.as_deref() == Some(version.as_str());
        }
        Ok(())
    }

    /// `Available` → `Downloading`. Returns the version to install.
    pub fn begin_install(&mut self) -> Result<String, String> {
        if self.checking {
            return Err("A check for updates is running. Try again in a moment.".into());
        }
        match &self.state {
            UpdateState::Available { version, .. } => {
                let version = version.clone();
                self.state = UpdateState::Downloading {
                    version: version.clone(),
                    received: 0,
                    total: None,
                };
                Ok(version)
            }
            UpdateState::Downloading { .. } | UpdateState::Ready { .. } => {
                Err("The update is already being installed.".into())
            }
            _ => Err("No update is available. Check for updates first.".into()),
        }
    }

    pub fn progress(&mut self, chunk: u64, content_length: Option<u64>) {
        if let UpdateState::Downloading {
            received, total, ..
        } = &mut self.state
        {
            *received = received.saturating_add(chunk);
            if content_length.is_some() {
                *total = content_length;
            }
        }
    }

    /// `Downloading` → `Ready`.
    pub fn downloaded(&mut self) {
        if let UpdateState::Downloading { version, .. } = &self.state {
            self.state = UpdateState::Ready {
                version: version.clone(),
            };
        }
    }

    /// Any install step failed: `Failed` with the version it was for.
    pub fn fail_install(&mut self, reason: impl Into<String>) {
        let version = match &self.state {
            UpdateState::Downloading { version, .. }
            | UpdateState::Ready { version }
            | UpdateState::Available { version, .. } => Some(version.clone()),
            _ => None,
        };
        self.state = UpdateState::Failed {
            reason: reason.into(),
            version,
        };
    }
}

/// The tray item for a status: its text and whether it is enabled.
pub fn tray_item(status: &UpdateStatus) -> (String, bool) {
    match &status.state {
        UpdateState::Available {
            version,
            skipped: false,
            ..
        } => (format!("Update to v{version}…"), true),
        UpdateState::Downloading {
            received, total, ..
        } => match total.filter(|t| *t > 0) {
            Some(total) => (
                format!(
                    "Downloading update… {}%",
                    (received.saturating_mul(100) / total).min(100)
                ),
                false,
            ),
            None => ("Downloading update…".into(), false),
        },
        UpdateState::Ready { .. } => ("Installing update…".into(), false),
        _ if status.checking => ("Checking for updates…".into(), false),
        _ => ("Check for updates…".into(), true),
    }
}

/// The updater itself. Blocking calls; `PluginBackend` wraps the plugin.
pub trait UpdateBackend: Send + Sync {
    /// Fetches `latest.json`. `Some` only for a newer version; the backend
    /// keeps it for `download`.
    fn check(&self) -> Result<Option<FoundUpdate>, String>;
    /// Downloads and verifies the update found by the last check, reporting
    /// `(chunk bytes, content length)`. The backend keeps the bytes.
    fn download(
        &self,
        version: &str,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), String>;
    /// Installs the downloaded update. On Windows this launches the NSIS
    /// installer and exits the process; on macOS it replaces the bundle and
    /// returns.
    fn install(&self) -> Result<(), String>;
}

/// The app around an install.
pub trait InstallHost {
    /// Stops the server (so no bundle file is in use), runs `install`, and
    /// starts the server again when `install` fails.
    fn install_with_server_stopped(
        &self,
        install: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String>;
    /// Restarts the app into the new version.
    fn restart_app(&self);
}

pub type UpdateListener = Arc<dyn Fn(&UpdateStatus) + Send + Sync>;
pub type Persist = Box<dyn Fn(&Persisted) + Send + Sync>;
pub type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub struct UpdateManager {
    core: Mutex<UpdateCore>,
    backend: Box<dyn UpdateBackend>,
    listener: Mutex<Option<UpdateListener>>,
    persist: Persist,
    clock: Clock,
}

impl UpdateManager {
    pub fn new(core: UpdateCore, backend: Box<dyn UpdateBackend>, persist: Persist) -> Self {
        Self::with_clock(core, backend, persist, Box::new(unix_now))
    }

    pub fn with_clock(
        core: UpdateCore,
        backend: Box<dyn UpdateBackend>,
        persist: Persist,
        clock: Clock,
    ) -> Self {
        Self {
            core: Mutex::new(core),
            backend,
            listener: Mutex::new(None),
            persist,
            clock,
        }
    }

    fn core(&self) -> MutexGuard<'_, UpdateCore> {
        self.core.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Called with every new status (the `update-state` event and the tray).
    pub fn set_listener(&self, listener: UpdateListener) {
        *self.listener.lock().unwrap_or_else(|p| p.into_inner()) = Some(listener);
    }

    pub fn status(&self) -> UpdateStatus {
        self.core().status()
    }

    pub fn auto_check(&self) -> bool {
        self.core().auto_check
    }

    fn emit(&self, status: &UpdateStatus) {
        let listener = self
            .listener
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(listener) = listener {
            listener(status);
        }
    }

    fn emit_current(&self) -> UpdateStatus {
        let status = self.status();
        self.emit(&status);
        status
    }

    /// Checks for an update (blocking). `manual` is the tray item or the
    /// panel button: its failure becomes `Failed`. Returns at once with
    /// `checking: true` when a check is already running.
    pub fn check(&self, manual: bool) -> Result<UpdateStatus, String> {
        if !self.core().begin_check(manual)? {
            return Ok(self.status());
        }
        self.emit_current();
        let result = self.backend.check();
        if let Err(reason) = &result {
            if manual {
                log::warn!("update check failed: {reason}");
            } else {
                log::info!("automatic update check failed: {reason}");
            }
        }
        let now = (self.clock)();
        let persisted = {
            let mut core = self.core();
            core.finish_check(result, now);
            core.persisted()
        };
        (self.persist)(&persisted);
        Ok(self.emit_current())
    }

    /// "Skip this version" (`Some`) or "Stop skipping" (`None`).
    pub fn skip(&self, version: Option<&str>) -> Result<UpdateStatus, String> {
        let persisted = {
            let mut core = self.core();
            core.skip(version)?;
            core.persisted()
        };
        (self.persist)(&persisted);
        Ok(self.emit_current())
    }

    /// Downloads the available update with the server still running, then
    /// stops the server, installs, and restarts the app (blocking). A failed
    /// download leaves the server untouched; a failed install starts it
    /// again. Both end in `Failed`, returned as `Ok`: only a refused request
    /// (nothing available, already busy) is an `Err`.
    pub fn install(&self, host: &dyn InstallHost) -> Result<UpdateStatus, String> {
        let version = self.core().begin_install()?;
        log::info!("downloading update {version}");
        self.emit_current();

        let mut last_emit: Option<Instant> = None;
        let downloaded = self.backend.download(&version, &mut |chunk, total| {
            let status = {
                let mut core = self.core();
                core.progress(chunk, total);
                core.status()
            };
            if last_emit.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
                last_emit = Some(Instant::now());
                self.emit(&status);
            }
        });
        if let Err(reason) = downloaded {
            log::warn!("update download failed: {reason}");
            self.core()
                .fail_install(format!("The download failed: {reason}"));
            return Ok(self.emit_current());
        }

        self.core().downloaded();
        self.emit_current();
        log::info!("installing update {version}");
        match host.install_with_server_stopped(&mut || self.backend.install()) {
            Ok(()) => {
                log::info!("update {version} installed, restarting");
                host.restart_app();
                Ok(self.status())
            }
            Err(reason) => {
                log::warn!("update install failed: {reason}");
                self.core()
                    .fail_install(format!("The update could not be installed: {reason}"));
                Ok(self.emit_current())
            }
        }
    }
}

/// Whether automatic checks run: `WARDROBE_DESKTOP_UPDATE_CHECKS` when set to
/// on/off, otherwise release builds only.
pub fn auto_check_enabled(env_value: Option<&str>, release_build: bool) -> bool {
    match env_value.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "on" | "1" | "true" | "yes") => true,
        Some(v) if matches!(v.as_str(), "off" | "0" | "false" | "no") => false,
        _ => release_build,
    }
}

/// Removes the folders the plugin downloads Windows installers into
/// (`<temp>/<product>-<version>-updater-XXXXXX`). The plugin creates them with
/// `tempdir().keep()` and exits the process right after launching the
/// installer, so nothing ever deletes them. Called at launch; a folder still
/// in use (the installer finishing) fails quietly and goes at a later launch.
/// Returns the folders removed.
pub fn remove_stale_installers(
    temp_dir: &std::path::Path,
    product: &str,
) -> Vec<std::path::PathBuf> {
    let prefix = format!("{product}-");
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix(&prefix)
                .and_then(|rest| rest.split_once("-updater-"))
                .is_some_and(|(version, _)| !version.is_empty())
        })
        .map(|entry| entry.path())
        .filter(|path| std::fs::remove_dir_all(path).is_ok())
        .collect()
}

/// The plugin's error, in words the panel can show.
fn describe(error: tauri_plugin_updater::Error) -> String {
    match error {
        tauri_plugin_updater::Error::ReleaseNotFound => {
            "No release information was found at the update server.".into()
        }
        // reqwest's own words ("error decoding response body") hide a lost
        // or stalled connection.
        tauri_plugin_updater::Error::Reqwest(error) if error.is_timeout() => {
            format!("The connection timed out ({error})")
        }
        tauri_plugin_updater::Error::Reqwest(error) if error.is_connect() => {
            format!("The update server could not be reached ({error})")
        }
        tauri_plugin_updater::Error::Reqwest(error) if error.is_body() || error.is_decode() => {
            format!("The connection was lost during the download ({error})")
        }
        other => other.to_string(),
    }
}

/// `tauri-plugin-updater` against the endpoints and public key in
/// `tauri.conf.json` (`plugins.updater`).
pub struct PluginBackend {
    app: AppHandle,
    pending: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

impl PluginBackend {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Mutex::new(None),
            bytes: Mutex::new(None),
        }
    }

    fn pubkey_configured(&self) -> bool {
        self.app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|updater| updater.get("pubkey"))
            .and_then(|key| key.as_str())
            .is_some_and(|key| !key.trim().is_empty())
    }

    fn pending(&self) -> Option<Update> {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl UpdateBackend for PluginBackend {
    fn check(&self) -> Result<Option<FoundUpdate>, String> {
        let updater = self
            .app
            .updater_builder()
            .configure_client(|client| {
                client
                    .connect_timeout(CONNECT_TIMEOUT)
                    .read_timeout(READ_TIMEOUT)
            })
            .build()
            .map_err(describe)?;
        let found = tauri::async_runtime::block_on(updater.check()).map_err(describe)?;
        *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let info = found.as_ref().map(|update| FoundUpdate {
            version: update.version.clone(),
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|date| date.as_str())
                .map(str::to_string),
            notes: update.body.clone().filter(|body| !body.trim().is_empty()),
        });
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = found;
        Ok(info)
    }

    fn download(
        &self,
        version: &str,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), String> {
        if !self.pubkey_configured() {
            return Err("This build has no updater public key, so the update cannot be verified. Download the new version from the release page instead.".into());
        }
        let update = self
            .pending()
            .filter(|update| update.version == version)
            .ok_or("The update is no longer available. Check for updates again.")?;
        let bytes = tauri::async_runtime::block_on(
            update.download(|chunk, total| progress(chunk as u64, total), || {}),
        )
        .map_err(describe)?;
        *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = Some(bytes);
        Ok(())
    }

    fn install(&self) -> Result<(), String> {
        let update = self
            .pending()
            .ok_or("The update is no longer available. Check for updates again.")?;
        let bytes = self
            .bytes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .ok_or("The update was not downloaded")?;
        update.install(bytes).map_err(describe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn found(version: &str) -> FoundUpdate {
        FoundUpdate {
            version: version.into(),
            date: Some("2026-11-27T10:00:00Z".into()),
            notes: Some("## Changes\n- A visible change".into()),
        }
    }

    /// A scripted updater: each check pops the next response.
    #[derive(Default)]
    struct MockBackend {
        checks: Mutex<VecDeque<Result<Option<FoundUpdate>, String>>>,
        download: Mutex<Option<Result<(), String>>>,
        install: Mutex<Option<Result<(), String>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl MockBackend {
        fn with_checks(checks: Vec<Result<Option<FoundUpdate>, String>>) -> Self {
            Self {
                checks: Mutex::new(checks.into()),
                ..Default::default()
            }
        }
    }

    impl UpdateBackend for MockBackend {
        fn check(&self) -> Result<Option<FoundUpdate>, String> {
            self.calls.lock().unwrap().push("check".into());
            self.checks.lock().unwrap().pop_front().unwrap_or(Ok(None))
        }
        fn download(
            &self,
            version: &str,
            progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("download {version}"));
            progress(40, Some(100));
            let result = self.download.lock().unwrap().take().unwrap_or(Ok(()));
            if result.is_ok() {
                progress(60, Some(100));
            }
            result
        }
        fn install(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("install".into());
            self.install.lock().unwrap().take().unwrap_or(Ok(()))
        }
    }

    /// Records the server and app lifecycle around an install.
    struct MockHost {
        calls: Arc<Mutex<Vec<String>>>,
        server_running: RefCell<bool>,
    }

    impl MockHost {
        fn new(calls: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                calls,
                server_running: RefCell::new(true),
            }
        }
    }

    impl InstallHost for MockHost {
        fn install_with_server_stopped(
            &self,
            install: &mut dyn FnMut() -> Result<(), String>,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push("stop server".into());
            *self.server_running.borrow_mut() = false;
            let result = install();
            if result.is_err() {
                self.calls.lock().unwrap().push("start server".into());
                *self.server_running.borrow_mut() = true;
            }
            result
        }
        fn restart_app(&self) {
            self.calls.lock().unwrap().push("restart app".into());
        }
    }

    struct Harness {
        manager: UpdateManager,
        calls: Arc<Mutex<Vec<String>>>,
        persisted: Arc<Mutex<Vec<Persisted>>>,
        events: Arc<Mutex<Vec<UpdateStatus>>>,
    }

    fn harness(backend: MockBackend, persisted: Persisted) -> Harness {
        let calls = backend.calls.clone();
        let saved = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let saved_in = saved.clone();
        let manager = UpdateManager::with_clock(
            UpdateCore::new("0.1.0", persisted, true),
            Box::new(backend),
            Box::new(move |p: &Persisted| saved_in.lock().unwrap().push(p.clone())),
            Box::new(|| 1_000),
        );
        let events_in = events.clone();
        manager.set_listener(Arc::new(move |s: &UpdateStatus| {
            events_in.lock().unwrap().push(s.clone())
        }));
        Harness {
            manager,
            calls,
            persisted: saved,
            events,
        }
    }

    #[test]
    fn up_to_date_and_available() {
        let h = harness(
            MockBackend::with_checks(vec![Ok(None), Ok(Some(found("0.1.1")))]),
            Persisted::default(),
        );
        assert_eq!(h.manager.status().state, UpdateState::Idle);

        let status = h.manager.check(false).unwrap();
        assert_eq!(status.state, UpdateState::UpToDate);
        assert_eq!(status.last_checked, Some(1_000));
        assert!(!status.checking);
        assert_eq!(
            h.persisted.lock().unwrap().last().unwrap().last_checked,
            Some(1_000)
        );

        let status = h.manager.check(false).unwrap();
        assert_eq!(
            status.state,
            UpdateState::Available {
                version: "0.1.1".into(),
                date: Some("2026-11-27T10:00:00Z".into()),
                notes: Some("## Changes\n- A visible change".into()),
                skipped: false,
            }
        );
        assert_eq!(tray_item(&status), ("Update to v0.1.1…".into(), true));
        // The event stream shows the check running, then the result.
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| e.checking));
        assert_eq!(events.last().unwrap(), &status);
    }

    #[test]
    fn status_serializes_flat_and_camel_case() {
        let mut core = UpdateCore::new("0.1.0", Persisted::default(), true);
        core.finish_check(Ok(Some(found("0.1.1"))), 5);
        let json = serde_json::to_value(core.status()).unwrap();
        assert_eq!(json["state"], "available");
        assert_eq!(json["version"], "0.1.1");
        assert_eq!(json["current"], "0.1.0");
        assert_eq!(json["lastChecked"], 5);
        assert_eq!(json["skipped"], false);
        assert_eq!(json["autoCheck"], true);
        core.finish_check(Ok(None), 6);
        assert_eq!(
            serde_json::to_value(core.status()).unwrap()["state"],
            "upToDate"
        );
    }

    #[test]
    fn automatic_check_failures_are_silent_manual_ones_are_not() {
        let h = harness(
            MockBackend::with_checks(vec![
                Ok(Some(found("0.1.1"))),
                Err("network down".into()),
                Err("network down".into()),
            ]),
            Persisted::default(),
        );
        h.manager.check(false).unwrap();
        let status = h.manager.check(false).unwrap();
        // The automatic failure keeps the offer and only fills the last-check line.
        assert!(matches!(status.state, UpdateState::Available { .. }));
        assert_eq!(
            status.last_failure,
            Some(CheckFailure {
                at: 1_000,
                reason: "network down".into()
            })
        );
        assert_eq!(status.last_checked, Some(1_000));

        let status = h.manager.check(true).unwrap();
        assert_eq!(
            status.state,
            UpdateState::Failed {
                reason: "network down".into(),
                version: None
            }
        );
    }

    #[test]
    fn a_successful_check_clears_the_last_failure() {
        let mut core = UpdateCore::new("0.1.0", Persisted::default(), true);
        assert!(core.begin_check(false).unwrap());
        core.finish_check(Err("offline".into()), 10);
        assert_eq!(core.status().state, UpdateState::Idle);
        assert!(core.status().last_failure.is_some());
        assert!(core.begin_check(false).unwrap());
        core.finish_check(Ok(None), 20);
        assert_eq!(core.status().last_failure, None);
        assert_eq!(core.status().last_checked, Some(20));
    }

    #[test]
    fn a_manual_check_joins_a_running_one_and_sees_its_failure() {
        let mut core = UpdateCore::new("0.1.0", Persisted::default(), true);
        assert!(core.begin_check(false).unwrap());
        assert!(core.status().checking);
        assert_eq!(
            tray_item(&core.status()),
            ("Checking for updates…".into(), false)
        );
        assert!(!core.begin_check(true).unwrap());
        core.finish_check(Err("timeout".into()), 30);
        assert!(matches!(core.status().state, UpdateState::Failed { .. }));
        assert!(!core.status().checking);
    }

    #[test]
    fn skipped_version_is_not_nagged_until_a_newer_one_exists() {
        let h = harness(
            MockBackend::with_checks(vec![
                Ok(Some(found("0.1.1"))),
                Ok(Some(found("0.1.1"))),
                Ok(Some(found("0.1.2"))),
            ]),
            Persisted::default(),
        );
        h.manager.check(false).unwrap();
        let status = h.manager.skip(Some("v0.1.1")).unwrap();
        assert_eq!(status.skipped_version.as_deref(), Some("0.1.1"));
        assert!(matches!(
            status.state,
            UpdateState::Available { skipped: true, .. }
        ));
        assert_eq!(tray_item(&status), ("Check for updates…".into(), true));
        assert_eq!(
            h.persisted.lock().unwrap().last().unwrap().skipped_version,
            Some("0.1.1".into())
        );

        // The next launch reads the skipped version back from config.json.
        let persisted = h.persisted.lock().unwrap().last().unwrap().clone();
        let h2 = harness(
            MockBackend::with_checks(vec![Ok(Some(found("0.1.1"))), Ok(Some(found("0.1.2")))]),
            persisted,
        );
        let status = h2.manager.check(false).unwrap();
        assert!(matches!(
            status.state,
            UpdateState::Available { skipped: true, .. }
        ));
        assert_eq!(tray_item(&status).0, "Check for updates…");

        let status = h2.manager.check(false).unwrap();
        assert!(matches!(
            &status.state,
            UpdateState::Available { version, skipped: false, .. } if version == "0.1.2"
        ));
        assert_eq!(tray_item(&status).0, "Update to v0.1.2…");
    }

    #[test]
    fn stop_skipping_offers_the_version_again() {
        let mut core = UpdateCore::new(
            "0.1.0",
            Persisted {
                last_checked: None,
                skipped_version: Some("0.1.1".into()),
            },
            true,
        );
        core.finish_check(Ok(Some(found("0.1.1"))), 1);
        assert!(matches!(
            core.state(),
            UpdateState::Available { skipped: true, .. }
        ));
        core.skip(None).unwrap();
        assert!(matches!(
            core.state(),
            UpdateState::Available { skipped: false, .. }
        ));
        assert_eq!(core.persisted().skipped_version, None);
        core.skip(Some("  ")).unwrap();
        assert_eq!(core.persisted().skipped_version, None);
    }

    #[test]
    fn install_downloads_first_then_stops_the_server_and_restarts() {
        let h = harness(
            MockBackend::with_checks(vec![Ok(Some(found("0.1.1")))]),
            Persisted::default(),
        );
        h.manager.check(true).unwrap();
        let host = MockHost::new(h.calls.clone());
        let status = h.manager.install(&host).unwrap();
        assert_eq!(
            status.state,
            UpdateState::Ready {
                version: "0.1.1".into()
            }
        );
        assert_eq!(
            *h.calls.lock().unwrap(),
            vec![
                "check",
                "download 0.1.1",
                "stop server",
                "install",
                "restart app"
            ]
        );
        assert!(!*host.server_running.borrow());
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(
            e.state,
            UpdateState::Downloading {
                received: 40,
                total: Some(100),
                ..
            }
        )));
        assert!(events
            .iter()
            .any(|e| matches!(e.state, UpdateState::Ready { .. })));
    }

    #[test]
    fn a_failed_download_leaves_the_server_running() {
        let backend = MockBackend::with_checks(vec![Ok(Some(found("0.1.1")))]);
        *backend.download.lock().unwrap() = Some(Err("connection reset".into()));
        let h = harness(backend, Persisted::default());
        h.manager.check(true).unwrap();
        let host = MockHost::new(h.calls.clone());
        let status = h.manager.install(&host).unwrap();
        assert_eq!(
            status.state,
            UpdateState::Failed {
                reason: "The download failed: connection reset".into(),
                version: Some("0.1.1".into())
            }
        );
        assert_eq!(*h.calls.lock().unwrap(), vec!["check", "download 0.1.1"]);
        assert!(*host.server_running.borrow());
        // A new check offers the update again.
        h.manager.check(true).unwrap();
    }

    #[test]
    fn a_failed_install_starts_the_server_again() {
        let backend = MockBackend::with_checks(vec![Ok(Some(found("0.1.1")))]);
        *backend.install.lock().unwrap() = Some(Err("access denied".into()));
        let h = harness(backend, Persisted::default());
        h.manager.check(true).unwrap();
        let host = MockHost::new(h.calls.clone());
        let status = h.manager.install(&host).unwrap();
        assert_eq!(
            status.state,
            UpdateState::Failed {
                reason: "The update could not be installed: access denied".into(),
                version: Some("0.1.1".into())
            }
        );
        assert_eq!(
            *h.calls.lock().unwrap(),
            vec![
                "check",
                "download 0.1.1",
                "stop server",
                "install",
                "start server"
            ]
        );
        assert!(*host.server_running.borrow());
    }

    #[test]
    fn install_and_check_refuse_when_they_do_not_apply() {
        let mut core = UpdateCore::new("0.1.0", Persisted::default(), true);
        assert!(core.begin_install().is_err());
        core.finish_check(Ok(None), 1);
        assert!(core.begin_install().is_err());
        core.finish_check(Ok(Some(found("0.1.1"))), 2);
        assert!(core.begin_check(false).unwrap());
        assert!(core.begin_install().is_err(), "no install while checking");
        core.finish_check(Ok(Some(found("0.1.1"))), 3);
        assert_eq!(core.begin_install().unwrap(), "0.1.1");
        assert!(core.begin_install().is_err(), "already installing");
        assert!(core.begin_check(true).is_err(), "no check while installing");
        assert!(core.skip(Some("0.1.1")).is_err());
        core.progress(10, Some(1000));
        core.progress(490, None);
        assert_eq!(
            core.state(),
            &UpdateState::Downloading {
                version: "0.1.1".into(),
                received: 500,
                total: Some(1000)
            }
        );
        assert_eq!(
            tray_item(&core.status()),
            ("Downloading update… 50%".into(), false)
        );
        core.downloaded();
        assert_eq!(
            tray_item(&core.status()),
            ("Installing update…".into(), false)
        );
    }

    #[test]
    fn stale_installer_folders_are_removed_and_nothing_else() {
        let temp = tempfile::tempdir().unwrap();
        let stale = temp.path().join("Wardrobe-1.0.1-updater-OONtgO");
        std::fs::create_dir(&stale).unwrap();
        std::fs::write(stale.join("Wardrobe-1.0.1-installer.exe"), b"x").unwrap();
        for keep in [
            "Wardrobe-notes",
            "Other-1.0.1-updater-abc",
            "Wardrobe--updater-x",
        ] {
            std::fs::create_dir(temp.path().join(keep)).unwrap();
        }
        std::fs::write(temp.path().join("Wardrobe-1.0.2-updater-file"), b"a file").unwrap();
        assert_eq!(
            remove_stale_installers(temp.path(), "Wardrobe"),
            vec![stale.clone()]
        );
        assert!(!stale.exists());
        for keep in [
            "Wardrobe-notes",
            "Other-1.0.1-updater-abc",
            "Wardrobe--updater-x",
            "Wardrobe-1.0.2-updater-file",
        ] {
            assert!(temp.path().join(keep).exists(), "{keep} must stay");
        }
        assert!(remove_stale_installers(&temp.path().join("missing"), "Wardrobe").is_empty());
    }

    #[test]
    fn versions_and_auto_check_switch() {
        assert_eq!(normalize_version(" v0.1.1 "), Some("0.1.1".into()));
        assert_eq!(normalize_version("0.1.1"), Some("0.1.1".into()));
        assert_eq!(normalize_version("v"), None);
        assert!(auto_check_enabled(None, true));
        assert!(!auto_check_enabled(None, false));
        assert!(auto_check_enabled(Some("on"), false));
        assert!(!auto_check_enabled(Some("OFF"), true));
        assert!(auto_check_enabled(Some("maybe"), true));
    }
}
