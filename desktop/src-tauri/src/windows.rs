//! The `wardrobe` window (the web app served by the sidecar), the `control`
//! window (the bundled control panel) and the tray or menu-bar icon.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_opener::OpenerExt;

use crate::sidecar::ServerState;
use crate::AppState;

pub const WARDROBE: &str = "wardrobe";
pub const CONTROL: &str = "control";
pub const TRAY_ID: &str = "wardrobe-tray";

pub const MENU_OPEN: &str = "open-wardrobe";
pub const MENU_BROWSER: &str = "open-in-browser";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_UPDATES: &str = "check-for-updates";
pub const MENU_QUIT: &str = "quit";

/// The address the window and the browser use. `localhost`, not `127.0.0.1`:
/// the Google Drive redirect URI and same-origin checks assume
/// `http://localhost:<port>`, and the window then shares its origin (browser
/// storage, cookies) with "Open in browser".
pub fn app_url(port: u16) -> String {
    format!("http://localhost:{port}/")
}

/// True when `url` points at the local server on `port`.
pub fn is_server_url(url: &Url, port: u16) -> bool {
    matches!(url.scheme(), "http")
        && matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]")
        )
        && url.port_or_known_default() == Some(port)
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Shows the Wardrobe window, creating it if needed, at the running server's
/// address. Falls back to the control window when the server is not running.
pub fn open_wardrobe(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(port) = state.sidecar.state().running_port() else {
        open_control(app)?;
        return Err("The Wardrobe server is not running".into());
    };
    let url = app_url(port);
    if let Some(window) = app.get_webview_window(WARDROBE) {
        let at_server = window
            .url()
            .map(|current| is_server_url(&current, port))
            .unwrap_or(false);
        if !at_server {
            let parsed: Url = url.parse().map_err(|e| format!("{e}"))?;
            window.navigate(parsed).map_err(|e| e.to_string())?;
        }
        show(&window);
        return Ok(());
    }
    let parsed: Url = url.parse().map_err(|e| format!("{e}"))?;
    let opener = app.clone();
    let window = WebviewWindowBuilder::new(app, WARDROBE, WebviewUrl::External(parsed))
        .title("Wardrobe")
        .inner_size(1280.0, 860.0)
        .min_inner_size(380.0, 560.0)
        .center()
        .visible(true)
        // Links that ask for a new window (target="_blank") open in the
        // default browser. Same-window navigation stays here: the Google
        // Drive sign-in must return to this window with its cookie.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    show(&window);
    Ok(())
}

/// After a restart, points an existing Wardrobe window at the (possibly new)
/// server address and reloads it.
pub fn reload_wardrobe(app: &AppHandle, port: u16) {
    if let Some(window) = app.get_webview_window(WARDROBE) {
        if let Ok(url) = app_url(port).parse::<Url>() {
            let _ = window.navigate(url);
        }
    }
}

pub fn open_control(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONTROL) {
        show(&window);
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, CONTROL, WebviewUrl::App("index.html".into()))
        .title("Wardrobe Settings")
        .inner_size(520.0, 720.0)
        .min_inner_size(420.0, 480.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    show(&window);
    Ok(())
}

pub fn open_in_browser(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let port = state
        .sidecar
        .state()
        .running_port()
        .unwrap_or_else(|| state.config().port);
    app.opener()
        .open_url(app_url(port), None::<&str>)
        .map_err(|e| e.to_string())
}

/// A second launch, or the macOS dock icon: bring the app forward.
pub fn focus_existing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WARDROBE) {
        if window.is_visible().unwrap_or(false) {
            show(&window);
            return;
        }
    }
    if app.state::<AppState>().sidecar.state().is_running()
        && app.state::<AppState>().has_provider_key()
    {
        let _ = open_wardrobe(app);
    } else {
        let _ = open_control(app);
    }
}

pub struct Tray<R: Runtime> {
    pub status: MenuItem<R>,
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<Tray<Wry>> {
    let status = MenuItem::with_id(app, "status", "Wardrobe: Starting…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Wardrobe", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, MENU_BROWSER, "Open in browser", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    // Feature 06 wires the updater; until then the item is visible but disabled.
    let updates = MenuItem::with_id(app, MENU_UPDATES, "Check for updates…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Wardrobe", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &browser,
            &settings,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Wardrobe")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => {
                let _ = open_wardrobe(app);
            }
            MENU_BROWSER => {
                let _ = open_in_browser(app);
            }
            MENU_SETTINGS => {
                let _ = open_control(app);
            }
            MENU_QUIT => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows: a left click opens Wardrobe (the menu is on right click).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if !cfg!(target_os = "macos") {
                    focus_existing(tray.app_handle());
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(Tray { status })
}

/// Updates the tray status line and tooltip.
pub fn update_tray(app: &AppHandle, state: &ServerState) {
    let label = format!("Wardrobe: {}", state.label());
    if let Some(tray) = app.try_state::<Tray<Wry>>() {
        let _ = tray.status.set_text(&label);
    }
    if let Some(icon) = app.tray_by_id(TRAY_ID) {
        let _ = icon.set_tooltip(Some(&label));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        assert_eq!(app_url(5173), "http://localhost:5173/");
        let ok = |s: &str| is_server_url(&s.parse::<Url>().unwrap(), 5173);
        assert!(ok("http://localhost:5173/"));
        assert!(ok("http://127.0.0.1:5173/library?x=1"));
        assert!(!ok("http://localhost:5174/"));
        assert!(!ok("https://localhost:5173/"));
        assert!(!ok("https://accounts.google.com/o/oauth2/v2/auth"));
    }
}
