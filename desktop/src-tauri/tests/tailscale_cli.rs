//! Opt-in check against the Tailscale installed on this machine. Read-only:
//! it runs `tailscale status --json` and `tailscale serve status --json`
//! only, never `serve` or `off`, and prints no names or addresses.
//!
//! cargo test --test tailscale_cli -- --ignored --nocapture

use std::time::Duration;

use wardrobe_desktop_lib::tailscale::{self, CliRunner, ProcessCli, TailscaleState};

#[test]
#[ignore = "needs a local Tailscale install; read-only"]
fn reads_the_installed_tailscale_read_only() {
    let Some(path) = tailscale::locate_installed_cli() else {
        println!("Tailscale not found: nothing to check");
        return;
    };
    let cli = ProcessCli { path };
    let version = cli
        .run(&["version".to_string()], Duration::from_secs(10))
        .expect("tailscale version");
    println!(
        "tailscale {}",
        version.stdout.lines().next().unwrap_or("?").trim()
    );

    let status = tailscale::query_status(Some(&cli), 5173, false, None);
    println!(
        "state {:?}, backend {:?}, online {}, MagicDNS {}, HTTPS certificates {}, served {}, other target {}, funnel {}, message {:?}",
        status.state,
        status.backend_state,
        status.online,
        status.magic_dns,
        status.https,
        status.served,
        status.serve_target.is_some(),
        status.funnel,
        status.message
    );
    assert_ne!(status.state, TailscaleState::NotInstalled);
    if status.state == TailscaleState::Connected {
        let name = status
            .dns_name
            .as_deref()
            .expect("a connected client has a DNS name");
        assert!(!name.ends_with('.') && name.contains('.'));
        assert_eq!(
            status.url.as_deref(),
            Some(format!("https://{name}/").as_str())
        );
    }
}
