use std::fs;
use std::path::Path;

// The app manifest makes every command below require an explicit permission,
// so only windows listed in a capability (capabilities/control.json: the
// `control` window) can call them. The `wardrobe` window gets none.
const COMMANDS: &[&str] = &[
    "server_state",
    "server_restart",
    "server_logs",
    "open_wardrobe",
    "open_in_browser",
    "get_config",
    "set_config",
    "autostart_get",
    "autostart_set",
    "secret_status",
    "secret_set",
    "secret_delete",
    "app_info",
    "server_health",
    "data_import",
    "cache_status",
    "cache_clear_models",
    "pick_directory",
    "reveal_location",
    "open_help",
    "update_state",
    "update_check",
    "update_install",
    "update_skip",
    "tailscale_status",
    "tailscale_enable",
    "tailscale_disable",
    "tailscale_url",
    "tailscale_health",
];

const PLACEHOLDER: &str = "Placeholder written by build.rs for debug builds. Run `npm run prepare:app` in desktop/ to produce the real file.\n";
/// The real Node binary is tens of megabytes; anything this small is a placeholder.
const MIN_NODE_BYTES: u64 = 1024 * 1024;

/// `bundle.externalBin` and `bundle.resources` must exist at compile time,
/// even for `tauri dev` and `cargo test`, which never use them (debug builds
/// run `node` from PATH against the repo). Debug builds get placeholders when
/// `prepare.mjs` has not run; release builds refuse to compile without the
/// real sidecar, so an installer can never ship without it.
fn ensure_sidecar_inputs() {
    let target = std::env::var("TARGET").expect("TARGET");
    let release = std::env::var("PROFILE")
        .map(|p| p == "release")
        .unwrap_or(false);
    let exe = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let node = format!("binaries/node-{target}{exe}");
    let server = "resources/server/server.cjs";
    let node_modules = "resources/server/node_modules";
    let web = "resources/web/index.html";
    for path in [
        "binaries",
        "resources/server",
        "resources/web",
        node.as_str(),
    ] {
        println!("cargo:rerun-if-changed={path}");
    }

    if release {
        let node_ok = fs::metadata(&node)
            .map(|m| m.len() >= MIN_NODE_BYTES)
            .unwrap_or(false);
        let missing: Vec<&str> = [
            (node.as_str(), node_ok),
            (server, Path::new(server).is_file()),
            (node_modules, Path::new(node_modules).is_dir()),
            (web, Path::new(web).is_file()),
        ]
        .into_iter()
        .filter(|(_, ok)| !ok)
        .map(|(path, _)| path)
        .collect();
        if !missing.is_empty() {
            panic!(
                "release build without the Node sidecar: missing or placeholder {}. Run `npm run prepare:app -- --target {target}` in desktop/ first.",
                missing.join(", ")
            );
        }
        return;
    }

    if !Path::new(&node).exists() {
        fs::create_dir_all("binaries").expect("create binaries/");
        fs::write(&node, PLACEHOLDER).expect("write the placeholder sidecar");
    }
    for dir in ["resources/server", "resources/web"] {
        let empty = fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true);
        if empty {
            fs::create_dir_all(dir).expect("create the resources placeholder");
            fs::write(Path::new(dir).join("PLACEHOLDER.txt"), PLACEHOLDER)
                .expect("write the resources placeholder");
        }
    }
}

fn main() {
    ensure_sidecar_inputs();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
