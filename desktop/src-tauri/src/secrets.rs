//! API keys and the Google Drive client secret.
//!
//! The app stores them in the OS keychain (macOS Keychain, Windows Credential
//! Manager) through `KeyringSecretStore`: one entry per name, under the
//! service `KEYRING_SERVICE`. `MemorySecretStore` is a session-only store for
//! tests and for `WARDROBE_DESKTOP_SECRETS=memory`.
//!
//! Values never travel back to the frontend: only presence and a hint.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// Every secret the desktop app manages, in display order.
pub const SECRET_NAMES: [&str; 6] = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY_TEST",
    "GEMINI_API_KEY_PROD",
    "MINIMAX_API_KEY",
    "GOOGLE_DRIVE_CLIENT_SECRET",
];

/// The secrets that let the server reach an AI provider.
pub const PROVIDER_KEY_NAMES: [&str; 5] = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY_TEST",
    "GEMINI_API_KEY_PROD",
    "MINIMAX_API_KEY",
];

pub fn is_secret_name(name: &str) -> bool {
    SECRET_NAMES.contains(&name)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretStatus {
    pub present: bool,
    /// `"…ab12"`: the last four characters, only when present.
    pub hint: Option<String>,
    /// Why the keychain could not be read (for example access denied). Never
    /// contains the value. Omitted when the read worked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Keychain service of every entry. On macOS the bundle identifier is part of
/// it, so the entries are scoped to this app in Keychain Access. It must never
/// change: a reinstall or an update finds the keys again through it.
pub const KEYRING_SERVICE: &str = if cfg!(target_os = "macos") {
    "wardrobe (app.wardrobe.desktop)"
} else {
    "wardrobe"
};

/// `WARDROBE_DESKTOP_SECRETS=memory` keeps secrets in memory for the session
/// instead of the keychain (manual tests on a machine whose keychain must not
/// be touched).
pub const SECRETS_BACKEND_ENV: &str = "WARDROBE_DESKTOP_SECRETS";

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Session-only store. Lost when the app quits; never touches the keychain.
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<BTreeMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|e| e.to_string())?
            .get(name)
            .cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|e| e.to_string())?
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.values.lock().map_err(|e| e.to_string())?.remove(name);
        Ok(())
    }
}

/// The OS keychain, through the `keyring` crate. Entry objects are kept per
/// name, and values read once are cached for the session, so the keychain is
/// read at most once per name (each read can show a macOS access prompt for an
/// unsigned build). Errors are never cached: a later call retries.
pub struct KeyringSecretStore {
    service: String,
    entries: Mutex<BTreeMap<String, Arc<keyring::Entry>>>,
    cache: Mutex<BTreeMap<String, Option<String>>>,
}

impl KeyringSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            entries: Mutex::new(BTreeMap::new()),
            cache: Mutex::new(BTreeMap::new()),
        }
    }

    fn entry(&self, name: &str) -> Result<Arc<keyring::Entry>, String> {
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = entries.get(name) {
            return Ok(entry.clone());
        }
        let entry = Arc::new(keyring::Entry::new(&self.service, name).map_err(describe)?);
        entries.insert(name.to_string(), entry.clone());
        Ok(entry)
    }

    fn remember(&self, name: &str, value: Option<String>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(name.to_string(), value);
        }
    }
}

/// A keychain error as text. `keyring` errors never include the password.
fn describe(error: keyring::Error) -> String {
    format!("keychain: {error}")
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        if let Some(cached) = self.cache.lock().map_err(|e| e.to_string())?.get(name) {
            return Ok(cached.clone());
        }
        let value = match self.entry(name)?.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(describe(error)),
        };
        self.remember(name, value.clone());
        Ok(value)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.entry(name)?.set_password(value).map_err(describe)?;
        self.remember(name, Some(value.to_string()));
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(describe(error)),
        }
        self.remember(name, None);
        Ok(())
    }
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if is_secret_name(name) {
        Ok(())
    } else {
        Err(format!("{name:?} is not a secret the desktop app manages"))
    }
}

/// Trims the value and rejects empty or multi-line input.
pub fn normalize_value(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("the value is empty".into());
    }
    if trimmed.contains(['\n', '\r', '\0']) {
        return Err("the value must be a single line".into());
    }
    Ok(trimmed.to_string())
}

/// Values shorter than this get no characters in their hint, so the last four
/// characters never amount to most (or all) of the secret.
const HINT_MIN_CHARS: usize = 8;

pub fn hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < HINT_MIN_CHARS {
        return "…".into();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("…{tail}")
}

pub fn set(store: &dyn SecretStore, name: &str, value: &str) -> Result<(), String> {
    validate_name(name)?;
    store.set(name, &normalize_value(value)?)
}

pub fn delete(store: &dyn SecretStore, name: &str) -> Result<(), String> {
    validate_name(name)?;
    store.delete(name)
}

pub fn status(store: &dyn SecretStore) -> BTreeMap<String, SecretStatus> {
    SECRET_NAMES
        .iter()
        .map(|name| {
            let (value, error) = match store.get(name) {
                Ok(value) => (value.filter(|v| !v.is_empty()), None),
                Err(error) => (None, Some(error)),
            };
            let status = SecretStatus {
                present: value.is_some(),
                hint: value.as_deref().map(hint),
                error,
            };
            (name.to_string(), status)
        })
        .collect()
}

/// `(name, value)` for every present secret, for the sidecar environment.
pub fn present(store: &dyn SecretStore) -> Vec<(String, String)> {
    SECRET_NAMES
        .iter()
        .filter_map(|name| {
            store
                .get(name)
                .ok()
                .flatten()
                .filter(|v| !v.is_empty())
                .map(|v| (name.to_string(), v))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_status_delete() {
        let store = MemorySecretStore::default();
        assert!(status(&store)
            .values()
            .all(|s| !s.present && s.hint.is_none()));
        set(&store, "OPENAI_API_KEY", "  sk-test-abcd1234  ").unwrap();
        let all = status(&store);
        assert_eq!(
            all["OPENAI_API_KEY"],
            SecretStatus {
                present: true,
                hint: Some("…1234".into()),
                error: None,
            }
        );
        assert_eq!(all.len(), SECRET_NAMES.len());
        let json = serde_json::to_string(&all).unwrap();
        assert!(
            !json.contains("sk-test"),
            "status must never contain the value: {json}"
        );
        assert_eq!(
            present(&store),
            vec![("OPENAI_API_KEY".to_string(), "sk-test-abcd1234".to_string())]
        );
        delete(&store, "OPENAI_API_KEY").unwrap();
        assert!(!status(&store)["OPENAI_API_KEY"].present);
    }

    #[test]
    fn rejects_unknown_names_and_bad_values() {
        let store = MemorySecretStore::default();
        assert!(set(&store, "PATH", "x").is_err());
        assert!(
            set(&store, "GEMINI_API_KEY", "x").is_err(),
            "legacy name is never written"
        );
        assert!(delete(&store, "HOME").is_err());
        assert!(set(&store, "OPENAI_API_KEY", "   ").is_err());
        assert!(set(&store, "OPENAI_API_KEY", "a\nb").is_err());
        assert!(present(&store).is_empty());
    }

    #[test]
    fn hint_of_short_values() {
        assert_eq!(hint("ab"), "…", "a short value is never revealed");
        assert_eq!(hint("abcd"), "…");
        assert_eq!(hint("abcdefg"), "…");
        assert_eq!(hint("abcdefgh"), "…efgh");
    }

    /// The keyring crate's mock store: process-wide, never the real keychain.
    fn mock_keyring() -> KeyringSecretStore {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        KeyringSecretStore::new(KEYRING_SERVICE)
    }

    #[test]
    fn keyring_store_set_status_delete() {
        let store = mock_keyring();
        assert!(status(&store).values().all(|s| !s.present));
        set(&store, "OPENAI_API_KEY", " sk-live-abcd9876\n").unwrap();
        set(&store, "GOOGLE_DRIVE_CLIENT_SECRET", "GOCSPX-secret-wxyz").unwrap();
        let all = status(&store);
        assert_eq!(all["OPENAI_API_KEY"].hint.as_deref(), Some("…9876"));
        assert!(all["GOOGLE_DRIVE_CLIENT_SECRET"].present);
        assert!(!all["MINIMAX_API_KEY"].present);
        let json = serde_json::to_string(&all).unwrap();
        assert!(
            !json.contains("sk-live") && !json.contains("GOCSPX"),
            "{json}"
        );
        // The value reaches the keychain entry itself, trimmed.
        assert_eq!(
            store
                .entry("OPENAI_API_KEY")
                .unwrap()
                .get_password()
                .unwrap(),
            "sk-live-abcd9876"
        );
        assert_eq!(
            present(&store),
            vec![
                ("OPENAI_API_KEY".to_string(), "sk-live-abcd9876".to_string()),
                (
                    "GOOGLE_DRIVE_CLIENT_SECRET".to_string(),
                    "GOCSPX-secret-wxyz".to_string()
                ),
            ]
        );
        delete(&store, "OPENAI_API_KEY").unwrap();
        assert!(!status(&store)["OPENAI_API_KEY"].present);
        assert!(matches!(
            store.entry("OPENAI_API_KEY").unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        // Deleting a missing entry is not an error.
        delete(&store, "MINIMAX_API_KEY").unwrap();
    }

    #[test]
    fn keyring_store_rejects_unknown_names_and_bad_values() {
        let store = mock_keyring();
        assert!(set(&store, "PATH", "x").is_err());
        assert!(set(&store, "GEMINI_API_KEY", "legacy-value-1234").is_err());
        assert!(set(&store, "OPENAI_API_KEY", "line one\nline two").is_err());
        assert!(set(&store, "OPENAI_API_KEY", "").is_err());
        assert!(delete(&store, "GOOGLE_DRIVE_CLIENT_ID").is_err());
        assert!(present(&store).is_empty());
    }

    #[test]
    fn keyring_errors_surface_without_values_and_are_not_cached() {
        let store = mock_keyring();
        let entry = store.entry("GEMINI_API_KEY_PROD").unwrap();
        let mock: &keyring::mock::MockCredential = entry.get_credential().downcast_ref().unwrap();
        mock.set_error(keyring::Error::PlatformFailure("access denied".into()));
        let failed = &status(&store)["GEMINI_API_KEY_PROD"];
        assert!(!failed.present);
        assert!(failed.error.as_deref().unwrap().contains("access denied"));
        // The mock error is consumed by the failed read; the next call retries.
        set(&store, "GEMINI_API_KEY_PROD", "AIza-prod-key-5678").unwrap();
        assert_eq!(
            status(&store)["GEMINI_API_KEY_PROD"].hint.as_deref(),
            Some("…5678")
        );
    }

    #[test]
    fn present_never_exports_unknown_names() {
        // Even a store holding other names (written outside the validated
        // path) only yields the managed names; the legacy GEMINI_API_KEY is
        // never one of them.
        let store = MemorySecretStore::default();
        store.set("GEMINI_API_KEY", "legacy-value").unwrap();
        store.set("PATH", "/evil").unwrap();
        store.set("MINIMAX_API_KEY", "mm-key-12345678").unwrap();
        assert_eq!(
            present(&store),
            vec![("MINIMAX_API_KEY".to_string(), "mm-key-12345678".to_string())]
        );
    }
}
