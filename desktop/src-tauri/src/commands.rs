//! The `#[tauri::command]` surface of the control panel. Only the `control`
//! window may call these (`capabilities/control.json`); the `wardrobe` window
//! is a plain webview with no IPC.
//!
//! No command ever returns a secret value: secrets come back as presence and
//! a four-character hint.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;

use crate::config::{ConfigPatch, DesktopConfig};
use crate::secrets::{self, SecretStatus};
use crate::sidecar::{LogLine, ServerState};
use crate::{windows, AppState};

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

/// Stores a secret (Feature 03: for this session only) and restarts the server.
#[tauri::command]
pub async fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    secrets::set(app.state::<AppState>().secrets.as_ref(), &name, &value)?;
    restart_server(app).await.map(|_| ())
}

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
    /// Feature 03 keeps secrets for the session only; Feature 04 persists them.
    pub secrets_persistent: bool,
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
        secrets_persistent: false,
    }
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
