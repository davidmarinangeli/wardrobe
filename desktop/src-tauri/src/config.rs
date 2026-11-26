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
        validate_overrides(&self.overrides)?;
        if let Some(provider) = &self.provider {
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err(format!("provider must be one of {}", PROVIDERS.join(", ")));
            }
        }
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
        if entry.value.contains(['\n', '\r', '\0']) {
            return Err(format!("override {key}: the value must be a single line"));
        }
        if !seen.insert(key) {
            return Err(format!("override {key} appears twice"));
        }
    }
    Ok(())
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
}
