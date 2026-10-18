//! Starting the bundled rclone and relaying the page's requests to it.
//!
//! rclone's remote-control server listens on 127.0.0.1 with a password made
//! fresh each launch. Only this module knows the password: the page asks the
//! core, the core checks the request against an allowlist and forwards it.
//! The server is started without any cross-origin permission, so no web page,
//! including Offload's own, can talk to it directly.

use serde_json::{Map, Value};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The rclone calls the interface makes, and nothing else. Deliberately
/// absent: `core/command` (runs any rclone command), `operations/purge` and
/// `operations/delete` (remove whole folders), `operations/deletefile`
/// (permanent deletes go through the core's own checked command), every
/// `config/*` call that writes or dumps the config, and `core/quit` (the app
/// owns rclone's lifetime).
pub const ALLOWED: &[&str] = &[
    "core/version",
    "core/du",
    "core/stats",
    "core/bwlimit",
    "config/listremotes",
    "config/get",
    "job/status",
    "job/list",
    "job/stop",
    "operations/list",
    "operations/about",
    "operations/check",
    "operations/stat",
    "sync/copy",
];

pub fn allowed(path: &str) -> bool {
    ALLOWED.contains(&path)
}

/// Trim a request to what the interface legitimately sends. `_config` can set
/// any of rclone's global options for one call; the page only ever needs
/// `Transfers`, so everything else in it is dropped.
pub fn sanitize_params(mut params: Value) -> Value {
    if let Some(obj) = params.as_object_mut() {
        if let Some(cfg) = obj.get("_config").and_then(Value::as_object).cloned() {
            let mut kept = Map::new();
            if let Some(t) = cfg.get("Transfers").and_then(Value::as_u64) {
                kept.insert("Transfers".into(), Value::from(t.clamp(1, 16)));
            }
            obj.insert("_config".into(), Value::Object(kept));
        }
    }
    params
}

/// Trim a response before the page sees it. `config/get` returns the whole
/// section for a remote, sign-in token included; the page needs only the
/// remote's type, and for an alias, what it points at.
pub fn sanitize_reply(path: &str, reply: Value) -> Value {
    if path != "config/get" {
        return reply;
    }
    let mut out = Map::new();
    if let Some(obj) = reply.as_object() {
        if let Some(t) = obj.get("type") {
            out.insert("type".into(), t.clone());
        }
        if obj.get("type").and_then(Value::as_str) == Some("alias") {
            if let Some(r) = obj.get("remote") {
                out.insert("remote".into(), r.clone());
            }
        }
    }
    Value::Object(out)
}

pub struct Rclone {
    child: Child,
    base: String,
    auth: String,
}

#[derive(Debug, serde::Serialize)]
pub struct Failure {
    /// HTTP status from rclone, or 0 when it could not be reached.
    pub status: u16,
    pub error: String,
}

impl Failure {
    fn new(status: u16, error: impl Into<String>) -> Self {
        Failure { status, error: error.into() }
    }
}

fn secret() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no free port: {e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// The bundled rclone sits next to Offload's own executable, both when
/// installed and when run from a build.
pub fn bundled_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no folder for the executable")?;
    let name = if cfg!(windows) { "rclone.exe" } else { "rclone" };
    let path = dir.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("the bundled rclone is missing ({})", path.display()))
    }
}

impl Rclone {
    pub fn start(binary: &Path, log_file: &Path) -> Result<Rclone, String> {
        let port = free_port()?;
        let pass = secret()?;
        let mut cmd = Command::new(binary);
        cmd.args(["rcd", "--rc-addr"])
            .arg(format!("127.0.0.1:{port}"))
            .args(["--rc-job-expire-duration", "24h", "--log-level", "INFO", "--log-file"])
            .arg(log_file)
            // Through the environment, not the command line, where any
            // program can read it from the process list.
            .env("RCLONE_RC_USER", "offload")
            .env("RCLONE_RC_PASS", &pass)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn().map_err(|e| format!("could not start rclone: {e}"))?;
        let auth = format!("Basic {}", base64(format!("offload:{pass}").as_bytes()));
        let mut rc = Rclone { child, base: format!("http://127.0.0.1:{port}/"), auth };

        let started = Instant::now();
        loop {
            if rc.call("core/version", Value::Object(Map::new()), Duration::from_secs(2)).is_ok() {
                return Ok(rc);
            }
            if let Ok(Some(status)) = rc.child.try_wait() {
                return Err(format!("rclone stopped as it started ({status}); see {}", log_file.display()));
            }
            if started.elapsed() > Duration::from_secs(15) {
                rc.stop();
                return Err("rclone did not answer within 15 seconds".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// The address and password, for making a call without holding a lock.
    pub fn endpoint(&self) -> (String, String) {
        (self.base.clone(), self.auth.clone())
    }

    pub fn call(&self, path: &str, params: Value, timeout: Duration) -> Result<Value, Failure> {
        call(&self.base, &self.auth, path, params, timeout)
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn call(base: &str, auth: &str, path: &str, params: Value, timeout: Duration) -> Result<Value, Failure> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    match agent.post(&format!("{base}{path}")).set("Authorization", auth).send_json(params) {
        Ok(res) => res.into_json::<Value>().map_err(|e| Failure::new(500, e.to_string())),
        Err(ureq::Error::Status(code, res)) => {
            let body: Value = res.into_json().unwrap_or(Value::Null);
            let msg = body.get("error").and_then(Value::as_str).unwrap_or("rclone refused the request");
            Err(Failure::new(code, msg))
        }
        Err(e) => Err(Failure::new(0, if e.to_string().contains("timed out") { "timed out".to_string() } else { "unreachable".to_string() })),
    }
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allowlist_keeps_dangerous_calls_out() {
        for path in ["core/command", "operations/purge", "operations/delete", "operations/deletefile",
                     "config/dump", "config/create", "config/delete", "config/update", "core/quit",
                     "../core/version", "core/version/../command", ""] {
            assert!(!allowed(path), "{path} must not be allowed");
        }
        for path in ["core/version", "sync/copy", "operations/check", "config/get"] {
            assert!(allowed(path), "{path} should be allowed");
        }
    }

    #[test]
    fn config_get_never_reaches_the_page_with_secrets() {
        let reply = json!({ "type": "drive", "token": "{\"access_token\":\"x\"}", "client_secret": "y", "scope": "drive" });
        assert_eq!(sanitize_reply("config/get", reply), json!({ "type": "drive" }));
        let alias = json!({ "type": "alias", "remote": "Cloud:folder", "extra": "z" });
        assert_eq!(sanitize_reply("config/get", alias), json!({ "type": "alias", "remote": "Cloud:folder" }));
        let other = json!({ "token": "untouched" });
        assert_eq!(sanitize_reply("core/stats", other.clone()), other);
    }

    #[test]
    fn only_transfers_survives_in_config() {
        let p = json!({ "srcFs": "a", "_config": { "Transfers": 64, "DryRun": true, "Config": "/elsewhere" } });
        assert_eq!(sanitize_params(p), json!({ "srcFs": "a", "_config": { "Transfers": 16 } }));
        let q = json!({ "fs": "a" });
        assert_eq!(sanitize_params(q.clone()), q);
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"offload:secret"), "b2ZmbG9hZDpzZWNyZXQ=");
    }
}
