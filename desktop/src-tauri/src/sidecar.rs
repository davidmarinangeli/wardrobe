//! The Node sidecar: builds the server command line and environment, spawns
//! it, waits for readiness, keeps a log ring buffer plus a rotating
//! `server.log`, adopts an already running Wardrobe server on the port,
//! restarts and stops it.
//!
//! Nothing here depends on Tauri, so the whole lifecycle is covered by Rust
//! tests that run the real `scripts/server.mjs` with `node` from PATH.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::config::DesktopConfig;

pub const READY_LINE: &str = "READY";
pub const LOG_CAPACITY: usize = 500;
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Lines attached to a `Failed` state.
pub const FAILED_TAIL_LINES: usize = 40;
pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Inherited variables removed before the shell adds its own: the server's
/// locations and allowed hosts come from flags only, and `NODE_OPTIONS` could
/// inject code or flags into the sidecar.
pub const STRIPPED_ENV_KEYS: [&str; 5] = [
    "NODE_OPTIONS",
    "WARDROBE_DATA_DIR",
    "WARDROBE_CACHE_DIR",
    "WARDROBE_ALLOWED_HOSTS",
    "WARDROBE_MANAGED_CONFIG",
];

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub ready_timeout: Duration,
    pub stop_timeout: Duration,
    /// Readiness and exit polling interval (`/api/health` every 250 ms).
    pub poll: Duration,
    /// Health polling interval for an adopted server.
    pub adopted_poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(30),
            stop_timeout: Duration::from_secs(10),
            poll: Duration::from_millis(250),
            adopted_poll: Duration::from_secs(2),
        }
    }
}

/// What the control panel and the tray show. Serialized as
/// `{ "state": "running", "port": 5173, ... }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerState {
    Stopped,
    Starting {
        port: u16,
    },
    Running {
        port: u16,
        url: String,
        /// `None` for an adopted server we did not start.
        pid: Option<u32>,
        version: String,
        managed: bool,
        data_dir: String,
        cache_dir: String,
        /// True when another Wardrobe server of the same version already
        /// listened on the port and the app uses it instead of its own.
        adopted: bool,
    },
    Failed {
        port: u16,
        reason: String,
        last_lines: Vec<String>,
    },
}

impl ServerState {
    pub fn label(&self) -> String {
        match self {
            ServerState::Stopped => "Stopped".into(),
            ServerState::Starting { .. } => "Starting…".into(),
            ServerState::Running {
                port,
                adopted: false,
                ..
            } => format!("Running on port {port}"),
            ServerState::Running {
                port,
                adopted: true,
                ..
            } => format!("Running on port {port} (external server)"),
            ServerState::Failed { .. } => "Failed".into(),
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self, ServerState::Running { .. })
    }

    pub fn running_port(&self) -> Option<u16> {
        match self {
            ServerState::Running { port, .. } => Some(*port),
            _ => None,
        }
    }
}

/// `GET /api/health` (Feature 01, `managed` from Feature 02).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub managed: bool,
    pub pid: Option<u32>,
    pub uptime: Option<u64>,
}

// ---------------------------------------------------------------------------
// Command line and environment
// ---------------------------------------------------------------------------

/// Where the server script, its root and the built web app live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerLayout {
    /// Release builds: the packaged sidecar Node runs `<resources>/server/server.cjs`.
    Bundled { resource_dir: PathBuf },
    /// Debug builds (`tauri dev`): `node` from PATH runs the repo's `scripts/server.mjs`.
    Dev { repo_root: PathBuf },
}

impl ServerLayout {
    pub fn script(&self) -> PathBuf {
        match self {
            ServerLayout::Bundled { resource_dir } => {
                resource_dir.join("server").join("server.cjs")
            }
            ServerLayout::Dev { repo_root } => repo_root.join("scripts").join("server.mjs"),
        }
    }
    pub fn root(&self) -> PathBuf {
        match self {
            ServerLayout::Bundled { resource_dir } => resource_dir.join("server"),
            ServerLayout::Dev { repo_root } => repo_root.clone(),
        }
    }
    pub fn dist(&self) -> PathBuf {
        match self {
            ServerLayout::Bundled { resource_dir } => resource_dir.join("web"),
            ServerLayout::Dev { repo_root } => repo_root.join("dist"),
        }
    }
    pub fn mode(&self) -> &'static str {
        match self {
            ServerLayout::Bundled { .. } => "bundled",
            ServerLayout::Dev { .. } => "dev",
        }
    }
    /// A human-readable problem when the files the server needs are missing.
    pub fn check(&self) -> Result<(), String> {
        let script = self.script();
        if !script.is_file() {
            return Err(match self {
                ServerLayout::Bundled { .. } => format!(
                    "The server bundle is missing ({}). Reinstall Wardrobe.",
                    script.display()
                ),
                ServerLayout::Dev { .. } => format!("{} not found.", script.display()),
            });
        }
        let index = self.dist().join("index.html");
        if !index.is_file() {
            return Err(match self {
                ServerLayout::Bundled { .. } => format!(
                    "The web app is missing ({}). Reinstall Wardrobe.",
                    index.display()
                ),
                ServerLayout::Dev { .. } => format!(
                    "{} not found. Run `npm run build` at the repo root once.",
                    index.display()
                ),
            });
        }
        Ok(())
    }
}

/// Everything needed to start the server once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub port: u16,
    pub args: Vec<OsString>,
    /// The complete environment (the command is spawned with `env_clear`).
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

pub struct LaunchInputs<'a> {
    pub layout: &'a ServerLayout,
    pub config: &'a DesktopConfig,
    pub data_dir: &'a Path,
    pub cache_dir: &'a Path,
    pub cwd: &'a Path,
    pub inherited_env: Vec<(String, String)>,
    pub secrets: Vec<(String, String)>,
}

pub fn build_args(
    layout: &ServerLayout,
    port: u16,
    data_dir: &Path,
    cache_dir: &Path,
    allowed_hosts: &[String],
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        layout.script().into_os_string(),
        "--port".into(),
        port.to_string().into(),
        "--host".into(),
        LOOPBACK_HOST.into(),
        "--root".into(),
        layout.root().into_os_string(),
        "--dist".into(),
        layout.dist().into_os_string(),
        "--data-dir".into(),
        data_dir.as_os_str().to_owned(),
        "--cache-dir".into(),
        cache_dir.as_os_str().to_owned(),
        // stdin is a pipe the shell closes to stop the server gracefully.
        "--watch-stdin".into(),
        "on".into(),
    ];
    if !allowed_hosts.is_empty() {
        args.push("--allowed-hosts".into());
        args.push(allowed_hosts.join(",").into());
    }
    args
}

fn same_key(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Sets `key`, replacing any existing entry with the same name (case-insensitive on Windows).
fn put(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    env.retain(|existing, _| !same_key(existing, key));
    env.insert(key.to_string(), value.to_string());
}

/// The sidecar environment: the inherited environment without
/// `STRIPPED_ENV_KEYS`, then `WARDROBE_MANAGED_CONFIG=1`, the non-secret
/// overrides in order, `AI_PROVIDER` when configured, and every present secret.
pub fn build_env(
    inherited: Vec<(String, String)>,
    config: &DesktopConfig,
    secrets: &[(String, String)],
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (key, value) in inherited {
        if key.is_empty()
            || STRIPPED_ENV_KEYS
                .iter()
                .any(|stripped| same_key(stripped, &key))
        {
            continue;
        }
        put(&mut env, &key, &value);
    }
    put(&mut env, "WARDROBE_MANAGED_CONFIG", "1");
    for entry in &config.overrides {
        put(&mut env, &entry.key, &entry.value);
    }
    if let Some(provider) = &config.provider {
        put(&mut env, "AI_PROVIDER", provider);
    }
    for (name, value) in secrets {
        put(&mut env, name, value);
    }
    env
}

pub fn build_launch(inputs: LaunchInputs<'_>) -> LaunchSpec {
    let config = inputs.config;
    LaunchSpec {
        port: config.port,
        args: build_args(
            inputs.layout,
            config.port,
            inputs.data_dir,
            inputs.cache_dir,
            &config.allowed_hosts,
        ),
        env: build_env(inputs.inherited_env, config, &inputs.secrets),
        cwd: inputs.cwd.to_path_buf(),
    }
}

// ---------------------------------------------------------------------------
// Port and health probes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortStatus {
    Free,
    /// Something accepts connections on the port.
    InUse,
    /// The OS refuses to bind it (reserved range, permissions).
    Unavailable(String),
}

/// Tries to bind the loopback port and releases it at once. A listener on
/// `127.0.0.1` or `[::1]` (where `localhost` may resolve) counts as in use.
pub fn port_status(port: u16) -> PortStatus {
    let timeout = Duration::from_millis(300);
    for addr in [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ] {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return PortStatus::InUse;
        }
    }
    match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => {
            drop(listener);
            PortStatus::Free
        }
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => PortStatus::InUse,
        Err(error) => PortStatus::Unavailable(error.to_string()),
    }
}

/// `GET http://127.0.0.1:<port>/api/health`, `None` on any failure.
pub fn probe_health(port: u16, timeout: Duration) -> Option<Health> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    // HTTP/1.0: the server closes the connection and never uses chunked encoding.
    let request = format!("GET /api/health HTTP/1.0\r\nHost: {LOOPBACK_HOST}:{port}\r\nAccept: application/json\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.take(1024 * 1024).read_to_end(&mut response).ok()?;
    parse_health_response(&response)
}

pub fn parse_health_response(response: &[u8]) -> Option<Health> {
    let text = std::str::from_utf8(response).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    let mut parts = status.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") || parts.next()? != "200" {
        return None;
    }
    let health: Health = serde_json::from_str(body.trim()).ok()?;
    health.ok.then_some(health)
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogLine {
    /// UTC, RFC 3339 with seconds.
    pub time: String,
    /// `out`, `err` (server stdout/stderr) or `app` (the shell's own notes).
    pub stream: String,
    pub text: String,
}

impl LogLine {
    pub fn display(&self) -> String {
        format!("{} {} | {}", self.time, self.stream, self.text)
    }
}

struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    fn write_line(&mut self, line: &str) {
        let bytes = line.len() as u64 + 1;
        if self.file.is_some() && self.size > 0 && self.size + bytes > self.max_bytes {
            self.file = None; // close before renaming (Windows)
            let rotated = rotated_path(&self.path);
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&self.path, &rotated);
        }
        if self.file.is_none() {
            if let Some(parent) = self.path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
            {
                Ok(file) => {
                    self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    self.file = Some(file);
                }
                Err(_) => return,
            }
            if self.size > 0 && self.size + bytes > self.max_bytes {
                // An old file already over the limit: rotate it first.
                self.file = None;
                let rotated = rotated_path(&self.path);
                let _ = fs::remove_file(&rotated);
                let _ = fs::rename(&self.path, &rotated);
                return self.write_line(line);
            }
        }
        if let Some(file) = self.file.as_mut() {
            if writeln!(file, "{line}").is_ok() {
                self.size += bytes;
            }
        }
    }
}

/// `server.log` → `server.log.1`.
pub fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

/// The last `capacity` lines in memory, everything appended to a file that
/// rotates once at `max_bytes` (one previous file is kept).
pub struct LogBuffer {
    capacity: usize,
    lines: Mutex<VecDeque<LogLine>>,
    file: Mutex<Option<RotatingFile>>,
}

impl LogBuffer {
    pub fn new(capacity: usize, file: Option<PathBuf>, max_bytes: u64) -> Self {
        Self {
            capacity,
            lines: Mutex::new(VecDeque::with_capacity(capacity)),
            file: Mutex::new(file.map(|path| RotatingFile {
                path,
                max_bytes,
                file: None,
                size: 0,
            })),
        }
    }

    pub fn push(&self, stream: &str, text: &str) {
        let line = LogLine {
            time: utc_timestamp(SystemTime::now()),
            stream: stream.to_string(),
            text: text.to_string(),
        };
        if let Some(file) = lock(&self.file).as_mut() {
            file.write_line(&line.display());
        }
        let mut lines = lock(&self.lines);
        while lines.len() >= self.capacity {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn app(&self, text: &str) {
        self.push("app", text);
    }

    /// The most recent `limit` lines (all of them when `None`), oldest first.
    pub fn lines(&self, limit: Option<usize>) -> Vec<LogLine> {
        let lines = lock(&self.lines);
        let skip = limit.map(|n| lines.len().saturating_sub(n)).unwrap_or(0);
        lines.iter().skip(skip).cloned().collect()
    }

    pub fn tail(&self, limit: usize) -> Vec<String> {
        self.lines(Some(limit))
            .iter()
            .map(|l| format!("{}: {}", l.stream, l.text))
            .collect()
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` without a date crate.
pub fn utc_timestamp(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/// Builds the base command for the Node binary (program only; the manager
/// adds arguments, environment and stdio).
pub type CommandFactory = Box<dyn Fn() -> Command + Send + Sync>;
pub type StateListener = Arc<dyn Fn(&ServerState) + Send + Sync>;

struct OwnedChild {
    child: Child,
    readers: Vec<JoinHandle<()>>,
}

impl OwnedChild {
    fn join_readers(&mut self) {
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

struct Inner {
    state: Mutex<ServerState>,
    child: Mutex<Option<OwnedChild>>,
    /// Bumped by every start and stop; background threads of an older run exit.
    generation: AtomicU64,
    /// Serializes start, stop and restart.
    op: Mutex<()>,
    logs: LogBuffer,
    listener: Mutex<Option<StateListener>>,
    factory: CommandFactory,
    expected_version: String,
    timing: Timing,
}

#[derive(Clone)]
pub struct SidecarManager {
    inner: Arc<Inner>,
}

impl SidecarManager {
    pub fn new(
        factory: CommandFactory,
        expected_version: impl Into<String>,
        logs: LogBuffer,
        timing: Timing,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(ServerState::Stopped),
                child: Mutex::new(None),
                generation: AtomicU64::new(0),
                op: Mutex::new(()),
                logs,
                listener: Mutex::new(None),
                factory,
                expected_version: expected_version.into(),
                timing,
            }),
        }
    }

    /// Called after every state change, from whichever thread made it.
    pub fn set_listener(&self, listener: StateListener) {
        *lock(&self.inner.listener) = Some(listener);
    }

    pub fn state(&self) -> ServerState {
        lock(&self.inner.state).clone()
    }

    pub fn logs(&self) -> &LogBuffer {
        &self.inner.logs
    }

    /// The pid of the child this manager owns, if any.
    pub fn child_pid(&self) -> Option<u32> {
        lock(&self.inner.child)
            .as_ref()
            .map(|owned| owned.child.id())
    }

    fn set_state(&self, state: ServerState) {
        *lock(&self.inner.state) = state.clone();
        let listener = lock(&self.inner.listener).clone();
        if let Some(listener) = listener {
            listener(&state);
        }
    }

    fn current_generation(&self) -> u64 {
        self.inner.generation.load(Ordering::SeqCst)
    }

    /// Records a failure (also used by the shell when it cannot even try to start).
    pub fn fail(&self, port: u16, reason: String) -> ServerState {
        self.inner.logs.app(&format!("server failed: {reason}"));
        let state = ServerState::Failed {
            port,
            reason,
            last_lines: self.inner.logs.tail(FAILED_TAIL_LINES),
        };
        self.set_state(state.clone());
        state
    }

    /// Starts the server and blocks until it is ready, failed, or a `stop()`
    /// interrupts it. Does nothing but return the state if it already runs.
    pub fn start(&self, spec: &LaunchSpec) -> ServerState {
        let _op = lock(&self.inner.op);
        if self.state().is_running() {
            return self.state();
        }
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let port = spec.port;
        let timing = self.inner.timing;
        self.set_state(ServerState::Starting { port });
        self.inner
            .logs
            .app(&format!("starting the server on {LOOPBACK_HOST}:{port}"));

        match port_status(port) {
            PortStatus::Free => {}
            PortStatus::Unavailable(error) => {
                return self.fail(
                    port,
                    format!(
                        "Port {port} cannot be used ({error}). Choose another port in Settings."
                    ),
                );
            }
            PortStatus::InUse => {
                return match probe_health(port, Duration::from_secs(2)) {
                    Some(health) if health.version == self.inner.expected_version => {
                        self.inner.logs.app(&format!(
                            "port {port} already serves Wardrobe {} (pid {}); using that server",
                            health.version,
                            health.pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())
                        ));
                        let state = running_state(port, None, &health, true);
                        self.set_state(state.clone());
                        self.watch_adopted(generation, port);
                        state
                    }
                    Some(health) => self.fail(
                        port,
                        format!(
                            "Port {port} is in use by another Wardrobe server (version {}, this app is {}). Stop it or choose another port in Settings.",
                            health.version, self.inner.expected_version
                        ),
                    ),
                    None => self.fail(port, format!("Port {port} is in use by another program. Stop it or choose another port in Settings.")),
                };
            }
        }

        let mut command = (self.inner.factory)();
        command
            .args(&spec.args)
            .env_clear()
            .envs(&spec.env)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return self.fail(port, format!("Could not start the server process: {error}"))
            }
        };
        let pid = child.id();
        self.inner
            .logs
            .app(&format!("server process started (pid {pid})"));

        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(self.spawn_reader("out", stdout, Some(ready_tx)));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(self.spawn_reader("err", stderr, None));
        }
        *lock(&self.inner.child) = Some(OwnedChild { child, readers });

        let deadline = Instant::now() + timing.ready_timeout;
        let mut ready = false;
        loop {
            if self.current_generation() != generation {
                // stop() was called; it owns the child from here.
                return self.state();
            }
            match ready_rx.recv_timeout(timing.poll) {
                Ok(()) => ready = true,
                Err(mpsc::RecvTimeoutError::Timeout)
                | Err(mpsc::RecvTimeoutError::Disconnected) => {}
            }
            if !ready && probe_health(port, Duration::from_millis(500)).is_some() {
                ready = true;
            }
            if ready {
                break;
            }
            if let Some(status) = self.reap_if_exited() {
                return self.fail(
                    port,
                    format!(
                        "The server exited before it was ready ({})",
                        describe_exit(status)
                    ),
                );
            }
            if Instant::now() >= deadline {
                self.kill_owned();
                return self.fail(
                    port,
                    format!(
                        "The server did not become ready within {} s",
                        timing.ready_timeout.as_secs()
                    ),
                );
            }
        }

        let health = (0..8).find_map(|attempt| {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(125));
            }
            probe_health(port, Duration::from_secs(1))
        });
        let health = health.unwrap_or_else(|| Health {
            ok: true,
            version: self.inner.expected_version.clone(),
            ..Default::default()
        });
        let state = running_state(port, Some(pid), &health, false);
        self.inner
            .logs
            .app(&format!("server ready on {}", url_for(port)));
        self.set_state(state.clone());
        self.watch_child(generation, port);
        state
    }

    /// Stops the owned server: closes its stdin, waits up to the stop timeout,
    /// then kills it. An adopted server is left running. Ends in `Stopped`.
    pub fn stop(&self) -> ServerState {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let _op = lock(&self.inner.op);
        let owned = lock(&self.inner.child).take();
        if let Some(mut owned) = owned {
            let pid = owned.child.id();
            self.inner
                .logs
                .app(&format!("stopping the server (pid {pid})"));
            drop(owned.child.stdin.take());
            let deadline = Instant::now() + self.inner.timing.stop_timeout;
            loop {
                match owned.child.try_wait() {
                    Ok(Some(status)) => {
                        self.inner
                            .logs
                            .app(&format!("server stopped ({})", describe_exit(status)));
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(50))
                    }
                    _ => {
                        let _ = owned.child.kill();
                        let status = owned.child.wait();
                        self.inner.logs.app(&format!(
                            "server killed after {} s ({})",
                            self.inner.timing.stop_timeout.as_secs(),
                            status.map(describe_exit).unwrap_or_else(|e| e.to_string())
                        ));
                        break;
                    }
                }
            }
            owned.join_readers();
        }
        self.set_state(ServerState::Stopped);
        ServerState::Stopped
    }

    /// The single entry point for configuration changes: stop, then start with the new spec.
    pub fn restart(&self, spec: &LaunchSpec) -> ServerState {
        self.stop();
        self.start(spec)
    }

    fn spawn_reader<R: Read + Send + 'static>(
        &self,
        stream: &'static str,
        source: R,
        ready: Option<mpsc::Sender<()>>,
    ) -> JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        thread::spawn(move || {
            let mut reader = BufReader::new(source);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buffer);
                        let line = line.trim_end_matches(['\r', '\n']);
                        inner.logs.push(stream, line);
                        if line == READY_LINE {
                            if let Some(ready) = &ready {
                                let _ = ready.send(());
                            }
                        }
                    }
                }
            }
        })
    }

    /// If the owned child has exited, removes it and returns its status.
    fn reap_if_exited(&self) -> Option<ExitStatus> {
        let mut slot = lock(&self.inner.child);
        let status = slot
            .as_mut()
            .and_then(|owned| owned.child.try_wait().ok().flatten())?;
        let mut owned = slot.take()?;
        drop(slot);
        owned.join_readers();
        Some(status)
    }

    fn kill_owned(&self) {
        let owned = lock(&self.inner.child).take();
        if let Some(mut owned) = owned {
            let _ = owned.child.kill();
            let _ = owned.child.wait();
            owned.join_readers();
        }
    }

    fn watch_child(&self, generation: u64, port: u16) {
        let manager = self.clone();
        thread::spawn(move || loop {
            thread::sleep(manager.inner.timing.poll);
            if manager.current_generation() != generation {
                return;
            }
            if let Some(status) = manager.reap_if_exited() {
                if manager.current_generation() == generation {
                    manager.fail(
                        port,
                        format!(
                            "The server stopped unexpectedly ({})",
                            describe_exit(status)
                        ),
                    );
                }
                return;
            }
        });
    }

    fn watch_adopted(&self, generation: u64, port: u16) {
        let manager = self.clone();
        thread::spawn(move || {
            let mut failures = 0;
            let mut last_probe = Instant::now();
            loop {
                thread::sleep(
                    manager
                        .inner
                        .timing
                        .poll
                        .min(manager.inner.timing.adopted_poll),
                );
                if manager.current_generation() != generation {
                    return;
                }
                if last_probe.elapsed() < manager.inner.timing.adopted_poll {
                    continue;
                }
                last_probe = Instant::now();
                if probe_health(port, Duration::from_secs(2)).is_some() {
                    failures = 0;
                    continue;
                }
                failures += 1;
                if failures >= 3 {
                    if manager.current_generation() == generation {
                        manager.fail(port, format!("The Wardrobe server on port {port}, started outside the app, stopped"));
                    }
                    return;
                }
            }
        });
    }
}

/// The address shown to people and loaded by the window. `localhost` (not
/// `127.0.0.1`) because the Google Drive redirect URI and the same-origin checks
/// assume `http://localhost:<port>`.
pub fn url_for(port: u16) -> String {
    format!("http://localhost:{port}/")
}

fn running_state(port: u16, pid: Option<u32>, health: &Health, adopted: bool) -> ServerState {
    ServerState::Running {
        port,
        url: url_for(port),
        pid,
        version: health.version.clone(),
        managed: health.managed,
        data_dir: health.data_dir.clone(),
        cache_dir: health.cache_dir.clone(),
        adopted,
    }
}

fn describe_exit(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("exit code {code}"),
        None => format!("{status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OverrideEntry;

    #[test]
    fn args_for_both_layouts() {
        let bundled = ServerLayout::Bundled {
            resource_dir: PathBuf::from("/app/res"),
        };
        let args = build_args(
            &bundled,
            5173,
            Path::new("/u/data"),
            Path::new("/u/cache"),
            &[],
        );
        let args: Vec<String> = args
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let res = PathBuf::from("/app/res");
        assert_eq!(
            args,
            vec![
                res.join("server").join("server.cjs").display().to_string(),
                "--port".into(),
                "5173".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--root".into(),
                res.join("server").display().to_string(),
                "--dist".into(),
                res.join("web").display().to_string(),
                "--data-dir".into(),
                "/u/data".into(),
                "--cache-dir".into(),
                "/u/cache".into(),
                "--watch-stdin".into(),
                "on".into(),
            ]
        );
        let dev = ServerLayout::Dev {
            repo_root: PathBuf::from("/repo"),
        };
        let args = build_args(
            &dev,
            5174,
            Path::new("/d"),
            Path::new("/c"),
            &[".ts.net".into(), "mac.example".into()],
        );
        let args: Vec<String> = args
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args[0],
            PathBuf::from("/repo")
                .join("scripts")
                .join("server.mjs")
                .display()
                .to_string()
        );
        assert_eq!(args[6], "/repo");
        assert_eq!(
            args[8],
            PathBuf::from("/repo").join("dist").display().to_string()
        );
        assert_eq!(
            &args[args.len() - 2..],
            ["--allowed-hosts", ".ts.net,mac.example"]
        );
    }

    #[test]
    fn environment_assembly() {
        let config = DesktopConfig {
            provider: Some("gemini".into()),
            overrides: vec![
                OverrideEntry {
                    key: "GEMINI_IMAGE_MODEL".into(),
                    value: "gemini-3-pro-image".into(),
                },
                OverrideEntry {
                    key: "OPENAI_IMAGE_ROUTE".into(),
                    value: "responses".into(),
                },
            ],
            ..Default::default()
        };
        let inherited = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("NODE_OPTIONS".to_string(), "--require evil.js".to_string()),
            ("WARDROBE_DATA_DIR".to_string(), "/repo/data".to_string()),
            (
                "WARDROBE_ALLOWED_HOSTS".to_string(),
                "evil.example".to_string(),
            ),
            ("WARDROBE_MANAGED_CONFIG".to_string(), "0".to_string()),
            ("GEMINI_IMAGE_MODEL".to_string(), "old".to_string()),
            ("AI_PROVIDER".to_string(), "openai".to_string()),
        ];
        let secrets = vec![("GEMINI_API_KEY_TEST".to_string(), "test-key".to_string())];
        let env = build_env(inherited, &config, &secrets);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
        assert!(!env.contains_key("NODE_OPTIONS"));
        assert!(!env.contains_key("WARDROBE_DATA_DIR"));
        assert!(!env.contains_key("WARDROBE_ALLOWED_HOSTS"));
        assert_eq!(env["WARDROBE_MANAGED_CONFIG"], "1");
        assert_eq!(env["GEMINI_IMAGE_MODEL"], "gemini-3-pro-image");
        assert_eq!(env["OPENAI_IMAGE_ROUTE"], "responses");
        assert_eq!(env["AI_PROVIDER"], "gemini");
        assert_eq!(env["GEMINI_API_KEY_TEST"], "test-key");
        assert!(
            !env.contains_key("GEMINI_API_KEY"),
            "the legacy name is never written"
        );

        // Without a configured provider the inherited one passes through.
        let env = build_env(
            vec![("AI_PROVIDER".into(), "minimax".into())],
            &DesktopConfig::default(),
            &[],
        );
        assert_eq!(env["AI_PROVIDER"], "minimax");
    }

    #[cfg(windows)]
    #[test]
    fn environment_keys_are_case_insensitive_on_windows() {
        let env = build_env(
            vec![
                ("Path".into(), "C:\\bin".into()),
                ("node_options".into(), "--x".into()),
            ],
            &DesktopConfig {
                overrides: vec![OverrideEntry {
                    key: "PATH".into(),
                    value: "C:\\other".into(),
                }],
                ..Default::default()
            },
            &[],
        );
        assert!(!env.keys().any(|k| k.eq_ignore_ascii_case("NODE_OPTIONS")));
        let paths: Vec<_> = env
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("PATH"))
            .collect();
        assert_eq!(paths.len(), 1);
        assert_eq!(env["PATH"], "C:\\other");
    }

    #[test]
    fn launch_spec_uses_config_port() {
        let layout = ServerLayout::Dev {
            repo_root: PathBuf::from("/repo"),
        };
        let config = DesktopConfig {
            port: 5190,
            ..Default::default()
        };
        let spec = build_launch(LaunchInputs {
            layout: &layout,
            config: &config,
            data_dir: Path::new("/d"),
            cache_dir: Path::new("/c"),
            cwd: Path::new("/d"),
            inherited_env: vec![],
            secrets: vec![],
        });
        assert_eq!(spec.port, 5190);
        assert!(spec.args.iter().any(|a| a == "5190"));
        assert_eq!(spec.cwd, PathBuf::from("/d"));
    }

    #[test]
    fn health_response_parsing() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"version\":\"1.0.0\",\"dataDir\":\"/d\",\"cacheDir\":\"/c\",\"managed\":true,\"pid\":42,\"uptime\":3}";
        let health = parse_health_response(ok).unwrap();
        assert_eq!(health.version, "1.0.0");
        assert_eq!(health.data_dir, "/d");
        assert!(health.managed);
        assert_eq!(health.pid, Some(42));
        assert!(parse_health_response(b"HTTP/1.1 404 Not Found\r\n\r\n{\"ok\":true}").is_none());
        assert!(parse_health_response(b"HTTP/1.1 200 OK\r\n\r\n<html>").is_none());
        assert!(parse_health_response(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":false}").is_none());
    }

    #[test]
    fn state_serialization() {
        let state = ServerState::Failed {
            port: 5173,
            reason: "port in use".into(),
            last_lines: vec!["err: x".into()],
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "failed", "port": 5173, "reason": "port in use", "lastLines": ["err: x"] })
        );
        let json = serde_json::to_value(&ServerState::Stopped).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "stopped" }));
        let running = running_state(
            5173,
            Some(7),
            &Health {
                ok: true,
                version: "1.0.0".into(),
                data_dir: "/d".into(),
                ..Default::default()
            },
            false,
        );
        let json = serde_json::to_value(&running).unwrap();
        assert_eq!(json["state"], "running");
        assert_eq!(json["dataDir"], "/d");
        assert_eq!(json["url"], "http://localhost:5173/");
        assert_eq!(running.label(), "Running on port 5173");
    }

    #[test]
    fn log_ring_buffer_keeps_the_last_lines() {
        let logs = LogBuffer::new(3, None, LOG_ROTATE_BYTES);
        for i in 0..5 {
            logs.push("out", &format!("line {i}"));
        }
        let lines = logs.lines(None);
        assert_eq!(
            lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            ["line 2", "line 3", "line 4"]
        );
        assert_eq!(
            logs.tail(2),
            vec!["out: line 3".to_string(), "out: line 4".to_string()]
        );
        assert_eq!(logs.lines(Some(10)).len(), 3);
    }

    #[test]
    fn log_file_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("server.log");
        let logs = LogBuffer::new(10, Some(path.clone()), 200);
        for i in 0..10 {
            logs.push("err", &format!("message number {i:02} with some padding"));
        }
        let current = fs::read_to_string(&path).unwrap();
        let rotated = fs::read_to_string(rotated_path(&path)).unwrap();
        assert!(
            current.len() <= 200,
            "current file is {} bytes",
            current.len()
        );
        assert!(current.contains("message number 09"));
        assert!(rotated.contains("err | message number"));
        assert!(!dir.path().join("logs").join("server.log.1.1").exists());
    }

    #[test]
    fn timestamps() {
        assert_eq!(utc_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            utc_timestamp(UNIX_EPOCH + Duration::from_secs(1_795_730_400)),
            "2026-11-26T22:00:00Z"
        );
        assert_eq!(
            utc_timestamp(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00Z"
        );
    }

    #[test]
    fn port_status_detects_listeners() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(port_status(port), PortStatus::InUse);
        drop(listener);
        assert_eq!(port_status(port), PortStatus::Free);
        assert!(probe_health(port, Duration::from_millis(200)).is_none());
    }

    #[test]
    fn layout_check_reports_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let layout = ServerLayout::Dev {
            repo_root: dir.path().to_path_buf(),
        };
        assert!(layout.check().unwrap_err().contains("server.mjs"));
        fs::create_dir_all(dir.path().join("scripts")).unwrap();
        fs::write(dir.path().join("scripts").join("server.mjs"), "").unwrap();
        assert!(layout.check().unwrap_err().contains("npm run build"));
        fs::create_dir_all(dir.path().join("dist")).unwrap();
        fs::write(dir.path().join("dist").join("index.html"), "").unwrap();
        assert!(layout.check().is_ok());
        let bundled = ServerLayout::Bundled {
            resource_dir: dir.path().to_path_buf(),
        };
        assert!(bundled.check().unwrap_err().contains("Reinstall"));
    }
}
