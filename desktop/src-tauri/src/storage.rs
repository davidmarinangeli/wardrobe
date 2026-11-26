//! Cache folders the server writes (Feature 02): the background-removal model
//! in `<cache>/transformers` and drape portraits in `<cache>/drapes`.
//!
//! Only those two folders are measured or cleared. On Windows the default
//! cache directory also holds Tauri's `logs\` and WebView2's `EBWebView\`, so
//! the cache directory itself is never deleted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const TRANSFORMERS_DIR: &str = "transformers";
pub const DRAPES_DIR: &str = "drapes";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CacheFolder {
    pub path: PathBuf,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CacheStatus {
    pub cache_dir: PathBuf,
    /// The background-removal model (about 470 MB once downloaded).
    pub transformers: CacheFolder,
    /// Drape portraits, regenerated on demand.
    pub drapes: CacheFolder,
}

/// Total size of the regular files under `path`. Symbolic links are not
/// followed; unreadable entries are skipped.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn folder(path: PathBuf) -> CacheFolder {
    CacheFolder {
        exists: path.is_dir(),
        bytes: dir_size(&path),
        path,
    }
}

pub fn cache_status(cache_dir: &Path) -> CacheStatus {
    CacheStatus {
        cache_dir: cache_dir.to_path_buf(),
        transformers: folder(cache_dir.join(TRANSFORMERS_DIR)),
        drapes: folder(cache_dir.join(DRAPES_DIR)),
    }
}

/// Deletes `<cache>/transformers` (the next background removal downloads the
/// model again). Nothing else in the cache directory is touched.
pub fn clear_model_cache(cache_dir: &Path) -> Result<(), String> {
    let path = cache_dir.join(TRANSFORMERS_DIR);
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot delete {}: {error}", path.display())),
    }
}

/// True when `data_dir` holds only the skeleton a fresh server writes:
/// `library.json` is an empty array and `imported/` holds no file. The server
/// creates that skeleton on its first start, so without this check every first
/// import into the app's data directory would be refused as "already holds a
/// wardrobe". The panel then imports with `--replace`, which still moves the
/// skeleton to a `before-import` backup instead of deleting it.
///
/// Anything the user may have added before importing keeps the Replace
/// prompt: a non-empty `outfits.json`, `inspo.json`, `wishlist.json` or
/// `cheat-sheets.json`, a model reference photo, or a Google Drive connection
/// (`.google-drive/`).
pub fn is_empty_wardrobe(data_dir: &Path) -> bool {
    if !is_empty_array(&data_dir.join("library.json")) {
        return false;
    }
    let catalogs_empty = USER_CATALOGS.iter().all(|name| {
        let path = data_dir.join(name);
        !path.exists() || is_empty_array(&path)
    });
    let user_files = fs::read_dir(data_dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                name.starts_with("model-reference") || name == ".google-drive"
            })
        })
        .unwrap_or(true);
    catalogs_empty && !user_files && !has_files(&data_dir.join("imported"))
}

/// Catalogs besides `library.json` that hold what the user made.
const USER_CATALOGS: [&str; 4] = [
    "outfits.json",
    "inspo.json",
    "wishlist.json",
    "cheat-sheets.json",
];

fn is_empty_array(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    matches!(
        serde_json::from_str::<serde_json::Value>(&text),
        Ok(serde_json::Value::Array(items)) if items.is_empty()
    )
}

fn has_files(path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|entry| match entry.file_type() {
        Ok(kind) if kind.is_dir() => has_files(&entry.path()),
        Ok(_) => true,
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_fresh_server_skeleton() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        assert!(
            !is_empty_wardrobe(data),
            "no library.json: not a wardrobe at all"
        );
        fs::write(data.join("library.json"), "[]\n").unwrap();
        fs::create_dir_all(data.join("imported")).unwrap();
        fs::create_dir_all(data.join("jobs")).unwrap();
        fs::write(data.join("archive-metadata.json"), "{}").unwrap();
        assert!(is_empty_wardrobe(data));
        fs::write(data.join("imported/a.png"), b"").unwrap();
        assert!(
            !is_empty_wardrobe(data),
            "an imported file, even empty, counts"
        );
        fs::remove_file(data.join("imported/a.png")).unwrap();
        // Content the user may add before any piece keeps the Replace prompt.
        fs::write(data.join("outfits.json"), "[]").unwrap();
        assert!(
            is_empty_wardrobe(data),
            "an empty catalog is still a skeleton"
        );
        fs::write(data.join("wishlist.json"), "[{\"id\":\"w\"}]").unwrap();
        assert!(!is_empty_wardrobe(data), "a wishlist entry counts");
        fs::remove_file(data.join("wishlist.json")).unwrap();
        fs::write(data.join("model-reference.png"), b"png").unwrap();
        assert!(!is_empty_wardrobe(data), "a model reference counts");
        fs::remove_file(data.join("model-reference.png")).unwrap();
        fs::create_dir_all(data.join(".google-drive")).unwrap();
        assert!(!is_empty_wardrobe(data), "a Drive connection counts");
        fs::remove_dir_all(data.join(".google-drive")).unwrap();
        assert!(is_empty_wardrobe(data));
        fs::write(data.join("library.json"), "[{\"id\":\"x\"}]").unwrap();
        assert!(!is_empty_wardrobe(data));
        fs::write(data.join("library.json"), "{ not json").unwrap();
        assert!(!is_empty_wardrobe(data));
    }

    #[test]
    fn sizes_and_clears_only_the_model_cache() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path();
        let model = cache.join("transformers/onnx-community/BiRefNet/onnx");
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("model.onnx"), vec![0u8; 1000]).unwrap();
        fs::write(cache.join("transformers/config.json"), b"{}").unwrap();
        fs::create_dir_all(cache.join("drapes")).unwrap();
        fs::write(cache.join("drapes/portrait.png"), vec![0u8; 300]).unwrap();
        fs::create_dir_all(cache.join("logs")).unwrap();
        fs::write(cache.join("logs/server.log"), b"keep me").unwrap();

        let status = cache_status(cache);
        assert_eq!(status.transformers.bytes, 1002);
        assert!(status.transformers.exists);
        assert_eq!(status.drapes.bytes, 300);

        clear_model_cache(cache).unwrap();
        let status = cache_status(cache);
        assert!(!status.transformers.exists);
        assert_eq!(status.transformers.bytes, 0);
        assert_eq!(status.drapes.bytes, 300, "drapes are kept");
        assert!(cache.join("logs/server.log").is_file(), "logs are kept");
        // Clearing twice is fine.
        clear_model_cache(cache).unwrap();
    }
}
