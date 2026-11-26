//! Wardrobe desktop shell: runs the Wardrobe server as a Node sidecar, shows
//! the web app in the `wardrobe` window, the control panel in the `control`
//! window, and lives in the tray or menu bar.

pub mod commands;
pub mod config;
pub mod secrets;
pub mod sidecar;
pub mod storage;
pub mod windows;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;
use tauri_plugin_window_state::StateFlags;

use config::{AppDirs, DesktopConfig, OpenTarget};
use secrets::{KeyringSecretStore, MemorySecretStore, SecretStore};
use sidecar::{
    ImportOutcome, LaunchInputs, LaunchSpec, LogBuffer, ServerLayout, ServerState, SidecarManager,
    Timing,
};

/// Passed by the autostart entry: start in the tray without opening a window.
pub const HIDDEN_ARG: &str = "--hidden";
/// Debug builds only: `bundled` runs the packaged sidecar from the resource
/// directory instead of `node` + the repo's `scripts/server.mjs`.
pub const SIDECAR_ENV: &str = "WARDROBE_DESKTOP_SIDECAR";
/// Debug builds only: the Node binary for the dev sidecar (default `node` from PATH).
pub const DEV_NODE_ENV: &str = "WARDROBE_DESKTOP_NODE";

pub struct AppState {
    pub sidecar: SidecarManager,
    pub dirs: AppDirs,
    pub layout: ServerLayout,
    pub secrets: Box<dyn SecretStore>,
    /// True for the OS keychain, false for the session-only memory store.
    pub secrets_persistent: bool,
    config: Mutex<DesktopConfig>,
    /// Serializes server lifecycle operations (start, restart, stop-run-start),
    /// so a restart requested meanwhile (a key, a setting, the Restart button)
    /// cannot start the server in the middle of an import or a cache clear.
    lifecycle: Mutex<()>,
    /// Open the Wardrobe window the first time the server is ready (cleared once used).
    auto_open_wardrobe: AtomicBool,
}

impl AppState {
    pub fn config(&self) -> DesktopConfig {
        self.config
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn replace_config(&self, config: DesktopConfig) {
        *self.config.lock().unwrap_or_else(|p| p.into_inner()) = config;
    }

    /// A key for some AI provider exists: in the secret store, or inherited
    /// from the environment the app was started with.
    pub fn has_provider_key(&self) -> bool {
        let stored = secrets::present(self.secrets.as_ref())
            .iter()
            .any(|(name, _)| secrets::PROVIDER_KEY_NAMES.contains(&name.as_str()));
        stored
            || secrets::PROVIDER_KEY_NAMES.iter().any(|name| {
                std::env::var(name)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
            })
    }

    pub fn launch_spec(&self) -> LaunchSpec {
        let config = self.config();
        let data_dir = config.effective_data_dir(&self.dirs);
        let cache_dir = config.effective_cache_dir(&self.dirs);
        sidecar::build_launch(LaunchInputs {
            layout: &self.layout,
            config: &config,
            data_dir: &data_dir,
            cache_dir: &cache_dir,
            cwd: &self.dirs.data,
            inherited_env: std::env::vars().collect(),
            secrets: secrets::present(self.secrets.as_ref()),
        })
    }
}

/// Writes every config field to the store and saves `config.json`.
pub fn save_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let state = app.state::<AppState>();
    let store = app
        .store(state.dirs.store_file())
        .map_err(|e| e.to_string())?;
    for (key, value) in config.to_entries() {
        store.set(key, value);
    }
    store.save().map_err(|e| e.to_string())
}

fn prepare_start(state: &AppState) -> Result<LaunchSpec, String> {
    state.layout.check()?;
    let spec = state.launch_spec();
    let config = state.config();
    for dir in [
        config.effective_data_dir(&state.dirs),
        config.effective_cache_dir(&state.dirs),
    ] {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    Ok(spec)
}

/// Holds `AppState::lifecycle` for one start, restart or stop-run-start.
fn lifecycle_guard(state: &AppState) -> std::sync::MutexGuard<'_, ()> {
    state.lifecycle.lock().unwrap_or_else(|p| p.into_inner())
}

/// Starts the sidecar (blocking). Used at launch.
pub fn start_sidecar(app: &AppHandle) -> ServerState {
    let state = app.state::<AppState>();
    let _lifecycle = lifecycle_guard(&state);
    match prepare_start(&state) {
        Ok(spec) => state.sidecar.start(&spec),
        Err(reason) => state.sidecar.fail(state.config().port, reason),
    }
}

/// Restarts the sidecar with the current config and secrets (blocking). The
/// single entry point for every change that affects the server.
pub fn restart_sidecar(app: &AppHandle) -> ServerState {
    let state = app.state::<AppState>();
    // The first stop interrupts a start that is still waiting for health (so
    // the lock below is released quickly); the second, under the lock, covers
    // a server another operation started in between. Waits for an import or a
    // cache clear to finish instead of starting the server in its middle.
    state.sidecar.stop();
    let _lifecycle = lifecycle_guard(&state);
    state.sidecar.stop();
    match prepare_start(&state) {
        Ok(spec) => state.sidecar.start(&spec),
        Err(reason) => state.sidecar.fail(state.config().port, reason),
    }
}

/// Stops the server, runs `f`, then starts it again with the current config
/// and secrets (blocking). Used by operations that must not run while the
/// server holds its data or cache files open. Holds the lifecycle lock
/// throughout, so no restart can start the server while `f` runs.
pub fn with_server_stopped<T>(app: &AppHandle, f: impl FnOnce(&AppState) -> T) -> T {
    let state = app.state::<AppState>();
    state.sidecar.stop();
    let _lifecycle = lifecycle_guard(&state);
    state.sidecar.stop();
    let result = f(&state);
    match prepare_start(&state) {
        Ok(spec) => state.sidecar.start(&spec),
        Err(reason) => state.sidecar.fail(state.config().port, reason),
    };
    result
}

/// Imports an existing data folder into the configured data directory with
/// the Feature 02 `import-data` subcommand, run by the sidecar's Node binary
/// (not through the running server, which is stopped meanwhile and started
/// again afterwards). Blocking.
pub fn import_data(app: &AppHandle, from: &Path, replace: bool) -> Result<ImportOutcome, String> {
    if !from.is_absolute() {
        return Err("Choose an absolute folder to import".into());
    }
    if !from.is_dir() {
        return Err(format!("{} is not a folder", from.display()));
    }
    Ok(with_server_stopped(app, |state| {
        let to = state.config().effective_data_dir(&state.dirs);
        let logs = state.sidecar.logs();
        // The server's own first-start skeleton is not a wardrobe to protect:
        // import over it (it still goes to a `before-import` backup).
        let replace = replace || storage::is_empty_wardrobe(&to);
        logs.app(&format!(
            "import-data from {} to {}{}",
            from.display(),
            to.display(),
            if replace { " (replace)" } else { "" }
        ));
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let env = sidecar::build_env(std::env::vars().collect(), &DesktopConfig::default(), &[]);
        let outcome = sidecar::run_import_data(
            state.sidecar.command(),
            &state.layout,
            from,
            &to,
            replace,
            &env,
            sidecar::IMPORT_TIMEOUT,
        );
        logs.app(&match &outcome {
            ImportOutcome::Imported {
                files,
                bytes,
                backup,
                ..
            } => format!(
                "import-data done: {files} files, {bytes} bytes{}",
                backup
                    .as_ref()
                    .map(|b| format!(", previous data moved to {b}"))
                    .unwrap_or_default()
            ),
            ImportOutcome::TargetPopulated { .. } => {
                "import-data refused: the data directory already holds a wardrobe".into()
            }
            ImportOutcome::Failed { code, message, .. } => {
                format!("import-data failed ({code}): {message}")
            }
        });
        outcome
    }))
}

/// Deletes `<cache>/transformers` with the server stopped (the loaded model
/// files can be locked on Windows), then starts it again. Blocking.
pub fn clear_model_cache(app: &AppHandle) -> Result<(), String> {
    with_server_stopped(app, |state| {
        let cache = state.config().effective_cache_dir(&state.dirs);
        state
            .sidecar
            .logs()
            .app(&format!("clearing the model cache in {}", cache.display()));
        storage::clear_model_cache(&cache)
    })
}

/// The secret store: the OS keychain, or the session-only memory store when
/// `WARDROBE_DESKTOP_SECRETS=memory`.
fn secret_store() -> (Box<dyn SecretStore>, bool) {
    let memory = std::env::var(secrets::SECRETS_BACKEND_ENV)
        .map(|v| v.eq_ignore_ascii_case("memory"))
        .unwrap_or(false);
    if memory {
        log::warn!(
            "secrets are kept in memory for this session only ({}=memory)",
            secrets::SECRETS_BACKEND_ENV
        );
        (Box::new(MemorySecretStore::default()), false)
    } else {
        (
            Box::new(KeyringSecretStore::new(secrets::KEYRING_SERVICE)),
            true,
        )
    }
}

/// Tray "Quit": stop the server (graceful, then kill after 10 s), then exit.
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        app.state::<AppState>().sidecar.stop();
        app.exit(0);
    });
}

fn repo_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    dunce_canonicalize(root)
}

/// `canonicalize` without the `\\?\` prefix on Windows, which Node handles poorly.
fn dunce_canonicalize(path: PathBuf) -> PathBuf {
    match std::fs::canonicalize(&path) {
        Ok(canonical) => {
            let text = canonical.to_string_lossy();
            match text.strip_prefix(r"\\?\") {
                Some(stripped) if !stripped.starts_with("UNC\\") => PathBuf::from(stripped),
                _ => canonical,
            }
        }
        Err(_) => path,
    }
}

fn choose_layout(app: &AppHandle) -> tauri::Result<ServerLayout> {
    let wants_bundled = std::env::var(SIDECAR_ENV)
        .map(|v| v == "bundled")
        .unwrap_or(false);
    if cfg!(debug_assertions) && !wants_bundled {
        Ok(ServerLayout::Dev {
            repo_root: repo_root(),
        })
    } else {
        Ok(ServerLayout::Bundled {
            resource_dir: dunce_canonicalize(app.path().resource_dir()?),
        })
    }
}

fn command_factory(app: &AppHandle, layout: &ServerLayout) -> sidecar::CommandFactory {
    match layout {
        ServerLayout::Dev { .. } => {
            let node = std::env::var(DEV_NODE_ENV).unwrap_or_else(|_| "node".into());
            Box::new(move || Command::new(&node))
        }
        ServerLayout::Bundled { .. } => {
            let app = app.clone();
            // tauri-plugin-shell resolves the externalBin next to the app
            // executable (and sets CREATE_NO_WINDOW on Windows). It is turned
            // into a std Command so the manager owns stdin and can close it
            // for a graceful stop, then kill after the timeout.
            Box::new(move || match app.shell().sidecar("node") {
                Ok(command) => command.into(),
                Err(error) => {
                    log::error!("cannot resolve the node sidecar: {error}");
                    Command::new("wardrobe-node-sidecar-missing")
                }
            })
        }
    }
}

fn on_server_state(app: &AppHandle, state: &ServerState) {
    windows::update_tray(app, state);
    let _ = app.emit("server-state", state);
    if let ServerState::Running { port, .. } = state {
        let _ = app.emit("server-ready", state);
        let port = *port;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let app_state = handle.state::<AppState>();
            if handle.get_webview_window(windows::WARDROBE).is_some() {
                windows::reload_wardrobe(&handle, port);
            } else if app_state.has_provider_key()
                && app_state.auto_open_wardrobe.swap(false, Ordering::SeqCst)
            {
                let opened = match app_state.config().open_wardrobe_in {
                    OpenTarget::Window => windows::open_wardrobe(&handle),
                    OpenTarget::Browser => windows::open_in_browser(&handle),
                };
                if let Err(error) = opened {
                    log::warn!("cannot open Wardrobe: {error}");
                }
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch exits early and focuses this one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            windows::focus_existing(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("desktop".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5 * 1024 * 1024)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_denylist(&[windows::CONTROL])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .on_window_event(|window, event| {
            // Closing the Wardrobe window hides it: the server keeps running in the tray.
            if window.label() == windows::WARDROBE {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let dirs = AppDirs {
                data: dunce_canonicalize_create(paths.app_data_dir()?),
                cache: dunce_canonicalize_create(paths.app_cache_dir()?),
                config: dunce_canonicalize_create(paths.app_config_dir()?),
                log: dunce_canonicalize_create(paths.app_log_dir()?),
            };
            let store = app.store(dirs.store_file())?;
            let entries = store.entries();
            let (config, warnings) =
                DesktopConfig::from_entries(entries.iter().map(|(k, v)| (k, v)));
            for warning in warnings {
                log::warn!("{warning}");
            }
            let layout = choose_layout(&handle)?;
            let hidden = std::env::args().any(|arg| arg == HIDDEN_ARG) || config.start_hidden;
            log::info!(
                "Wardrobe {} starting: sidecar {} ({}), data {}, config {}",
                app.package_info().version,
                layout.mode(),
                layout.script().display(),
                config.effective_data_dir(&dirs).display(),
                dirs.store_file().display()
            );

            let logs = LogBuffer::new(
                sidecar::LOG_CAPACITY,
                Some(dirs.server_log()),
                sidecar::LOG_ROTATE_BYTES,
            );
            let manager = SidecarManager::new(
                command_factory(&handle, &layout),
                app.package_info().version.to_string(),
                logs,
                Timing::default(),
            );
            let (secret_store, secrets_persistent) = secret_store();
            app.manage(AppState {
                sidecar: manager.clone(),
                dirs,
                layout,
                secrets: secret_store,
                secrets_persistent,
                config: Mutex::new(config),
                lifecycle: Mutex::new(()),
                auto_open_wardrobe: AtomicBool::new(!hidden),
            });
            let tray = windows::build_tray(&handle)?;
            app.manage(tray);
            let listener_handle = handle.clone();
            manager.set_listener(Arc::new(move |state: &ServerState| {
                on_server_state(&listener_handle, state)
            }));

            if !hidden && !app.state::<AppState>().has_provider_key() {
                // First launch: no key yet, so the control panel comes first.
                windows::open_control(&handle).map_err(Box::<dyn std::error::Error>::from)?;
            }
            std::thread::spawn(move || {
                start_sidecar(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::server_state,
            commands::server_restart,
            commands::server_logs,
            commands::open_wardrobe,
            commands::open_in_browser,
            commands::get_config,
            commands::set_config,
            commands::autostart_get,
            commands::autostart_set,
            commands::secret_status,
            commands::secret_set,
            commands::secret_delete,
            commands::app_info,
            commands::server_health,
            commands::data_import,
            commands::cache_status,
            commands::cache_clear_models,
            commands::pick_directory,
            commands::reveal_location,
            commands::open_help,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Wardrobe desktop app");

    app.run(|app, event| match event {
        // Closing the last window keeps the app (and the server) in the tray.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // Any real exit (tray Quit, Cmd+Q, logout): stop the server and wait for it.
        RunEvent::Exit => {
            if let Some(state) = app.try_state::<AppState>() {
                state.sidecar.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => windows::focus_existing(app),
        _ => {}
    });
}

fn dunce_canonicalize_create(path: PathBuf) -> PathBuf {
    let _ = std::fs::create_dir_all(&path);
    dunce_canonicalize(path)
}
