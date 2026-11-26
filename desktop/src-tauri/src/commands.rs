//! The `#[tauri::command]` surface of the control panel. Only the `control`
//! window may call these (`capabilities/control.json`); the `wardrobe` window
//! is a plain webview with no IPC.
//!
//! No command ever returns a secret value: secrets come back as presence and
//! a four-character hint.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::config::{ConfigPatch, DesktopConfig};
use crate::secrets::{self, SecretStatus};
use crate::sidecar::{self, Health, ImportOutcome, LogLine, ServerState};
use crate::storage::{self, CacheStatus};
use crate::updates::{UpdateManager, UpdateStatus};
use crate::{windows, AppState};

/// The repository the help links point at.
pub const REPO_URL: &str = "https://github.com/davidmarinangeli/wardrobe";

#[tauri::command]
pub fn server_state(state: State<'_, AppState>) -> ServerState {
    state.sidecar.state()
}

/// Restarts the server and resolves once it is running or failed.
#[tauri::command]
pub async fn server_restart(app: AppHandle) -> Result<ServerState, String> {
    restart_server(app).await
}

/// The most recent server log lines (at most 500, the ring buffer size).
#[tauri::command]
pub fn server_logs(state: State<'_, AppState>, limit: Option<usize>) -> Vec<LogLine> {
    state.sidecar.logs().lines(limit)
}

#[tauri::command]
pub async fn open_wardrobe(app: AppHandle) -> Result<(), String> {
    run_on_main(&app, windows::open_wardrobe).await
}

#[tauri::command]
pub fn open_in_browser(app: AppHandle) -> Result<(), String> {
    windows::open_in_browser(&app)
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigView {
    /// The Google Drive redirect URI the server gets (stored, or the port default).
    pub drive_redirect_uri: String,
    /// `http://localhost:<port>/api/google-drive/oauth/callback` for the current port.
    pub default_drive_redirect_uri: String,
    /// What is stored in `config.json` (`None` paths mean the defaults).
    pub config: DesktopConfig,
    /// The data and cache directories the server uses with this config.
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub default_data_dir: PathBuf,
    pub default_cache_dir: PathBuf,
    pub default_port: u16,
    pub config_file: PathBuf,
}

fn config_view(state: &AppState) -> ConfigView {
    let config = state.config();
    ConfigView {
        drive_redirect_uri: config.effective_drive_redirect_uri(),
        default_drive_redirect_uri: crate::config::default_drive_redirect_uri(config.port),
        data_dir: config.effective_data_dir(&state.dirs),
        cache_dir: config.effective_cache_dir(&state.dirs),
        default_data_dir: state.dirs.default_data_dir(),
        default_cache_dir: state.dirs.default_cache_dir(),
        default_port: crate::config::DEFAULT_PORT,
        config_file: state.dirs.store_file(),
        config,
    }
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> ConfigView {
    config_view(&state)
}

/// Applies a partial update, saves it, and restarts the server when a
/// setting it reads changed (port, directories, allowed hosts, overrides,
/// provider). Resolves after the restart.
#[tauri::command]
pub async fn set_config(app: AppHandle, patch: ConfigPatch) -> Result<ConfigView, String> {
    let restart = {
        let state = app.state::<AppState>();
        let current = state.config();
        let (next, restart) = current.apply(patch)?;
        crate::save_config(&app, &next)?;
        state.replace_config(next);
        restart
    };
    if restart {
        restart_server(app.clone()).await?;
    }
    Ok(config_view(&app.state::<AppState>()))
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Turns launch at login on or off and records it in the config.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())?;
    } else {
        launcher.disable().map_err(|e| e.to_string())?;
    }
    let state = app.state::<AppState>();
    let (next, _) = state.config().apply(ConfigPatch {
        launch_at_login: Some(enabled),
        ..Default::default()
    })?;
    crate::save_config(&app, &next)?;
    state.replace_config(next);
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_status(state: State<'_, AppState>) -> BTreeMap<String, SecretStatus> {
    secrets::status(state.secrets.as_ref())
}

/// Stores a secret in the keychain (trimmed; empty or multi-line values and
/// unknown names are rejected) and restarts the server. Returns nothing: the
/// value never comes back.
#[tauri::command]
pub async fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    secrets::set(app.state::<AppState>().secrets.as_ref(), &name, &value)?;
    restart_server(app).await.map(|_| ())
}

/// Removes a secret from the keychain and restarts the server.
#[tauri::command]
pub async fn secret_delete(app: AppHandle, name: String) -> Result<(), String> {
    secrets::delete(app.state::<AppState>().secrets.as_ref(), &name)?;
    restart_server(app).await.map(|_| ())
}

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub identifier: String,
    /// `bundled` (packaged Node sidecar) or `dev` (`node` from PATH, repo server).
    pub sidecar_mode: String,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config_dir: PathBuf,
    pub log_dir: PathBuf,
    pub server_log: PathBuf,
    /// True when a provider key exists (stored secret or inherited environment).
    pub has_provider_key: bool,
    /// True when secrets live in the OS keychain; false for the session-only
    /// store (`WARDROBE_DESKTOP_SECRETS=memory`).
    pub secrets_persistent: bool,
    /// `macos` or `windows` (help text differs, for example the Keychain prompt).
    pub platform: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let state = app.state::<AppState>();
    AppInfo {
        version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        sidecar_mode: state.layout.mode().into(),
        data_dir: state.dirs.data.clone(),
        cache_dir: state.dirs.cache.clone(),
        config_dir: state.dirs.config.clone(),
        log_dir: state.dirs.log.clone(),
        server_log: state.dirs.server_log(),
        has_provider_key: state.has_provider_key(),
        secrets_persistent: state.secrets_persistent,
        platform: std::env::consts::OS.into(),
    }
}

/// `/api/health` of the running server (version, uptime), or `None` when it
/// does not answer.
#[tauri::command]
pub async fn server_health(app: AppHandle) -> Option<Health> {
    let port = app.state::<AppState>().sidecar.state().running_port()?;
    tauri::async_runtime::spawn_blocking(move || {
        sidecar::probe_health(port, Duration::from_millis(1500))
    })
    .await
    .ok()
    .flatten()
}

/// Imports an existing data folder into the data directory (`import-data`
/// through the sidecar binary). The server is stopped meanwhile and started
/// again afterwards. Exit 3 comes back as `targetPopulated`; the panel then
/// offers to call again with `replace: true`.
#[tauri::command]
pub async fn data_import(
    app: AppHandle,
    from: String,
    replace: bool,
) -> Result<ImportOutcome, String> {
    let from = PathBuf::from(from.trim());
    tauri::async_runtime::spawn_blocking(move || crate::import_data(&app, &from, replace))
        .await
        .map_err(|e| e.to_string())?
}

/// Sizes of `<cache>/transformers` and `<cache>/drapes`.
#[tauri::command]
pub async fn cache_status(app: AppHandle) -> Result<CacheStatus, String> {
    let cache = {
        let state = app.state::<AppState>();
        state.config().effective_cache_dir(&state.dirs)
    };
    tauri::async_runtime::spawn_blocking(move || storage::cache_status(&cache))
        .await
        .map_err(|e| e.to_string())
}

/// Deletes the background-removal model cache (`<cache>/transformers`), with
/// the server stopped meanwhile.
#[tauri::command]
pub async fn cache_clear_models(app: AppHandle) -> Result<CacheStatus, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::clear_model_cache(&handle))
        .await
        .map_err(|e| e.to_string())??;
    cache_status(app).await
}

/// A native folder picker, attached to the control window. `None` when the
/// user cancels. The frontend gets no dialog permission of its own.
#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    title: Option<String>,
    start: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window(windows::CONTROL) {
        dialog = dialog.set_parent(&window);
    }
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(start) = start.map(PathBuf::from).filter(|p| p.is_dir()) {
        dialog = dialog.set_directory(start);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    match picked {
        None => Ok(None),
        Some(path) => path
            .into_path()
            .map(|p| Some(p.display().to_string()))
            .map_err(|e| e.to_string()),
    }
}

/// Opens one of the app's own folders in Finder or Explorer: `data`, `cache`,
/// `logs` or `config`. Arbitrary paths are not accepted.
#[tauri::command]
pub fn reveal_location(app: AppHandle, location: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = state.config();
    let path = match location.as_str() {
        "data" => config.effective_data_dir(&state.dirs),
        "cache" => config.effective_cache_dir(&state.dirs),
        "logs" => state.dirs.log.clone(),
        "config" => state.dirs.config.clone(),
        other => return Err(format!("unknown location {other:?}")),
    };
    std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Opens a fixed help page in the default browser: `google-drive` or
/// `releases`.
#[tauri::command]
pub fn open_help(app: AppHandle, topic: String) -> Result<(), String> {
    let url = match topic.as_str() {
        "google-drive" => format!("{REPO_URL}/blob/main/docs/google-drive-operations.md"),
        "releases" => format!("{REPO_URL}/releases"),
        other => return Err(format!("unknown help topic {other:?}")),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The updater state: `{ state: "idle" | "upToDate" | "available" |
/// "downloading" | "ready" | "failed", current, checking, lastChecked,
/// lastFailure, skippedVersion, autoCheck, updatedFrom, ... }`.
#[tauri::command]
pub fn update_state(updates: State<'_, UpdateManager>) -> UpdateStatus {
    updates.status()
}

/// A manual check ("Check for updates" in the panel): a failure becomes the
/// `failed` state. Resolves when the check finishes, or at once with
/// `checking: true` when one is already running.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<UpdateManager>().check(true))
        .await
        .map_err(|e| e.to_string())?
}

/// "Install and restart": downloads and verifies the available update with
/// the server running, stops the server, installs, and restarts the app. On
/// Windows the installer replaces the app and the process exits. A failed
/// download or install comes back as the `failed` state (the server is
/// running again); `Err` means there was nothing to install.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::install_update(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// "Skip this version" with a version, "Stop skipping" with `null`.
#[tauri::command]
pub fn update_skip(
    updates: State<'_, UpdateManager>,
    version: Option<String>,
) -> Result<UpdateStatus, String> {
    updates.skip(version.as_deref())
}

/// The single restart path for commands: rebuilds the launch spec from the
/// current config and secrets, then restarts on a blocking thread.
pub async fn restart_server(app: AppHandle) -> Result<ServerState, String> {
    tauri::async_runtime::spawn_blocking(move || crate::restart_sidecar(&app))
        .await
        .map_err(|e| e.to_string())
}

async fn run_on_main<F>(app: &AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce(&AppHandle) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_else(|e| Err(e.to_string())))
        .await
        .map_err(|e| e.to_string())?
}
