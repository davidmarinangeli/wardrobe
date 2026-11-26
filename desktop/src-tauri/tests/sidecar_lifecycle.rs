//! Lifecycle tests against the real server: `node` from PATH runs the repo's
//! `scripts/server.mjs` (the debug-build layout) with temporary data and cache
//! directories. They need Node on PATH and a built `dist/` at the repo root
//! (`npm run build`); without them each test prints why and passes vacuously.

use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wardrobe_desktop_lib::config::DesktopConfig;
use wardrobe_desktop_lib::sidecar::{
    build_launch, port_status, probe_health, LaunchInputs, LaunchSpec, LogBuffer, PortStatus,
    ServerLayout, ServerState, SidecarManager, Timing,
};

fn repo_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let canonical = std::fs::canonicalize(&root).unwrap_or(root);
    let text = canonical.to_string_lossy().to_string();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

fn app_version() -> String {
    let text = std::fs::read_to_string(repo_root().join("package.json")).unwrap();
    serde_json::from_str::<serde_json::Value>(&text).unwrap()["version"]
        .as_str()
        .unwrap()
        .to_string()
}

fn prerequisites() -> bool {
    let node = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let dist = repo_root().join("dist").join("index.html").is_file();
    if !node || !dist {
        eprintln!(
            "skipping: needs node on PATH ({node}) and a built dist/ at the repo root ({dist})"
        );
    }
    node && dist
}

fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    cache: PathBuf,
    log: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&cache).unwrap();
    let log = dir.path().join("logs").join("server.log");
    Fixture {
        data,
        cache,
        log,
        _dir: dir,
    }
}

fn spec(fx: &Fixture, layout: &ServerLayout, port: u16) -> LaunchSpec {
    let config = DesktopConfig {
        port,
        ..Default::default()
    };
    build_launch(LaunchInputs {
        layout,
        config: &config,
        data_dir: &fx.data,
        cache_dir: &fx.cache,
        cwd: &fx.data,
        inherited_env: std::env::vars().collect(),
        secrets: vec![],
    })
}

fn manager(
    fx: &Fixture,
    version: &str,
    timing: Timing,
) -> (SidecarManager, Arc<Mutex<Vec<ServerState>>>) {
    let manager = SidecarManager::new(
        Box::new(|| Command::new("node")),
        version,
        LogBuffer::new(500, Some(fx.log.clone()), 5 * 1024 * 1024),
        timing,
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    manager.set_listener(Arc::new(move |state: &ServerState| {
        sink.lock().unwrap().push(state.clone())
    }));
    (manager, events)
}

fn dev_layout() -> ServerLayout {
    ServerLayout::Dev {
        repo_root: repo_root(),
    }
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn kill_externally(pid: u32) {
    let status = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .unwrap()
            .status
    } else {
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .unwrap()
            .status
    };
    assert!(status.success(), "could not kill {pid}");
}

fn wait_for(mut condition: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    condition()
}

fn same_path(a: &str, b: &Path) -> bool {
    let a = PathBuf::from(a);
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

#[test]
fn starts_reports_health_and_stops_cleanly() {
    if !prerequisites() {
        return;
    }
    let fx = fixture();
    let (manager, events) = manager(&fx, &app_version(), Timing::default());
    let port = free_port();
    let state = manager.start(&spec(&fx, &dev_layout(), port));
    let ServerState::Running {
        port: running_port,
        pid,
        version,
        managed,
        data_dir,
        cache_dir,
        adopted,
        url,
    } = state.clone()
    else {
        panic!(
            "expected running, got {state:?}\n{}",
            manager.logs().tail(40).join("\n")
        );
    };
    assert_eq!(running_port, port);
    assert_eq!(url, format!("http://localhost:{port}/"));
    assert!(managed, "WARDROBE_MANAGED_CONFIG=1 must reach the server");
    assert!(!adopted);
    assert_eq!(version, app_version());
    assert!(
        same_path(&data_dir, &fx.data),
        "{data_dir} vs {}",
        fx.data.display()
    );
    assert!(
        same_path(&cache_dir, &fx.cache),
        "{cache_dir} vs {}",
        fx.cache.display()
    );
    let pid = pid.expect("own child has a pid");
    assert!(process_alive(pid));
    let health = probe_health(port, Duration::from_secs(2)).expect("health answers");
    assert_eq!(health.pid, Some(pid));

    let lines = manager.logs().lines(None);
    assert!(
        lines.iter().any(|l| l.stream == "out" && l.text == "READY"),
        "READY is in the log"
    );
    let file = std::fs::read_to_string(&fx.log).unwrap();
    assert!(
        file.contains("out | READY"),
        "server.log gets the lines too"
    );

    let started = Instant::now();
    assert_eq!(manager.stop(), ServerState::Stopped);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "graceful stop through stdin, not the kill timeout"
    );
    assert!(
        wait_for(|| !process_alive(pid), Duration::from_secs(5)),
        "no node process left behind"
    );
    assert_eq!(port_status(port), PortStatus::Free);
    let stopped_line = manager
        .logs()
        .lines(None)
        .iter()
        .any(|l| l.text.contains("shutting down (stdin closed)"));
    assert!(
        stopped_line,
        "the server saw stdin close:\n{}",
        manager.logs().tail(10).join("\n")
    );
    let events = events.lock().unwrap();
    assert!(matches!(events.first(), Some(ServerState::Starting { .. })));
    assert!(events.iter().any(|e| e.is_running()));
    assert_eq!(events.last(), Some(&ServerState::Stopped));
}

#[test]
fn external_kill_flips_to_failed_with_last_lines() {
    if !prerequisites() {
        return;
    }
    let fx = fixture();
    let (manager, events) = manager(&fx, &app_version(), Timing::default());
    let port = free_port();
    let state = manager.start(&spec(&fx, &dev_layout(), port));
    assert!(state.is_running(), "{state:?}");
    let pid = manager.child_pid().unwrap();
    kill_externally(pid);
    assert!(
        wait_for(
            || matches!(manager.state(), ServerState::Failed { .. }),
            Duration::from_secs(5)
        ),
        "state: {:?}",
        manager.state()
    );
    let ServerState::Failed {
        reason, last_lines, ..
    } = manager.state()
    else {
        unreachable!()
    };
    assert!(reason.contains("stopped unexpectedly"), "{reason}");
    assert!(
        last_lines.iter().any(|l| l.contains("READY")),
        "{last_lines:?}"
    );
    assert!(
        matches!(
            events.lock().unwrap().last(),
            Some(ServerState::Failed { .. })
        ),
        "a server-state event is emitted"
    );
    // A restart from Failed works.
    let state = manager.restart(&spec(&fx, &dev_layout(), port));
    assert!(state.is_running(), "{state:?}");
    manager.stop();
}

#[test]
fn adopts_a_running_server_of_the_same_version_and_refuses_others() {
    if !prerequisites() {
        return;
    }
    let fx = fixture();
    let port = free_port();
    let (owner, _) = manager(&fx, &app_version(), Timing::default());
    assert!(owner.start(&spec(&fx, &dev_layout(), port)).is_running());
    let owner_pid = owner.child_pid().unwrap();

    let fx2 = fixture();
    let (adopter, _) = manager(&fx2, &app_version(), Timing::default());
    let state = adopter.start(&spec(&fx2, &dev_layout(), port));
    let ServerState::Running {
        adopted,
        pid,
        port: adopted_port,
        ..
    } = state.clone()
    else {
        panic!("{state:?}")
    };
    assert!(adopted);
    assert_eq!(pid, None);
    assert_eq!(adopted_port, port);
    assert_eq!(adopter.child_pid(), None, "no second server was spawned");
    // Stopping the adopter leaves the other server alone.
    adopter.stop();
    assert!(process_alive(owner_pid));
    assert!(probe_health(port, Duration::from_secs(2)).is_some());

    let (other_version, _) = manager(&fx2, "999.0.0", Timing::default());
    let state = other_version.start(&spec(&fx2, &dev_layout(), port));
    let ServerState::Failed { reason, .. } = state else {
        panic!("{state:?}")
    };
    assert!(
        reason.contains("another Wardrobe server") && reason.contains("999.0.0"),
        "{reason}"
    );

    owner.stop();
    assert!(wait_for(
        || !process_alive(owner_pid),
        Duration::from_secs(5)
    ));
}

#[test]
fn port_taken_by_another_program_fails_without_picking_another_port() {
    let fx = fixture();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    // Accept and drop connections so the health probe gets no HTTP answer.
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            drop(stream);
        }
    });
    let (manager, _) = manager(&fx, "1.0.0", Timing::default());
    let state = manager.start(&spec(&fx, &dev_layout(), port));
    let ServerState::Failed {
        reason,
        port: failed_port,
        ..
    } = state
    else {
        panic!("{state:?}")
    };
    assert_eq!(failed_port, port);
    assert!(reason.contains("in use by another program"), "{reason}");
    assert_eq!(manager.child_pid(), None);
}

#[test]
fn restart_moves_to_a_new_port() {
    if !prerequisites() {
        return;
    }
    let fx = fixture();
    let (manager, _) = manager(&fx, &app_version(), Timing::default());
    let first = free_port();
    assert!(manager.start(&spec(&fx, &dev_layout(), first)).is_running());
    let first_pid = manager.child_pid().unwrap();
    let second = free_port();
    let state = manager.restart(&spec(&fx, &dev_layout(), second));
    assert_eq!(state.running_port(), Some(second), "{state:?}");
    assert!(wait_for(
        || !process_alive(first_pid),
        Duration::from_secs(5)
    ));
    assert_eq!(port_status(first), PortStatus::Free);
    manager.stop();
}

#[test]
fn startup_failure_reports_the_server_error() {
    if !prerequisites() {
        return;
    }
    let fx = fixture();
    // A repo root whose dist/ has no index.html: server.mjs exits with code 1.
    let fake_root = tempfile::tempdir().unwrap();
    let layout = dev_layout();
    let mut launch = spec(&fx, &layout, free_port());
    let dist_index = launch.args.iter().position(|a| a == "--dist").unwrap() + 1;
    launch.args[dist_index] = fake_root.path().join("dist").into_os_string();
    let (manager, _) = manager(&fx, &app_version(), Timing::default());
    let state = manager.start(&launch);
    let ServerState::Failed {
        reason, last_lines, ..
    } = state
    else {
        panic!("{state:?}")
    };
    assert!(
        reason.contains("exited before it was ready") && reason.contains("exit code 1"),
        "{reason}"
    );
    assert!(
        last_lines
            .iter()
            .any(|l| l.contains("wardrobe-server failed to start")),
        "{last_lines:?}"
    );
}

#[test]
fn ready_timeout_kills_the_process() {
    let node = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !node {
        eprintln!("skipping: needs node on PATH");
        return;
    }
    let fx = fixture();
    let timing = Timing {
        ready_timeout: Duration::from_secs(2),
        ..Timing::default()
    };
    let (manager, _) = manager(&fx, "1.0.0", timing);
    let launch = LaunchSpec {
        port: free_port(),
        args: vec![
            "-e".into(),
            "console.log('never ready'); setInterval(() => {}, 1000)".into(),
        ],
        env: std::env::vars().collect(),
        cwd: fx.data.clone(),
    };
    let started = Instant::now();
    let state = manager.start(&launch);
    let ServerState::Failed {
        reason, last_lines, ..
    } = state
    else {
        panic!("{state:?}")
    };
    assert!(
        reason.contains("did not become ready within 2 s"),
        "{reason}"
    );
    assert!(
        last_lines.iter().any(|l| l.contains("never ready")),
        "{last_lines:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(
        manager.child_pid(),
        None,
        "the process was killed and reaped"
    );
}

#[test]
fn stop_interrupts_a_start_that_is_still_waiting() {
    let node = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !node {
        return;
    }
    let fx = fixture();
    let (manager, _) = manager(&fx, "1.0.0", Timing::default());
    let launch = LaunchSpec {
        port: free_port(),
        args: vec![
            "-e".into(),
            "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))".into(),
        ],
        env: std::env::vars().collect(),
        cwd: fx.data.clone(),
    };
    let starter = manager.clone();
    let handle = std::thread::spawn(move || starter.start(&launch));
    assert!(wait_for(
        || manager.child_pid().is_some(),
        Duration::from_secs(5)
    ));
    let pid = manager.child_pid().unwrap();
    let started = Instant::now();
    assert_eq!(manager.stop(), ServerState::Stopped);
    handle.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "did not wait for the 30 s ready timeout"
    );
    assert!(wait_for(|| !process_alive(pid), Duration::from_secs(5)));
    assert_eq!(manager.state(), ServerState::Stopped);
}
