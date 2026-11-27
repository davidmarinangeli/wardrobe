//! Remote access through Tailscale (Feature 07).
//!
//! `tailscale serve --bg --https=443 http://127.0.0.1:<port>` publishes the
//! sidecar, which always binds `127.0.0.1`, at `https://<machine>.<tailnet>.ts.net`
//! for the devices of the same tailnet. Being in the tailnet is the only
//! authentication; nothing is ever bound to `0.0.0.0` and Funnel (public
//! internet) is never turned on.
//!
//! This module has no Tauri dependency (the tests borrow
//! `tauri::async_runtime::block_on` only): the CLI is reached through the
//! `CliRunner` trait (a real process in the app, a script in the tests), and
//! the JSON the CLI prints is parsed by pure functions tested against
//! fixtures in `fixtures/tailscale/`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// Overrides where the CLI is looked for (a full path). For tests and unusual installs.
pub const CLI_ENV: &str = "WARDROBE_DESKTOP_TAILSCALE";
pub const DOWNLOAD_URL: &str = "https://tailscale.com/download";
/// Admin console page with the MagicDNS and HTTPS Certificates switches.
pub const ADMIN_DNS_URL: &str = "https://login.tailscale.com/admin/dns";
/// The macOS app's bundled CLI (App Store and standalone builds).
pub const MACOS_APP_CLI: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/// The HTTPS port `tailscale serve` listens on for us.
pub const HTTPS_PORT: u16 = 443;
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// `tailscale serve` can block while it waits for HTTPS to be enabled in the
/// tailnet (it prints an approval URL and polls); it is stopped after this.
pub const SERVE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the panel waits for `https://<name>/api/health` after enabling:
/// the first request can trigger the certificate issuance.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
pub const HEALTH_INTERVAL: Duration = Duration::from_secs(2);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Locating and running the CLI
// ---------------------------------------------------------------------------

/// The candidate CLI paths, in order, for `os` (`std::env::consts::OS`).
/// `lookup` reads environment variables (`CLI_ENV`, `ProgramFiles`, `PATH`).
pub fn cli_candidates(os: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    if let Some(path) = lookup(CLI_ENV).filter(|p| !p.trim().is_empty()) {
        return vec![PathBuf::from(path.trim())];
    }
    let mut candidates = Vec::new();
    let exe = match os {
        "macos" => {
            candidates.push(PathBuf::from(MACOS_APP_CLI));
            "tailscale"
        }
        "windows" => {
            let program_files =
                lookup("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".to_string());
            candidates.push(
                Path::new(&program_files)
                    .join("Tailscale")
                    .join("tailscale.exe"),
            );
            let default = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
            if !candidates.contains(&default) {
                candidates.push(default);
            }
            "tailscale.exe"
        }
        _ => "tailscale",
    };
    if let Some(path) = lookup("PATH") {
        for dir in std::env::split_paths(&path) {
            if !dir.as_os_str().is_empty() {
                candidates.push(dir.join(exe));
            }
        }
    }
    candidates
}

/// The first candidate that is a file, or `None` ("Tailscale not found").
pub fn locate_cli(
    os: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    cli_candidates(os, lookup).into_iter().find(|p| is_file(p))
}

/// `locate_cli` for this machine.
pub fn locate_installed_cli() -> Option<PathBuf> {
    locate_cli(
        std::env::consts::OS,
        &|name| std::env::var(name).ok(),
        &|path| path.is_file(),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// The process was still running at the timeout and was killed.
    pub timed_out: bool,
}

impl CliOutput {
    /// stderr and stdout together, trimmed, for messages.
    pub fn text(&self) -> String {
        let mut text = self.stderr.trim().to_string();
        let out = self.stdout.trim();
        if !out.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(out);
        }
        text
    }
}

/// Runs the Tailscale CLI. The app uses `ProcessCli`; tests script the answers.
pub trait CliRunner: Send + Sync {
    fn run(&self, args: &[String], timeout: Duration) -> Result<CliOutput, String>;
    /// Where the CLI is, for the panel. `None` for test runners.
    fn path(&self) -> Option<&Path> {
        None
    }
}

/// The real CLI. stdin is closed, stdout and stderr are captured, and on
/// Windows no console window flashes.
pub struct ProcessCli {
    pub path: PathBuf,
}

/// How long to wait for the output pipes after the process ended. A
/// grandchild that inherited them (none is expected from the Tailscale CLI)
/// must not hang the caller.
const PIPE_GRACE: Duration = Duration::from_secs(2);

fn drain<R: Read + Send + 'static>(mut reader: R) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

impl CliRunner for ProcessCli {
    fn run(&self, args: &[String], timeout: Duration) -> Result<CliOutput, String> {
        let mut command = Command::new(&self.path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot run {}: {e}", self.path.display()))?;
        let stdout = child.stdout.take().map(drain);
        let stderr = child.stderr.take().map(drain);
        let deadline = Instant::now() + timeout;
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() >= deadline => {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok();
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("{}: {error}", self.path.display()));
                }
            }
        };
        let pipes_deadline = Instant::now() + PIPE_GRACE;
        let collect = |rx: Option<Receiver<String>>| {
            rx.and_then(|rx| {
                rx.recv_timeout(pipes_deadline.saturating_duration_since(Instant::now()))
                    .ok()
            })
            .unwrap_or_default()
        };
        Ok(CliOutput {
            success: !timed_out && status.map(|s| s.success()).unwrap_or(false),
            code: status.and_then(|s| s.code()),
            stdout: collect(stdout),
            stderr: collect(stderr),
            timed_out,
        })
    }

    fn path(&self) -> Option<&Path> {
        Some(&self.path)
    }
}

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

pub fn status_args() -> Vec<String> {
    strings(&["status", "--json"])
}

pub fn serve_status_args() -> Vec<String> {
    strings(&["serve", "status", "--json"])
}

/// `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. `--bg` keeps
/// the rule in Tailscale's preferences, across reboots and app restarts.
pub fn serve_enable_args(port: u16) -> Vec<String> {
    vec![
        "serve".into(),
        "--bg".into(),
        format!("--https={HTTPS_PORT}"),
        local_target(port),
    ]
}

/// `tailscale serve --https=443 off`.
pub fn serve_disable_args() -> Vec<String> {
    vec![
        "serve".into(),
        format!("--https={HTTPS_PORT}"),
        "off".into(),
    ]
}

/// The proxy target: always the loopback address the sidecar binds.
pub fn local_target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// `https://<dns name>/`.
pub fn remote_url(dns_name: &str) -> String {
    format!("https://{dns_name}/")
}

// ---------------------------------------------------------------------------
// Parsing `tailscale status --json` and `tailscale serve status --json`
// ---------------------------------------------------------------------------

/// What the panel needs from `tailscale status --json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TailnetInfo {
    /// `Running`, `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting`, `NoState`.
    pub backend_state: String,
    /// `Self.DNSName` without the trailing dot, lower-cased.
    pub dns_name: Option<String>,
    /// `Self.Online`.
    pub online: bool,
    /// `CurrentTailnet.MagicDNSEnabled`.
    pub magic_dns: bool,
    /// HTTPS certificates are enabled for this machine: its DNS name is in
    /// `CertDomains` (null while HTTPS is off in the admin console).
    pub https: bool,
    /// `CurrentTailnet.Name`.
    pub tailnet: Option<String>,
    /// `Health` warnings.
    pub health: Vec<String>,
}

impl TailnetInfo {
    pub fn running(&self) -> bool {
        self.backend_state == "Running"
    }
}

/// A non-empty, trimmed JSON string.
fn text(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub fn parse_status(json: &str) -> Result<TailnetInfo, String> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| format!("tailscale status printed unexpected output ({e})"))?;
    let backend_state = text(&value["BackendState"])
        .ok_or("tailscale status printed no BackendState")?
        .to_string();
    let this = &value["Self"];
    let dns_name =
        text(&this["DNSName"]).map(|name| name.trim_end_matches('.').to_ascii_lowercase());
    let dns_name = dns_name.filter(|name| !name.is_empty());
    let https = match (&dns_name, value["CertDomains"].as_array()) {
        (Some(name), Some(domains)) => domains
            .iter()
            .filter_map(Value::as_str)
            .any(|d| d.trim_end_matches('.').eq_ignore_ascii_case(name)),
        _ => false,
    };
    let health = value["Health"]
        .as_array()
        .map(|items| items.iter().filter_map(text).map(str::to_string).collect())
        .unwrap_or_default();
    Ok(TailnetInfo {
        backend_state,
        dns_name,
        online: this["Online"].as_bool().unwrap_or(false),
        magic_dns: value["CurrentTailnet"]["MagicDNSEnabled"]
            .as_bool()
            .unwrap_or(false),
        https,
        tailnet: text(&value["CurrentTailnet"]["Name"]).map(str::to_string),
        health,
    })
}

/// What `tailscale serve status --json` says about port 443 on this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServeInfo {
    /// The proxy target of the `/` handler on `<name>:443`, when there is one.
    pub target: Option<String>,
    /// That target is the sidecar: `http://127.0.0.1:<port>` (or `localhost`).
    pub served: bool,
    /// Funnel (public internet) is on for `<name>:443`.
    pub funnel: bool,
}

/// Parses the serve config (`{}` when nothing is served). `dns_name` picks the
/// `Web` entry; without it any `*:443` entry is used.
pub fn parse_serve_status(
    json: &str,
    dns_name: Option<&str>,
    port: u16,
) -> Result<ServeInfo, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(ServeInfo::default());
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("tailscale serve status printed unexpected output ({e})"))?;
    let suffix = format!(":{HTTPS_PORT}");
    let matches = |key: &str| match dns_name {
        Some(name) => key.eq_ignore_ascii_case(&format!("{name}{suffix}")),
        None => key.ends_with(&suffix),
    };
    let mut info = ServeInfo::default();
    if let Some(web) = value["Web"].as_object() {
        if let Some((_, site)) = web.iter().find(|(key, _)| matches(key)) {
            info.target = site["Handlers"]["/"]["Proxy"].as_str().map(str::to_string);
        }
    }
    info.served = info
        .target
        .as_deref()
        .and_then(local_proxy_port)
        .is_some_and(|p| p == port);
    if let Some(funnel) = value["AllowFunnel"].as_object() {
        info.funnel = funnel
            .iter()
            .any(|(key, on)| matches(key) && on.as_bool().unwrap_or(false));
    }
    Ok(info)
}

/// The port of a proxy target on this machine (`http://127.0.0.1:5173`,
/// `http://localhost:5173`, `127.0.0.1:5173`), or `None` for anything else.
pub fn local_proxy_port(target: &str) -> Option<u16> {
    let rest = target.trim();
    let rest = rest.strip_prefix("http://").unwrap_or(rest);
    let rest = rest.trim_end_matches('/');
    let (host, port) = rest.rsplit_once(':')?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return None;
    }
    port.parse().ok()
}

/// The first `https://login.tailscale.com/…` URL in the CLI output: the page
/// `tailscale serve` asks the user to open when HTTPS is off for the tailnet.
pub fn approval_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | '<' | '>' | ',' | '.'))
        })
        .find(|token| token.starts_with("https://login.tailscale.com/"))
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Status for the panel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TailscaleState {
    /// No CLI found.
    NotInstalled,
    /// The CLI runs but cannot reach the Tailscale service.
    Unavailable,
    /// Tailscale is installed and logged in but turned off.
    Stopped,
    /// Not logged in (or the machine waits for approval).
    LoggedOut,
    /// Starting up.
    Starting,
    /// Running: `dnsName` is the machine's tailnet name.
    Connected,
}

/// The Remote access screen's model (camelCase JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub state: TailscaleState,
    /// Remote access is on in Wardrobe's config.
    pub enabled: bool,
    /// The CLI used.
    pub cli: Option<String>,
    pub backend_state: Option<String>,
    pub dns_name: Option<String>,
    pub tailnet: Option<String>,
    pub online: bool,
    pub magic_dns: bool,
    pub https: bool,
    /// `tailscale serve` points `https://<name>/` at this app's port.
    pub served: bool,
    /// What `https://<name>/` points at now, ours or not.
    pub serve_target: Option<String>,
    pub funnel: bool,
    /// The port the server listens on (127.0.0.1).
    pub port: u16,
    /// The tailnet name recorded when remote access was turned on.
    pub remote_host: Option<String>,
    /// `https://<name>/`: the recorded name while enabled, otherwise the
    /// current one (what enabling would publish).
    pub url: Option<String>,
    pub health: Vec<String>,
    /// A problem worth showing (CLI error, a warning after disabling).
    pub message: Option<String>,
    pub download_url: String,
    pub admin_url: String,
}

impl RemoteStatus {
    pub fn new(state: TailscaleState, port: u16, enabled: bool, remote_host: Option<&str>) -> Self {
        Self {
            state,
            enabled,
            cli: None,
            backend_state: None,
            dns_name: None,
            tailnet: None,
            online: false,
            magic_dns: false,
            https: false,
            served: false,
            serve_target: None,
            funnel: false,
            port,
            remote_host: remote_host.map(str::to_string),
            url: if enabled {
                remote_host.map(remote_url)
            } else {
                None
            },
            health: Vec::new(),
            message: None,
            download_url: DOWNLOAD_URL.into(),
            admin_url: ADMIN_DNS_URL.into(),
        }
    }
}

fn state_for(backend_state: &str) -> TailscaleState {
    match backend_state {
        "Running" => TailscaleState::Connected,
        "Stopped" => TailscaleState::Stopped,
        "Starting" => TailscaleState::Starting,
        _ => TailscaleState::LoggedOut,
    }
}

/// A short reason for a failed `tailscale status`.
fn describe_status_failure(output: &CliOutput) -> String {
    let text = output.text();
    let lower = text.to_ascii_lowercase();
    if output.timed_out {
        "Tailscale did not answer within 10 s.".into()
    } else if lower.contains("tailscaled")
        || lower.contains("doesn't appear to be running")
        || lower.contains("connect")
    {
        "Tailscale is installed but its service is not running. Open the Tailscale app.".into()
    } else if text.is_empty() {
        format!(
            "tailscale status failed (exit code {}).",
            output.code.unwrap_or(-1)
        )
    } else {
        format!("tailscale status failed: {}", first_lines(&text, 3))
    }
}

fn first_lines(text: &str, n: usize) -> String {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runs `tailscale status --json` and parses it.
pub fn read_status(cli: &dyn CliRunner) -> Result<TailnetInfo, String> {
    let output = cli.run(&status_args(), STATUS_TIMEOUT)?;
    // `status --json` prints the state even when logged out; a non-zero exit
    // with no JSON means the service could not be reached.
    match parse_status(&output.stdout) {
        Ok(info) => Ok(info),
        Err(_) if !output.success => Err(describe_status_failure(&output)),
        Err(error) => Err(error),
    }
}

/// Runs `tailscale serve status --json` and parses it.
pub fn read_serve(
    cli: &dyn CliRunner,
    dns_name: Option<&str>,
    port: u16,
) -> Result<ServeInfo, String> {
    let output = cli.run(&serve_status_args(), STATUS_TIMEOUT)?;
    if !output.success {
        return Err(format!(
            "tailscale serve status failed: {}",
            first_lines(&output.text(), 3)
        ));
    }
    parse_serve_status(&output.stdout, dns_name, port)
}

/// The full status for the panel. `cli` is `None` when Tailscale is not installed.
pub fn query_status(
    cli: Option<&dyn CliRunner>,
    port: u16,
    enabled: bool,
    remote_host: Option<&str>,
) -> RemoteStatus {
    let Some(cli) = cli else {
        return RemoteStatus::new(TailscaleState::NotInstalled, port, enabled, remote_host);
    };
    let mut status = RemoteStatus::new(TailscaleState::Unavailable, port, enabled, remote_host);
    status.cli = cli.path().map(|p| p.display().to_string());
    let info = match read_status(cli) {
        Ok(info) => info,
        Err(message) => {
            status.message = Some(message);
            return status;
        }
    };
    status.state = state_for(&info.backend_state);
    status.backend_state = Some(info.backend_state.clone());
    status.online = info.online;
    status.magic_dns = info.magic_dns;
    status.https = info.https;
    status.tailnet = info.tailnet.clone();
    status.health = info.health.clone();
    if status.state == TailscaleState::Connected {
        status.dns_name = info.dns_name.clone();
        if status.url.is_none() {
            status.url = info.dns_name.as_deref().map(remote_url);
        }
        match read_serve(cli, info.dns_name.as_deref(), port) {
            Ok(serve) => {
                status.served = serve.served;
                status.serve_target = serve.target;
                status.funnel = serve.funnel;
            }
            Err(message) => status.message = Some(message),
        }
    }
    status
}

// ---------------------------------------------------------------------------
// Enable and disable
// ---------------------------------------------------------------------------

/// Checks the preconditions and returns the machine's tailnet name.
pub fn ready_dns_name(info: &TailnetInfo) -> Result<String, String> {
    match state_for(&info.backend_state) {
        TailscaleState::Connected => {}
        TailscaleState::Stopped => {
            return Err(
                "Tailscale is turned off. Turn it on in the Tailscale app, then try again.".into(),
            )
        }
        TailscaleState::Starting => {
            return Err("Tailscale is still starting. Try again in a moment.".into())
        }
        _ => {
            return Err(
                "Tailscale is not logged in. Log in from the Tailscale app, then try again.".into(),
            )
        }
    }
    if !info.magic_dns {
        return Err(
            "MagicDNS is off for your tailnet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page), then try again."
                .into(),
        );
    }
    info.dns_name
        .clone()
        .ok_or_else(|| "Tailscale reported no DNS name for this computer.".into())
}

/// Runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`.
pub fn serve(cli: &dyn CliRunner, port: u16) -> Result<(), String> {
    let output = cli.run(&serve_enable_args(port), SERVE_TIMEOUT)?;
    if output.success {
        return Ok(());
    }
    let text = output.text();
    if let Some(url) = approval_url(&text) {
        return Err(format!(
            "Tailscale needs HTTPS to be enabled for your tailnet before it can serve Wardrobe. Open {url} (or DNS › HTTPS Certificates in the admin console), enable it, then turn remote access on again."
        ));
    }
    if output.timed_out {
        return Err(format!(
            "tailscale serve did not finish within {} s.{}",
            SERVE_TIMEOUT.as_secs(),
            if text.is_empty() {
                String::new()
            } else {
                format!(" It printed: {}", first_lines(&text, 4))
            }
        ));
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("flag provided but not defined") {
        return Err("This Tailscale version is too old for `tailscale serve --bg`. Update Tailscale (1.52 or later), then try again.".into());
    }
    if lower.contains("access denied") || lower.contains("permission") {
        return Err(format!(
            "Tailscale refused to change its serve settings: {}",
            first_lines(&text, 3)
        ));
    }
    Err(format!(
        "tailscale serve failed{}",
        if text.is_empty() {
            format!(" (exit code {})", output.code.unwrap_or(-1))
        } else {
            format!(": {}", first_lines(&text, 4))
        }
    ))
}

/// Turns remote access on in Tailscale: status checks, `tailscale serve`,
/// then a re-read that the rule points at `port`. Returns the DNS name.
pub fn enable(cli: &dyn CliRunner, port: u16) -> Result<String, String> {
    let info = read_status(cli)?;
    let dns_name = ready_dns_name(&info)?;
    serve(cli, port)?;
    match read_serve(cli, Some(&dns_name), port) {
        Ok(serve) if serve.served => Ok(dns_name),
        Ok(serve) => Err(format!(
            "tailscale serve finished, but https://{dns_name}/ points at {} instead of {}.",
            serve.target.as_deref().unwrap_or("nothing"),
            local_target(port)
        )),
        // The rule was accepted; an unreadable status is not a failure.
        Err(_) => Ok(dns_name),
    }
}

/// Removes the rule with `tailscale serve --https=443 off`, but only when
/// port 443 points at this app (or the serve status cannot be read): a rule
/// someone else put there is left alone.
pub fn disable(cli: &dyn CliRunner, dns_name: Option<&str>, port: u16) -> Result<(), String> {
    match read_serve(cli, dns_name, port) {
        Ok(serve) if !serve.served => return Ok(()),
        _ => {}
    }
    let output = cli.run(&serve_disable_args(), STATUS_TIMEOUT)?;
    if output.success {
        Ok(())
    } else {
        Err(format!(
            "tailscale serve --https={HTTPS_PORT} off failed: {}",
            first_lines(&output.text(), 3)
        ))
    }
}

// ---------------------------------------------------------------------------
// Remote health
// ---------------------------------------------------------------------------

/// The result of polling `<url>api/health` from this computer through Tailscale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHealth {
    pub url: String,
    pub ok: bool,
    pub elapsed_ms: u64,
    pub attempts: u32,
    /// The last HTTP status, when an answer came back.
    pub status: Option<u16>,
    /// The server version from a successful answer.
    pub version: Option<String>,
    /// Why the last attempt failed.
    pub error: Option<String>,
}

/// What one attempt means: done (success or a failure that will not fix
/// itself) or worth retrying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    Healthy { version: Option<String> },
    Fatal(String),
    Retry(String),
}

/// Classifies an HTTP answer from `/api/health`.
pub fn classify_answer(status: u16, body: &str, port: u16) -> Attempt {
    match status {
        200 => match serde_json::from_str::<Value>(body) {
            Ok(value) if value["ok"].as_bool() == Some(true) => Attempt::Healthy {
                version: value["version"].as_str().map(str::to_string),
            },
            _ => Attempt::Retry("The address answered, but not with Wardrobe's health check.".into()),
        },
        403 if body.contains("host_not_allowed") => Attempt::Fatal(
            "Wardrobe refused the tailnet name. Restart the server from Status, then check again.".into(),
        ),
        502..=504 => Attempt::Retry(format!(
            "Tailscale answered, but Wardrobe did not (HTTP {status}). Is the server running on port {port}?"
        )),
        _ => Attempt::Retry(format!("Unexpected answer: HTTP {status}.")),
    }
}

fn describe_request_error(error: &reqwest::Error) -> String {
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        detail = format!("{detail}: {inner}");
        source = inner.source();
    }
    if error.is_timeout() {
        format!("The request timed out. The certificate may still be pending, or this computer is not reachable in the tailnet ({detail}).")
    } else if error.is_connect() {
        format!("Could not connect. The certificate may still be pending, or MagicDNS/HTTPS is off for the tailnet ({detail}).")
    } else {
        detail
    }
}

/// rustls needs a process-wide crypto provider; the updater plugin installs
/// the same one lazily, so whichever runs first wins.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Polls `<base_url>api/health` every `interval` until Wardrobe answers, a
/// fatal answer comes back, or `timeout` passes.
pub async fn probe_remote_health(
    base_url: &str,
    port: u16,
    timeout: Duration,
    interval: Duration,
) -> RemoteHealth {
    ensure_crypto_provider();
    let url = format!("{}/api/health", base_url.trim_end_matches('/'));
    let started = Instant::now();
    let mut health = RemoteHealth {
        url: url.clone(),
        ok: false,
        elapsed_ms: 0,
        attempts: 0,
        status: None,
        version: None,
        error: None,
    };
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            health.error = Some(error.to_string());
            return health;
        }
    };
    loop {
        health.attempts += 1;
        let attempt = match client
            .get(&url)
            .header("Cache-Control", "no-store")
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                health.status = Some(status);
                let body = response.text().await.unwrap_or_default();
                classify_answer(status, &body, port)
            }
            Err(error) => Attempt::Retry(describe_request_error(&error)),
        };
        health.elapsed_ms = started.elapsed().as_millis() as u64;
        match attempt {
            Attempt::Healthy { version } => {
                health.ok = true;
                health.version = version;
                health.error = None;
                return health;
            }
            Attempt::Fatal(message) => {
                health.error = Some(message);
                return health;
            }
            Attempt::Retry(message) => health.error = Some(message),
        }
        if started.elapsed() + interval >= timeout {
            return health;
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::Mutex;

    const LOGGED_OUT: &str = include_str!("../fixtures/tailscale/status-logged-out.json");
    const NO_MAGIC_DNS: &str = include_str!("../fixtures/tailscale/status-no-magicdns.json");
    const CONNECTED: &str = include_str!("../fixtures/tailscale/status-connected.json");
    const CONNECTED_NO_HTTPS: &str =
        include_str!("../fixtures/tailscale/status-connected-no-https.json");
    const SERVE_EMPTY: &str = include_str!("../fixtures/tailscale/serve-empty.json");
    const SERVE_OURS: &str = include_str!("../fixtures/tailscale/serve-wardrobe.json");
    const SERVE_OTHER: &str = include_str!("../fixtures/tailscale/serve-other.json");
    const NAME: &str = "wardrobe-mac.tail1234.ts.net";

    fn ok(stdout: &str) -> CliOutput {
        CliOutput {
            success: true,
            code: Some(0),
            stdout: stdout.into(),
            ..Default::default()
        }
    }

    fn fail(code: i32, stderr: &str) -> CliOutput {
        CliOutput {
            success: false,
            code: Some(code),
            stderr: stderr.into(),
            ..Default::default()
        }
    }

    /// Answers by the joined arguments and records every call.
    struct ScriptedCli {
        answers: Mutex<BTreeMap<String, Vec<CliOutput>>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptedCli {
        fn new(answers: &[(&str, CliOutput)]) -> Self {
            let mut map: BTreeMap<String, Vec<CliOutput>> = BTreeMap::new();
            for (args, output) in answers {
                map.entry(args.to_string())
                    .or_default()
                    .push(output.clone());
            }
            Self {
                answers: Mutex::new(map),
                calls: Mutex::new(Vec::new()),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CliRunner for ScriptedCli {
        fn run(&self, args: &[String], _timeout: Duration) -> Result<CliOutput, String> {
            let key = args.join(" ");
            self.calls.lock().unwrap().push(key.clone());
            let mut answers = self.answers.lock().unwrap();
            let queue = answers
                .get_mut(&key)
                .ok_or(format!("unexpected call: {key}"))?;
            // The last answer repeats.
            Ok(if queue.len() > 1 {
                queue.remove(0)
            } else {
                queue[0].clone()
            })
        }
    }

    #[test]
    fn parses_a_logged_out_client() {
        let info = parse_status(LOGGED_OUT).unwrap();
        assert_eq!(info.backend_state, "NeedsLogin");
        assert!(!info.running());
        assert_eq!(info.dns_name, None);
        assert!(!info.magic_dns && !info.https && !info.online);
        assert_eq!(state_for(&info.backend_state), TailscaleState::LoggedOut);
    }

    #[test]
    fn parses_a_client_without_magic_dns() {
        let info = parse_status(NO_MAGIC_DNS).unwrap();
        assert!(info.running());
        assert!(!info.magic_dns);
        assert!(!info.https);
        assert_eq!(info.dns_name.as_deref(), Some(NAME));
        assert_eq!(
            ready_dns_name(&info).unwrap_err(),
            "MagicDNS is off for your tailnet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page), then try again."
        );
    }

    #[test]
    fn parses_a_connected_client_with_its_dns_name() {
        let info = parse_status(CONNECTED).unwrap();
        assert!(info.running() && info.online && info.magic_dns && info.https);
        assert_eq!(
            info.dns_name.as_deref(),
            Some(NAME),
            "trailing dot stripped, lower-cased"
        );
        assert_eq!(info.tailnet.as_deref(), Some("example.github"));
        assert_eq!(ready_dns_name(&info).unwrap(), NAME);

        let no_https = parse_status(CONNECTED_NO_HTTPS).unwrap();
        assert!(
            no_https.magic_dns && !no_https.https,
            "CertDomains null means HTTPS certificates are off"
        );
        assert_eq!(
            no_https.health,
            vec!["Tailscale could not connect to the DERP relay".to_string()]
        );
    }

    #[test]
    fn rejects_unexpected_status_output() {
        assert!(parse_status("not json").is_err());
        assert!(parse_status("{}").is_err());
        let stopped =
            parse_status(r#"{"BackendState":"Stopped","Self":{"DNSName":"x.ts.net."}}"#).unwrap();
        assert_eq!(state_for(&stopped.backend_state), TailscaleState::Stopped);
        assert!(ready_dns_name(&stopped).unwrap_err().contains("turned off"));
    }

    #[test]
    fn parses_serve_status() {
        assert_eq!(
            parse_serve_status(SERVE_EMPTY, Some(NAME), 5173).unwrap(),
            ServeInfo::default()
        );
        assert_eq!(
            parse_serve_status("", Some(NAME), 5173).unwrap(),
            ServeInfo::default()
        );
        let ours = parse_serve_status(SERVE_OURS, Some(NAME), 5173).unwrap();
        assert_eq!(
            ours,
            ServeInfo {
                target: Some("http://127.0.0.1:5173".into()),
                served: true,
                funnel: false
            }
        );
        assert!(
            !parse_serve_status(SERVE_OURS, Some(NAME), 5174)
                .unwrap()
                .served,
            "another port is not ours"
        );
        assert!(parse_serve_status(SERVE_OURS, None, 5173).unwrap().served);
        assert!(
            !parse_serve_status(SERVE_OURS, Some("other.tail1234.ts.net"), 5173)
                .unwrap()
                .served
        );
        let other = parse_serve_status(SERVE_OTHER, Some(NAME), 5173).unwrap();
        assert_eq!(other.target.as_deref(), Some("http://127.0.0.1:3000"));
        assert!(!other.served);
        assert!(other.funnel);
        assert!(parse_serve_status("[", Some(NAME), 5173).is_err());
    }

    #[test]
    fn recognizes_local_proxy_targets() {
        assert_eq!(local_proxy_port("http://127.0.0.1:5173"), Some(5173));
        assert_eq!(local_proxy_port("http://localhost:5173/"), Some(5173));
        assert_eq!(local_proxy_port("127.0.0.1:5173"), Some(5173));
        assert_eq!(local_proxy_port("http://[::1]:5173"), Some(5173));
        assert_eq!(local_proxy_port("http://192.168.1.2:5173"), None);
        assert_eq!(local_proxy_port("https+insecure://127.0.0.1:5173"), None);
        assert_eq!(local_proxy_port("text:hello"), None);
    }

    #[test]
    fn builds_the_command_arguments() {
        assert_eq!(status_args(), ["status", "--json"]);
        assert_eq!(serve_status_args(), ["serve", "status", "--json"]);
        assert_eq!(
            serve_enable_args(5173),
            ["serve", "--bg", "--https=443", "http://127.0.0.1:5173"]
        );
        assert_eq!(serve_enable_args(5174)[3], "http://127.0.0.1:5174");
        assert_eq!(serve_disable_args(), ["serve", "--https=443", "off"]);
        assert_eq!(remote_url(NAME), format!("https://{NAME}/"));
        for args in [serve_enable_args(5173), serve_disable_args()] {
            assert!(!args
                .iter()
                .any(|a| a.contains("funnel") || a.contains("0.0.0.0")));
        }
    }

    #[test]
    fn locates_the_cli_per_platform() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        let mac = cli_candidates(
            "macos",
            &env(&[("PATH", "/usr/local/bin:/opt/homebrew/bin")]),
        );
        assert_eq!(mac[0], PathBuf::from(MACOS_APP_CLI));
        if cfg!(unix) {
            assert_eq!(mac[1], PathBuf::from("/usr/local/bin/tailscale"));
        }
        let win = cli_candidates("windows", &env(&[("ProgramFiles", r"D:\Apps")]));
        assert_eq!(
            win[0],
            Path::new(r"D:\Apps")
                .join("Tailscale")
                .join("tailscale.exe")
        );
        assert_eq!(
            win[1],
            PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe")
        );
        let overridden = cli_candidates("windows", &env(&[(CLI_ENV, "/opt/fake-tailscale")]));
        assert_eq!(overridden, vec![PathBuf::from("/opt/fake-tailscale")]);

        // The app bundle wins over PATH; a missing CLI is None.
        let found = locate_cli("macos", &env(&[("PATH", "/usr/bin")]), &|p| {
            p == Path::new(MACOS_APP_CLI)
        });
        assert_eq!(found, Some(PathBuf::from(MACOS_APP_CLI)));
        assert_eq!(locate_cli("windows", &env(&[]), &|_| false), None);
    }

    #[test]
    fn process_cli_captures_output_and_stops_at_the_timeout() {
        let (shell, flag) = if cfg!(windows) {
            ("cmd.exe", "/C")
        } else {
            ("sh", "-c")
        };
        let path = if cfg!(windows) {
            PathBuf::from(std::env::var("ComSpec").unwrap_or_else(|_| shell.into()))
        } else {
            PathBuf::from("/bin/sh")
        };
        let cli = ProcessCli { path };
        let echo = cli
            .run(
                &strings(&[flag, "echo serve-ok&& echo oops 1>&2"]),
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(echo.success, "{echo:?}");
        assert!(echo.stdout.contains("serve-ok"));
        assert!(echo.stderr.contains("oops"));
        assert!(echo.text().contains("oops"));

        let failed = cli
            .run(&strings(&[flag, "exit 3"]), Duration::from_secs(10))
            .unwrap();
        assert!(!failed.success);
        assert_eq!(failed.code, Some(3));

        let slow = if cfg!(windows) {
            "ping -n 6 127.0.0.1 >NUL"
        } else {
            "sleep 5"
        };
        let started = Instant::now();
        let stuck = cli
            .run(&strings(&[flag, slow]), Duration::from_millis(300))
            .unwrap();
        assert!(stuck.timed_out && !stuck.success, "{stuck:?}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "killed at the timeout"
        );

        let missing = ProcessCli {
            path: PathBuf::from("/definitely/not/tailscale"),
        };
        assert!(missing
            .run(&status_args(), Duration::from_secs(1))
            .unwrap_err()
            .contains("Cannot run"));
    }

    #[test]
    fn finds_the_approval_url() {
        let text = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n";
        assert_eq!(
            approval_url(text).as_deref(),
            Some("https://login.tailscale.com/f/serve?node=nABC123")
        );
        assert_eq!(approval_url("see https://example.com/f/serve"), None);
    }

    #[test]
    fn status_for_the_panel() {
        let missing = query_status(None, 5173, false, None);
        assert_eq!(missing.state, TailscaleState::NotInstalled);
        assert_eq!(missing.download_url, DOWNLOAD_URL);

        let down = ScriptedCli::new(&[(
            "status --json",
            fail(
                1,
                "failed to connect to local tailscaled; it doesn't appear to be running",
            ),
        )]);
        let status = query_status(Some(&down), 5173, false, None);
        assert_eq!(status.state, TailscaleState::Unavailable);
        assert!(status.message.unwrap().contains("service is not running"));

        let logged_out = ScriptedCli::new(&[("status --json", ok(LOGGED_OUT))]);
        let status = query_status(Some(&logged_out), 5173, false, None);
        assert_eq!(status.state, TailscaleState::LoggedOut);
        assert_eq!(
            logged_out.calls(),
            ["status --json"],
            "serve status only when connected"
        );

        let connected = ScriptedCli::new(&[
            ("status --json", ok(CONNECTED)),
            ("serve status --json", ok(SERVE_OURS)),
        ]);
        let status = query_status(Some(&connected), 5173, true, Some(NAME));
        assert_eq!(status.state, TailscaleState::Connected);
        assert_eq!(status.dns_name.as_deref(), Some(NAME));
        assert!(status.served && status.enabled && status.https);
        assert_eq!(
            status.url.as_deref(),
            Some("https://wardrobe-mac.tail1234.ts.net/")
        );

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "connected");
        assert_eq!(json["dnsName"], NAME);
        assert_eq!(json["serveTarget"], "http://127.0.0.1:5173");
        assert_eq!(json["magicDns"], true);
    }

    #[test]
    fn enable_runs_serve_and_verifies_the_rule() {
        let cli = ScriptedCli::new(&[
            ("status --json", ok(CONNECTED)),
            ("serve --bg --https=443 http://127.0.0.1:5173", ok("Available within your tailnet:\n\nhttps://wardrobe-mac.tail1234.ts.net/\n|-- proxy http://127.0.0.1:5173\n")),
            ("serve status --json", ok(SERVE_OURS)),
        ]);
        assert_eq!(enable(&cli, 5173).unwrap(), NAME);
        assert_eq!(
            cli.calls(),
            [
                "status --json",
                "serve --bg --https=443 http://127.0.0.1:5173",
                "serve status --json"
            ]
        );
    }

    #[test]
    fn enable_reports_why_it_cannot() {
        let logged_out = ScriptedCli::new(&[("status --json", ok(LOGGED_OUT))]);
        assert!(enable(&logged_out, 5173)
            .unwrap_err()
            .contains("not logged in"));
        assert_eq!(
            logged_out.calls(),
            ["status --json"],
            "serve never runs before login"
        );

        let no_dns = ScriptedCli::new(&[("status --json", ok(NO_MAGIC_DNS))]);
        assert!(enable(&no_dns, 5173)
            .unwrap_err()
            .contains("MagicDNS is off"));

        let waiting = CliOutput {
            success: false,
            timed_out: true,
            stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n".into(),
            ..Default::default()
        };
        let https_off = ScriptedCli::new(&[
            ("status --json", ok(CONNECTED_NO_HTTPS)),
            ("serve --bg --https=443 http://127.0.0.1:5173", waiting),
        ]);
        let error = enable(&https_off, 5173).unwrap_err();
        assert!(
            error.contains("https://login.tailscale.com/f/serve?node=nABC123"),
            "{error}"
        );
        assert!(error.contains("HTTPS"));

        let old = ScriptedCli::new(&[
            ("status --json", ok(CONNECTED)),
            (
                "serve --bg --https=443 http://127.0.0.1:5173",
                fail(2, "flag provided but not defined: -bg"),
            ),
        ]);
        assert!(enable(&old, 5173).unwrap_err().contains("too old"));

        let wrong = ScriptedCli::new(&[
            ("status --json", ok(CONNECTED)),
            ("serve --bg --https=443 http://127.0.0.1:5174", ok("")),
            ("serve status --json", ok(SERVE_OURS)),
        ]);
        assert!(enable(&wrong, 5174)
            .unwrap_err()
            .contains("instead of http://127.0.0.1:5174"));
    }

    #[test]
    fn disable_removes_only_our_rule() {
        let ours = ScriptedCli::new(&[
            ("serve status --json", ok(SERVE_OURS)),
            ("serve --https=443 off", ok("")),
        ]);
        disable(&ours, Some(NAME), 5173).unwrap();
        assert_eq!(
            ours.calls(),
            ["serve status --json", "serve --https=443 off"]
        );

        let other = ScriptedCli::new(&[("serve status --json", ok(SERVE_OTHER))]);
        disable(&other, Some(NAME), 5173).unwrap();
        assert_eq!(
            other.calls(),
            ["serve status --json"],
            "someone else's rule stays"
        );

        let nothing = ScriptedCli::new(&[("serve status --json", ok(SERVE_EMPTY))]);
        disable(&nothing, Some(NAME), 5173).unwrap();
        assert_eq!(nothing.calls(), ["serve status --json"]);

        let unreadable = ScriptedCli::new(&[
            ("serve status --json", fail(1, "boom")),
            ("serve --https=443 off", fail(1, "access denied")),
        ]);
        let error = disable(&unreadable, Some(NAME), 5173).unwrap_err();
        assert!(error.contains("off failed: access denied"), "{error}");
    }

    #[test]
    fn classifies_health_answers() {
        assert_eq!(
            classify_answer(200, r#"{"ok":true,"version":"1.2.3"}"#, 5173),
            Attempt::Healthy {
                version: Some("1.2.3".into())
            }
        );
        assert!(matches!(
            classify_answer(200, "<html>", 5173),
            Attempt::Retry(_)
        ));
        assert!(matches!(
            classify_answer(403, r#"{"error":{"code":"host_not_allowed"}}"#, 5173),
            Attempt::Fatal(_)
        ));
        assert!(
            matches!(classify_answer(502, "", 5173), Attempt::Retry(m) if m.contains("port 5173"))
        );
        assert!(matches!(classify_answer(404, "", 5173), Attempt::Retry(_)));
    }

    /// A one-thread HTTP server that answers each connection with the next canned response.
    fn canned_server(responses: Vec<(u16, &'static str)>) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        (port, handle)
    }

    #[test]
    fn health_polls_until_wardrobe_answers() {
        let (port, server) =
            canned_server(vec![(502, ""), (200, r#"{"ok":true,"version":"9.9.9"}"#)]);
        let health = tauri::async_runtime::block_on(probe_remote_health(
            &format!("http://127.0.0.1:{port}/"),
            5173,
            Duration::from_secs(10),
            Duration::from_millis(50),
        ));
        server.join().unwrap();
        assert!(health.ok, "{health:?}");
        assert_eq!(health.attempts, 2);
        assert_eq!(health.version.as_deref(), Some("9.9.9"));
        assert_eq!(health.url, format!("http://127.0.0.1:{port}/api/health"));
    }

    #[test]
    fn health_stops_on_a_refused_host_and_on_the_timeout() {
        let (port, server) = canned_server(vec![(403, r#"{"error":{"code":"host_not_allowed"}}"#)]);
        let refused = tauri::async_runtime::block_on(probe_remote_health(
            &format!("http://127.0.0.1:{port}"),
            5173,
            Duration::from_secs(10),
            Duration::from_millis(50),
        ));
        server.join().unwrap();
        assert!(!refused.ok);
        assert_eq!(refused.attempts, 1);
        assert_eq!(refused.status, Some(403));

        // Nothing listens on this port: gives up at the (short) timeout. (A
        // refused connection takes about 2 s to report on Windows, so the
        // number of attempts depends on the platform.)
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = closed.local_addr().unwrap().port();
        drop(closed);
        let gone = tauri::async_runtime::block_on(probe_remote_health(
            &format!("http://127.0.0.1:{dead}/"),
            5173,
            Duration::from_millis(400),
            Duration::from_millis(100),
        ));
        assert!(!gone.ok);
        assert!(gone.attempts >= 1, "{gone:?}");
        assert!(gone.elapsed_ms < 10_000, "{gone:?}");
        assert!(gone.error.unwrap().contains("Could not connect"));
    }
}
