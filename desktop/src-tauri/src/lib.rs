//! Wardrobe desktop shell: runs the Wardrobe server as a Node sidecar, shows
//! the web app in the `wardrobe` window, the control panel in the `control`
//! window, and lives in the tray or menu bar.

pub mod commands;
pub mod config;
pub mod secrets;
pub mod sidecar;
pub mod windows;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;
use tauri_plugin_window_state::StateFlags;

use config::{AppDirs, DesktopConfig};
use secrets::{MemorySecretStore, SecretStore};
use sidecar::{
    LaunchInputs, LaunchSpec, LogBuffer, ServerLayout, ServerState, SidecarManager, Timing,
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
    config: Mutex<DesktopConfig>,
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

/// Starts the sidecar (blocking). Used at launch.
pub fn start_sidecar(app: &AppHandle) -> ServerState {
    let state = app.state::<AppState>();
    match prepare_start(&state) {
        Ok(spec) => state.sidecar.start(&spec),
        Err(reason) => state.sidecar.fail(state.config().port, reason),
    }
}

/// Restarts the sidecar with the current config and secrets (blocking). The
/// single entry point for every change that affects the server.
pub fn restart_sidecar(app: &AppHandle) -> ServerState {
    let state = app.state::<AppState>();
    state.sidecar.stop();
    match prepare_start(&state) {
        Ok(spec) => state.sidecar.start(&spec),
        Err(reason) => state.sidecar.fail(state.config().port, reason),
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
                if let Err(error) = windows::open_wardrobe(&handle) {
                    log::warn!("cannot open the Wardrobe window: {error}");
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
            app.manage(AppState {
                sidecar: manager.clone(),
                dirs,
                layout,
                secrets: Box::new(MemorySecretStore::default()),
                config: Mutex::new(config),
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
