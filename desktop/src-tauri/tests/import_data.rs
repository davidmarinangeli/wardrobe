//! `import-data` through the same runner the control panel uses: `node` from
//! PATH runs the repo's `scripts/server.mjs import-data` (the debug-build
//! layout) on temporary folders. Without Node on PATH the test prints why and
//! passes vacuously.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use wardrobe_desktop_lib::config::DesktopConfig;
use wardrobe_desktop_lib::sidecar::{build_env, run_import_data, ImportOutcome, ServerLayout};

fn repo_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let canonical = std::fs::canonicalize(&root).unwrap_or(root);
    let text = canonical.to_string_lossy().to_string();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

fn node_available() -> bool {
    let ok = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("skipping: needs node on PATH");
    }
    ok
}

fn env() -> BTreeMap<String, String> {
    build_env(std::env::vars().collect(), &DesktopConfig::default(), &[])
}

#[test]
fn import_data_outcomes() {
    if !node_available() {
        return;
    }
    let layout = ServerLayout::Dev {
        repo_root: repo_root(),
    };
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("library.json"), "[]\n").unwrap();
    std::fs::write(source.join(".env"), "OPENAI_API_KEY=sk-must-not-travel\n").unwrap();
    let target = temp.path().join("app").join("data");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let run = |from: &PathBuf, replace: bool| {
        run_import_data(
            Command::new("node"),
            &layout,
            from,
            &target,
            replace,
            &env(),
            Duration::from_secs(120),
        )
    };

    // A fresh target: imported, secrets left behind.
    match run(&source, false) {
        ImportOutcome::Imported {
            files, backup, to, ..
        } => {
            assert_eq!(files, 1);
            assert_eq!(backup, None);
            assert_eq!(PathBuf::from(to), target);
        }
        other => panic!("expected imported, got {other:?}"),
    }
    assert!(target.join("library.json").is_file());
    assert!(!target.join(".env").exists(), ".env must not travel");

    // A populated target: refused until Replace.
    match run(&source, false) {
        ImportOutcome::TargetPopulated { message, .. } => {
            assert!(message.contains("already contains a wardrobe"), "{message}")
        }
        other => panic!("expected targetPopulated, got {other:?}"),
    }
    match run(&source, true) {
        ImportOutcome::Imported {
            backup: Some(backup),
            ..
        } => {
            assert!(backup.contains("before-import"), "{backup}");
            assert!(PathBuf::from(backup).join("library.json").is_file());
        }
        other => panic!("expected imported with a backup, got {other:?}"),
    }

    // Not a Wardrobe data folder: the validation errors come back.
    let empty = temp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    match run(&empty, false) {
        ImportOutcome::Failed {
            exit_code,
            code,
            errors,
            ..
        } => {
            assert_eq!(exit_code, Some(2));
            assert_eq!(code, "archive_invalid");
            assert!(
                errors.iter().any(|e| e.contains("No library.json")),
                "{errors:?}"
            );
        }
        other => panic!("expected failed, got {other:?}"),
    }
}
