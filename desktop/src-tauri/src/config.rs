//! Typed desktop configuration, persisted with `tauri-plugin-store` in
//! `<app config dir>/config.json`. Secrets never live here (see `secrets.rs`).
//!
//! Every top-level field is one store key. Loading is per key: an invalid
//! value falls back to its default with a warning instead of discarding the
//! whole file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::secrets;

pub const STORE_FILE: &str = "config.json";
pub const DEFAULT_PORT: u16 = 5173;

/// `AI_PROVIDER` values the server understands.
pub const PROVIDERS: [&str; 4] = ["openai", "openrouter", "gemini", "minimax"];

/// Environment keys the shell sets itself (from dedicated settings or flags).
/// They are rejected as overrides and stripped from the inherited environment.
pub const SHELL_OWNED_KEYS: [&str; 6] = [
    "WARDROBE_DATA_DIR",
    "WARDROBE_CACHE_DIR",
    "WARDROBE_MANAGED_CONFIG",
    "WARDROBE_ALLOWED_HOSTS",
    "AI_PROVIDER",
    "NODE_OPTIONS",
];

/// The non-secret Google Drive values, owned by the panel's Google Drive
/// section. They are rejected as overrides with a pointer to that section.
pub const DRIVE_ENV_KEYS: [&str; 3] = [
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_REDIRECT_URI",
    "GOOGLE_DRIVE_FOLDER_ID",
];

/// The path the server's OAuth callback is mounted on.
pub const DRIVE_CALLBACK_PATH: &str = "/api/google-drive/oauth/callback";

/// The redirect URI the panel proposes for a port.
pub fn default_drive_redirect_uri(port: u16) -> String {
    format!("http://localhost:{port}{DRIVE_CALLBACK_PATH}")
}

/// Google Drive archive credentials, except the client secret (keychain).
/// Empty strings mean "not set".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GoogleDriveConfig {
    pub client_id: String,
    /// `None` follows the port: `http://localhost:<port>/api/google-drive/oauth/callback`.
    pub redirect_uri: Option<String>,
    pub folder_id: String,
}

/// A partial update of `GoogleDriveConfig`. For `redirect_uri`, an empty
/// string goes back to the port-derived default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GoogleDrivePatch {
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    pub folder_id: Option<String>,
}

/// Where Wardrobe opens when the app launches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTarget {
    #[default]
    Window,
    Browser,
}

/// One non-secret environment override, kept in the user's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverrideEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopConfig {
    /// Fixed server port. Never changed silently (the Drive redirect URI depends on it).
    pub port: u16,
    /// `None` means `<app data dir>/data`.
    pub data_dir: Option<PathBuf>,
    /// `None` means `<app cache dir>`.
    pub cache_dir: Option<PathBuf>,
    /// Extra `--allowed-hosts` entries (Feature 07 adds the tailnet name).
    pub allowed_hosts: Vec<String>,
    pub launch_at_login: bool,
    pub start_hidden: bool,
    /// Ordered non-secret `KEY=value` environment entries.
    pub overrides: Vec<OverrideEntry>,
    /// `AI_PROVIDER`; `None` lets the server use its default.
    pub provider: Option<String>,
    /// `GOOGLE_DRIVE_CLIENT_ID`, `_REDIRECT_URI`, `_FOLDER_ID`.
    pub google_drive: GoogleDriveConfig,
    /// Open Wardrobe in the app window or the default browser at launch.
    pub open_wardrobe_in: OpenTarget,
    /// Remote access through `tailscale serve` is on (Feature 07). Only the
    /// `tailscale_enable` and `tailscale_disable` commands change it.
    pub remote_access: bool,
    /// The machine's tailnet DNS name (`mac.tail1234.ts.net`) recorded when
    /// remote access was turned on, refreshed at launch. Passed to the server
    /// in `--allowed-hosts` while `remote_access` is on.
    pub remote_host: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            data_dir: None,
            cache_dir: None,
            allowed_hosts: Vec::new(),
            launch_at_login: false,
            start_hidden: false,
            overrides: Vec::new(),
            provider: None,
            google_drive: GoogleDriveConfig::default(),
            open_wardrobe_in: OpenTarget::Window,
            remote_access: false,
            remote_host: None,
        }
    }
}

/// A partial update from the control panel. Absent fields stay unchanged.
/// For `data_dir`, `cache_dir` and `provider`, an empty string resets to the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigPatch {
    pub port: Option<u16>,
    pub data_dir: Option<String>,
    pub cache_dir: Option<String>,
    pub allowed_hosts: Option<Vec<String>>,
    pub launch_at_login: Option<bool>,
    pub start_hidden: Option<bool>,
    pub overrides: Option<Vec<OverrideEntry>>,
    pub provider: Option<String>,
    pub google_drive: Option<GoogleDrivePatch>,
    pub open_wardrobe_in: Option<OpenTarget>,
}

/// Absolute locations the shell uses. All writable paths come from the
/// Tauri path resolver, never from the install directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppDirs {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub config: PathBuf,
    pub log: PathBuf,
}

impl AppDirs {
    pub fn default_data_dir(&self) -> PathBuf {
        self.data.join("data")
    }
    pub fn default_cache_dir(&self) -> PathBuf {
        self.cache.clone()
    }
    pub fn store_file(&self) -> PathBuf {
        self.config.join(STORE_FILE)
    }
    pub fn server_log(&self) -> PathBuf {
        self.log.join("server.log")
    }
}

impl DesktopConfig {
    pub fn effective_data_dir(&self, dirs: &AppDirs) -> PathBuf {
        self.data_dir
            .clone()
            .unwrap_or_else(|| dirs.default_data_dir())
    }

    pub fn effective_cache_dir(&self, dirs: &AppDirs) -> PathBuf {
        self.cache_dir
            .clone()
            .unwrap_or_else(|| dirs.default_cache_dir())
    }

    /// The `--allowed-hosts` entries: the configured ones, plus the tailnet
    /// name while remote access is on.
    pub fn effective_allowed_hosts(&self) -> Vec<String> {
        let mut hosts = self.allowed_hosts.clone();
        if self.remote_access {
            if let Some(host) = &self.remote_host {
                if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
                    hosts.push(host.clone());
                }
            }
        }
        hosts
    }

    /// The URL a phone opens while remote access is on: `https://<remote_host>/`.
    pub fn remote_url(&self) -> Option<String> {
        if !self.remote_access {
            return None;
        }
        self.remote_host
            .as_ref()
            .map(|host| format!("https://{host}/"))
    }

    /// The redirect URI the server gets: the stored one, or the port default.
    pub fn effective_drive_redirect_uri(&self) -> String {
        self.google_drive
            .redirect_uri
            .clone()
            .unwrap_or_else(|| default_drive_redirect_uri(self.port))
    }

    /// The Google Drive environment entries. Nothing when no Drive value is
    /// configured (neither here nor the client secret), so an unconfigured app
    /// does not hand the server a lone default redirect URI, which the server
    /// would report as an incomplete configuration.
    pub fn drive_env(&self, client_secret_present: bool) -> Vec<(String, String)> {
        let drive = &self.google_drive;
        let configured = !drive.client_id.is_empty()
            || !drive.folder_id.is_empty()
            || drive.redirect_uri.is_some()
            || client_secret_present;
        if !configured {
            return Vec::new();
        }
        let mut env = Vec::new();
        if !drive.client_id.is_empty() {
            env.push(("GOOGLE_DRIVE_CLIENT_ID".into(), drive.client_id.clone()));
        }
        env.push((
            "GOOGLE_DRIVE_REDIRECT_URI".into(),
            self.effective_drive_redirect_uri(),
        ));
        if !drive.folder_id.is_empty() {
            env.push(("GOOGLE_DRIVE_FOLDER_ID".into(), drive.folder_id.clone()));
        }
        env
    }

    /// Builds a config from store entries. Unknown keys are ignored; a known
    /// key with an invalid value keeps the default and yields a warning.
    pub fn from_entries<'a>(
        entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
    ) -> (Self, Vec<String>) {
        let mut current = match serde_json::to_value(Self::default()) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let mut warnings = Vec::new();
        for (key, value) in entries {
            if !current.contains_key(key) {
                continue;
            }
            let mut candidate = current.clone();
            candidate.insert(key.clone(), value.clone());
            match serde_json::from_value::<Self>(Value::Object(candidate.clone())) {
                Ok(config) => match config.validate() {
                    Ok(()) => current = candidate,
                    Err(error) => warnings.push(format!("config.json: ignoring {key}: {error}")),
                },
                Err(error) => warnings.push(format!("config.json: ignoring {key}: {error}")),
            }
        }
        let config = serde_json::from_value(Value::Object(current)).unwrap_or_default();
        (config, warnings)
    }

    /// The store entries for this config, one per field.
    pub fn to_entries(&self) -> Vec<(String, Value)> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map.into_iter().collect(),
            _ => Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("port must be between 1 and 65535".into());
        }
        for (name, dir) in [("data_dir", &self.data_dir), ("cache_dir", &self.cache_dir)] {
            if let Some(dir) = dir {
                validate_dir(name, dir)?;
            }
        }
        for host in &self.allowed_hosts {
            validate_host(host)?;
        }
        if let Some(host) = &self.remote_host {
            validate_host(host)?;
        }
        validate_overrides(&self.overrides)?;
        if let Some(provider) = &self.provider {
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err(format!("provider must be one of {}", PROVIDERS.join(", ")));
            }
        }
        validate_drive(&self.google_drive)?;
        Ok(())
    }

    /// Applies a patch and validates the result. Returns the new config and
    /// whether the running server must restart to see the change.
    pub fn apply(&self, patch: ConfigPatch) -> Result<(Self, bool), String> {
        let mut next = self.clone();
        if let Some(port) = patch.port {
            next.port = port;
        }
        if let Some(dir) = patch.data_dir {
            next.data_dir = optional_path(dir);
        }
        if let Some(dir) = patch.cache_dir {
            next.cache_dir = optional_path(dir);
        }
        if let Some(hosts) = patch.allowed_hosts {
            next.allowed_hosts = hosts
                .into_iter()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .collect();
        }
        if let Some(value) = patch.launch_at_login {
            next.launch_at_login = value;
        }
        if let Some(value) = patch.start_hidden {
            next.start_hidden = value;
        }
        if let Some(overrides) = patch.overrides {
            next.overrides = overrides;
        }
        if let Some(provider) = patch.provider {
            let provider = provider.trim().to_ascii_lowercase();
            next.provider = if provider.is_empty() {
                None
            } else {
                Some(provider)
            };
        }
        if let Some(drive) = patch.google_drive {
            if let Some(client_id) = drive.client_id {
                next.google_drive.client_id = client_id.trim().to_string();
            }
            if let Some(redirect_uri) = drive.redirect_uri {
                let redirect_uri = redirect_uri.trim();
                next.google_drive.redirect_uri = if redirect_uri.is_empty() {
                    None
                } else {
                    Some(redirect_uri.to_string())
                };
            }
            if let Some(folder_id) = drive.folder_id {
                next.google_drive.folder_id = folder_id.trim().to_string();
            }
        }
        if let Some(target) = patch.open_wardrobe_in {
            next.open_wardrobe_in = target;
        }
        next.validate()?;
        let restart = next.affects_server(self);
        Ok((next, restart))
    }

    /// True when `self` and `other` start the server differently.
    pub fn affects_server(&self, other: &Self) -> bool {
        self.port != other.port
            || self.data_dir != other.data_dir
            || self.cache_dir != other.cache_dir
            || self.allowed_hosts != other.allowed_hosts
            || self.overrides != other.overrides
            || self.provider != other.provider
            || self.google_drive != other.google_drive
            || self.effective_allowed_hosts() != other.effective_allowed_hosts()
    }
}

fn optional_path(value: String) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn validate_dir(name: &str, dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    Ok(())
}

fn validate_host(host: &str) -> Result<(), String> {
    let valid = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']' | ':'));
    if valid {
        Ok(())
    } else {
        Err(format!("allowed host {host:?} is not a host name"))
    }
}

/// `^[A-Z0-9_]+$` keys, no secret names (they belong in the keychain), no
/// keys the shell owns, no duplicates, single-line values.
pub fn validate_overrides(overrides: &[OverrideEntry]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for entry in overrides {
        let key = entry.key.as_str();
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(format!("override {key:?}: keys use only A-Z, 0-9 and _"));
        }
        if secrets::is_secret_name(key) || key == "GEMINI_API_KEY" {
            return Err(format!("override {key}: use the key fields above"));
        }
        if SHELL_OWNED_KEYS.contains(&key) {
            return Err(format!("override {key}: set by the desktop app itself"));
        }
        if DRIVE_ENV_KEYS.contains(&key) {
            return Err(format!(
                "override {key}: set it in the Google Drive section"
            ));
        }
        if entry.value.contains(['\n', '\r', '\0']) {
            return Err(format!("override {key}: the value must be a single line"));
        }
        if !seen.insert(key) {
            return Err(format!("override {key} appears twice"));
        }
    }
    Ok(())
}

fn single_line(value: &str) -> bool {
    !value.contains(['\n', '\r', '\0'])
}

/// The same rules the server applies (`scripts/google-drive-auth.mjs`), so a
/// value the panel accepts is never reported as `configuration_invalid`.
pub fn validate_drive(drive: &GoogleDriveConfig) -> Result<(), String> {
    let client_id = drive.client_id.as_str();
    if client_id.len() > 512 || !single_line(client_id) || client_id.contains(char::is_whitespace) {
        return Err("Google Drive client ID: one line, no spaces, at most 512 characters".into());
    }
    let folder = drive.folder_id.as_str();
    if !folder.is_empty()
        && (folder.len() < 5
            || folder.len() > 200
            || !folder
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        return Err(
            "Google Drive folder ID: 5 to 200 letters, digits, _ or - (the last part of the folder URL)"
                .into(),
        );
    }
    if let Some(uri) = &drive.redirect_uri {
        validate_redirect_uri(uri)?;
    }
    Ok(())
}

/// `https://…/api/google-drive/oauth/callback`, or `http://` on a loopback
/// host, with no user info, query or fragment.
pub fn validate_redirect_uri(uri: &str) -> Result<(), String> {
    let invalid = || {
        format!(
            "Google Drive redirect URI must look like {} (https, or http on localhost)",
            default_drive_redirect_uri(DEFAULT_PORT)
        )
    };
    if !single_line(uri) || uri.contains(char::is_whitespace) || uri.contains(['?', '#', '@']) {
        return Err(invalid());
    }
    let (scheme, rest) = uri.split_once("://").ok_or_else(invalid)?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => return Err(invalid()),
    };
    if path != DRIVE_CALLBACK_PATH || authority.is_empty() {
        return Err(invalid());
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped
            .split(']')
            .next()
            .map(|h| format!("[{h}]"))
            .unwrap_or_default()
    } else {
        authority
            .split(':')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(key: &str, value: &str) -> OverrideEntry {
        OverrideEntry {
            key: key.into(),
            value: value.into(),
        }
    }

    fn abs(path: &str) -> String {
        if cfg!(windows) {
            format!("C:\\{}", path.trim_start_matches('/').replace('/', "\\"))
        } else {
            path.to_string()
        }
    }

    #[test]
    fn defaults() {
        let config = DesktopConfig::default();
        assert_eq!(config.port, 5173);
        assert!(
            config.data_dir.is_none() && config.cache_dir.is_none() && config.provider.is_none()
        );
        let dirs = AppDirs {
            data: "/d".into(),
            cache: "/c".into(),
            config: "/cfg".into(),
            log: "/l".into(),
        };
        assert_eq!(
            config.effective_data_dir(&dirs),
            PathBuf::from("/d").join("data")
        );
        assert_eq!(config.effective_cache_dir(&dirs), PathBuf::from("/c"));
        assert_eq!(dirs.store_file(), PathBuf::from("/cfg").join("config.json"));
        assert_eq!(dirs.server_log(), PathBuf::from("/l").join("server.log"));
    }

    #[test]
    fn remote_access_fields() {
        let mut config = DesktopConfig::default();
        assert!(!config.remote_access && config.remote_host.is_none());
        assert_eq!(config.remote_url(), None);
        config.remote_host = Some("wardrobe-mac.tail1234.ts.net".into());
        assert!(
            config.effective_allowed_hosts().is_empty(),
            "off: not allowed"
        );
        assert_eq!(config.remote_url(), None);
        let mut on = config.clone();
        on.remote_access = true;
        assert_eq!(
            on.effective_allowed_hosts(),
            ["wardrobe-mac.tail1234.ts.net"]
        );
        assert_eq!(
            on.remote_url().as_deref(),
            Some("https://wardrobe-mac.tail1234.ts.net/")
        );
        assert!(
            on.affects_server(&config),
            "turning it on restarts the server"
        );
        on.allowed_hosts = vec!["WARDROBE-MAC.tail1234.ts.net".into()];
        assert_eq!(on.effective_allowed_hosts().len(), 1, "no duplicate entry");
        // A patch from the panel never touches the remote fields.
        let (patched, _) = on
            .apply(ConfigPatch {
                start_hidden: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert!(patched.remote_access);
        assert_eq!(patched.remote_host, on.remote_host);
        // An invalid stored name is ignored with a warning.
        let entries = [("remote_host".to_string(), json!("bad host/name"))];
        let (loaded, warnings) = DesktopConfig::from_entries(entries.iter().map(|(k, v)| (k, v)));
        assert_eq!(loaded.remote_host, None);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn round_trips_through_store_entries() {
        let config = DesktopConfig {
            port: 5174,
            data_dir: Some(abs("/w/data").into()),
            cache_dir: None,
            allowed_hosts: vec![".ts.net".into()],
            launch_at_login: true,
            start_hidden: true,
            overrides: vec![
                entry("OPENAI_IMAGE_MODEL", "gpt-image-2"),
                entry("GEMINI_IMAGE_SIZE", "2K"),
            ],
            provider: Some("gemini".into()),
            google_drive: GoogleDriveConfig {
                client_id: "123-abc.apps.googleusercontent.com".into(),
                redirect_uri: None,
                folder_id: "1AbCdEfGhIjK".into(),
            },
            open_wardrobe_in: OpenTarget::Browser,
            remote_access: true,
            remote_host: Some("wardrobe-mac.tail1234.ts.net".into()),
        };
        let entries: Map<String, Value> = config.to_entries().into_iter().collect();
        let keys: Vec<&str> = entries.keys().map(String::as_str).collect();
        for key in [
            "port",
            "data_dir",
            "cache_dir",
            "allowed_hosts",
            "launch_at_login",
            "start_hidden",
            "overrides",
            "provider",
            "google_drive",
            "open_wardrobe_in",
            "remote_access",
            "remote_host",
        ] {
            assert!(keys.contains(&key), "missing store key {key}");
        }
        let (loaded, warnings) = DesktopConfig::from_entries(&entries);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(loaded, config);
        // Order of overrides is preserved.
        assert_eq!(loaded.overrides[0].key, "OPENAI_IMAGE_MODEL");
    }

    #[test]
    fn invalid_store_values_fall_back_per_key() {
        let entries: Map<String, Value> = [
            ("port".to_string(), json!("not a number")),
            ("provider".to_string(), json!("anthropic")),
            ("start_hidden".to_string(), json!(true)),
            (
                "overrides".to_string(),
                json!([{ "key": "OPENAI_API_KEY", "value": "sk-x" }]),
            ),
            ("unknown".to_string(), json!(1)),
        ]
        .into_iter()
        .collect();
        let (config, warnings) = DesktopConfig::from_entries(&entries);
        assert_eq!(config.port, 5173);
        assert_eq!(config.provider, None);
        assert!(config.start_hidden);
        assert!(
            config.overrides.is_empty(),
            "a secret must never be loaded as an override"
        );
        assert_eq!(warnings.len(), 3, "{warnings:?}");
    }

    #[test]
    fn patch_reports_restart_only_for_server_settings() {
        let base = DesktopConfig::default();
        let (next, restart) = base
            .apply(ConfigPatch {
                start_hidden: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert!(next.start_hidden && !restart);
        let (next, restart) = base
            .apply(ConfigPatch {
                port: Some(5174),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.port, 5174);
        assert!(restart);
        let (next, restart) = base
            .apply(ConfigPatch {
                provider: Some(" Gemini ".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.provider.as_deref(), Some("gemini"));
        assert!(restart);
        let (next, _) = next
            .apply(ConfigPatch {
                provider: Some(String::new()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.provider, None);
        let (next, restart) = base
            .apply(ConfigPatch {
                data_dir: Some(abs("/elsewhere")),
                ..Default::default()
            })
            .unwrap();
        assert!(next.data_dir.is_some() && restart);
        let (next, _) = next
            .apply(ConfigPatch {
                data_dir: Some("  ".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.data_dir, None);
        let (next, restart) = base
            .apply(ConfigPatch {
                allowed_hosts: Some(vec![" .ts.net ".into(), "".into()]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.allowed_hosts, vec![".ts.net".to_string()]);
        assert!(restart);
    }

    #[test]
    fn patch_validation() {
        let base = DesktopConfig::default();
        let reject = |patch: ConfigPatch| base.apply(patch).unwrap_err();
        assert!(reject(ConfigPatch {
            port: Some(0),
            ..Default::default()
        })
        .contains("port"));
        assert!(reject(ConfigPatch {
            data_dir: Some("relative/dir".into()),
            ..Default::default()
        })
        .contains("absolute"));
        assert!(reject(ConfigPatch {
            provider: Some("anthropic".into()),
            ..Default::default()
        })
        .contains("provider"));
        assert!(reject(ConfigPatch {
            allowed_hosts: Some(vec!["evil example".into()]),
            ..Default::default()
        })
        .contains("host"));
        let overrides = |entries: Vec<OverrideEntry>| {
            reject(ConfigPatch {
                overrides: Some(entries),
                ..Default::default()
            })
        };
        assert!(overrides(vec![entry("openai_image_model", "x")]).contains("A-Z"));
        assert!(overrides(vec![entry("OPENAI_API_KEY", "sk")]).contains("use the key fields above"));
        assert!(overrides(vec![entry("GOOGLE_DRIVE_CLIENT_SECRET", "s")])
            .contains("use the key fields above"));
        assert!(overrides(vec![entry("GEMINI_API_KEY", "s")]).contains("use the key fields above"));
        for owned in SHELL_OWNED_KEYS {
            assert!(
                overrides(vec![entry(owned, "x")]).contains("desktop app"),
                "{owned}"
            );
        }
        assert!(overrides(vec![entry("A", "1\n2")]).contains("single line"));
        assert!(overrides(vec![entry("A", "1"), entry("A", "2")]).contains("twice"));
        assert!(base
            .apply(ConfigPatch {
                overrides: Some(vec![entry("OPENAI_IMAGE_ROUTE", "responses")]),
                ..Default::default()
            })
            .is_ok());
    }

    #[test]
    fn drive_overrides_point_to_the_drive_section() {
        let base = DesktopConfig::default();
        for key in DRIVE_ENV_KEYS {
            let error = base
                .apply(ConfigPatch {
                    overrides: Some(vec![entry(key, "x")]),
                    ..Default::default()
                })
                .unwrap_err();
            assert!(error.contains("Google Drive section"), "{key}: {error}");
        }
    }

    #[test]
    fn drive_settings_follow_the_port_and_validate() {
        let base = DesktopConfig::default();
        assert!(
            base.drive_env(false).is_empty(),
            "nothing configured, nothing exported"
        );
        let (drive, restart) = base
            .apply(ConfigPatch {
                google_drive: Some(GoogleDrivePatch {
                    client_id: Some(" 123-abc.apps.googleusercontent.com ".into()),
                    folder_id: Some("1AbCdEfGhIjK_-".into()),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        assert!(restart);
        assert_eq!(
            drive.drive_env(true),
            vec![
                (
                    "GOOGLE_DRIVE_CLIENT_ID".to_string(),
                    "123-abc.apps.googleusercontent.com".to_string()
                ),
                (
                    "GOOGLE_DRIVE_REDIRECT_URI".to_string(),
                    "http://localhost:5173/api/google-drive/oauth/callback".to_string()
                ),
                (
                    "GOOGLE_DRIVE_FOLDER_ID".to_string(),
                    "1AbCdEfGhIjK_-".to_string()
                ),
            ]
        );
        // The default redirect URI follows the port.
        let (moved, _) = drive
            .apply(ConfigPatch {
                port: Some(5174),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            moved.effective_drive_redirect_uri(),
            "http://localhost:5174/api/google-drive/oauth/callback"
        );
        // An edited one does not, until it is reset with an empty string.
        let (edited, _) = moved
            .apply(ConfigPatch {
                google_drive: Some(GoogleDrivePatch {
                    redirect_uri: Some(
                        "https://wardrobe.example.ts.net/api/google-drive/oauth/callback".into(),
                    ),
                    ..Default::default()
                }),
                port: Some(5175),
                ..Default::default()
            })
            .unwrap();
        assert!(edited
            .effective_drive_redirect_uri()
            .starts_with("https://wardrobe.example"));
        let (reset, _) = edited
            .apply(ConfigPatch {
                google_drive: Some(GoogleDrivePatch {
                    redirect_uri: Some(" ".into()),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(reset.google_drive.redirect_uri, None);
        assert!(reset.effective_drive_redirect_uri().contains(":5175/"));
        // Only the secret set: the redirect URI is exported so the server
        // reports "incomplete" rather than nothing.
        assert_eq!(base.drive_env(true).len(), 1);

        let reject = |patch: GoogleDrivePatch| {
            base.apply(ConfigPatch {
                google_drive: Some(patch),
                ..Default::default()
            })
            .unwrap_err()
        };
        assert!(reject(GoogleDrivePatch {
            folder_id: Some("abc".into()),
            ..Default::default()
        })
        .contains("folder ID"));
        assert!(reject(GoogleDrivePatch {
            folder_id: Some("folder/with/slashes".into()),
            ..Default::default()
        })
        .contains("folder ID"));
        assert!(reject(GoogleDrivePatch {
            client_id: Some("two words".into()),
            ..Default::default()
        })
        .contains("client ID"));
        for bad in [
            "http://example.com/api/google-drive/oauth/callback",
            "https://example.com/other",
            "https://example.com/api/google-drive/oauth/callback?x=1",
            "ftp://localhost/api/google-drive/oauth/callback",
            "localhost:5173/api/google-drive/oauth/callback",
        ] {
            assert!(validate_redirect_uri(bad).is_err(), "{bad}");
        }
        for good in [
            "http://localhost:5173/api/google-drive/oauth/callback",
            "http://127.0.0.1:5174/api/google-drive/oauth/callback",
            "http://[::1]:5173/api/google-drive/oauth/callback",
            "https://machine.tail1234.ts.net/api/google-drive/oauth/callback",
        ] {
            assert!(validate_redirect_uri(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn open_target_is_not_a_server_setting() {
        let (next, restart) = DesktopConfig::default()
            .apply(ConfigPatch {
                open_wardrobe_in: Some(OpenTarget::Browser),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(next.open_wardrobe_in, OpenTarget::Browser);
        assert!(!restart);
        assert_eq!(
            serde_json::to_value(OpenTarget::Browser).unwrap(),
            serde_json::json!("browser")
        );
    }
}
