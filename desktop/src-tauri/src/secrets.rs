//! API keys and the Google Drive client secret.
//!
//! Feature 03 ships a session-only, in-memory store behind the `SecretStore`
//! trait: nothing is persisted and the OS keychain is never touched. Feature 04
//! replaces `MemorySecretStore` with a keyring-backed store (service
//! `wardrobe`) and keeps the trait, the name list and the command shapes.
//! Values never travel back to the frontend: only presence and a hint.

use std::collections::BTreeMap;
use std::sync::Mutex;

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
}

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Session-only store (Feature 03 stub). Lost when the app quits.
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
            let value = store.get(name).ok().flatten().filter(|v| !v.is_empty());
            let status = SecretStatus {
                present: value.is_some(),
                hint: value.as_deref().map(hint),
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
                hint: Some("…1234".into())
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
}
