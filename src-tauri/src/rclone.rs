//! Starting the bundled rclone and relaying the page's requests to it.
//!
//! rclone's remote-control server listens on 127.0.0.1 with a password made
//! fresh each launch. Only this module knows the password: the page asks the
//! core, the core checks the request against an allowlist and forwards it.
//! The server is started without any cross-origin permission, so no web page,
//! including Decant's own, can talk to it directly.

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

/// The bundled rclone sits next to Decant's own executable, both when
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
    /// Start rclone's remote-control server. `config` overrides which rclone
    /// config file it reads; the app passes `None` and uses rclone's own.
    pub fn start(binary: &Path, log_file: &Path, config: Option<&Path>) -> Result<Rclone, String> {
        let port = free_port()?;
        let pass = secret()?;
        let mut cmd = Command::new(binary);
        if let Some(c) = config {
            cmd.arg("--config").arg(c);
        }
        cmd.args(["rcd", "--rc-addr"])
            .arg(format!("127.0.0.1:{port}"))
            .args(["--rc-job-expire-duration", "24h", "--log-level", "INFO", "--log-file"])
            .arg(log_file)
            // Through the environment, not the command line, where any
            // program can read it from the process list.
            .env("RCLONE_RC_USER", "decant")
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
        let auth = format!("Basic {}", base64(format!("decant:{pass}").as_bytes()));
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

/// The whole path a page request takes: refused unless allowlisted, trimmed
/// on the way in, forwarded, trimmed on the way out. The `rc` command is a
/// thin wrapper around this, so tests can drive exactly what the app does.
pub fn relay(base: &str, auth: &str, path: &str, params: Value, timeout: Duration) -> Result<Value, Failure> {
    if !allowed(path) {
        return Err(Failure::new(403, format!("{path} is not available to the interface")));
    }
    call(base, auth, path, sanitize_params(params), timeout).map(|reply| sanitize_reply(path, reply))
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
        assert_eq!(base64(b"decant:secret"), "ZGVjYW50OnNlY3JldA==");
    }
}

#[cfg(test)]
mod live {
    //! Start the real rclone the way the app does, then attack it. Each
    //! test also proves its setup is real, so a pass cannot come from a
    //! broken attack: sent straight to rclone, the same purge does delete
    //! and the planted token does come back; the real password works; and
    //! rclone must answer the preflights, and answer before it is stopped.
    //!
    //! They need the bundled binary (`scripts/fetch-rclone.sh`). Without it
    //! they print a notice and pass, so a fresh clone can still `cargo test`;
    //! CI always fetches it first.
    use super::*;
    use serde_json::json;

    const T: Duration = Duration::from_secs(15);

    fn binary() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rclone-"))
        })
    }

    struct Live {
        rc: Rclone,
        dir: PathBuf,
    }

    impl Drop for Live {
        fn drop(&mut self) {
            self.rc.stop();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn start(name: &str) -> Option<Live> {
        let Some(bin) = binary() else {
            eprintln!("skipping live test: no bundled rclone (run scripts/fetch-rclone.sh)");
            return None;
        };
        let dir = std::env::temp_dir().join(format!("decant-live-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conf = dir.join("rclone.conf");
        // A remote with a planted token. config/get reads it without ever
        // contacting Google.
        std::fs::write(
            &conf,
            "[fake]\ntype = drive\nscope = drive\ntoken = {\"access_token\":\"PLANTED-SECRET\",\"refresh_token\":\"PLANTED-REFRESH\"}\n",
        )
        .unwrap();
        let rc = Rclone::start(&bin, &dir.join("rclone.log"), Some(&conf)).expect("rclone should start");
        Some(Live { rc, dir })
    }

    #[test]
    fn live_allowed_calls_get_through() {
        let Some(l) = start("allowed") else { return };
        let (b, a) = l.rc.endpoint();
        let v = relay(&b, &a, "core/version", json!({}), T).unwrap();
        assert!(v.get("version").and_then(Value::as_str).is_some_and(|s| s.starts_with('v')));
    }

    #[test]
    fn live_a_refused_call_never_reaches_rclone() {
        let Some(l) = start("refused") else { return };
        let (b, a) = l.rc.endpoint();
        let victim = l.dir.join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("keep.txt"), b"precious").unwrap();
        let purge = json!({ "fs": victim.to_str().unwrap(), "remote": "" });

        let err = relay(&b, &a, "operations/purge", purge.clone(), T).unwrap_err();
        assert_eq!(err.status, 403);
        assert!(victim.join("keep.txt").exists(), "a refused purge must not have run");

        let marker = l.dir.join("made-by-core-command");
        let cmd = json!({ "command": "mkdir", "arg": [marker.to_str().unwrap()] });
        assert_eq!(relay(&b, &a, "core/command", cmd, T).unwrap_err().status, 403);
        assert!(!marker.exists(), "a refused core/command must not have run");

        // Control: sent straight to rclone, the same purge does delete.
        call(&b, &a, "operations/purge", purge, T).expect("control purge should work");
        assert!(!victim.exists(), "control: rclone itself would have purged the folder");
    }

    #[test]
    fn live_sign_in_tokens_never_come_back() {
        let Some(l) = start("tokens") else { return };
        let (b, a) = l.rc.endpoint();
        let raw = call(&b, &a, "config/get", json!({ "name": "fake" }), T).unwrap();
        assert!(raw.to_string().contains("PLANTED-SECRET"), "control: rclone itself returns the token");

        let relayed = relay(&b, &a, "config/get", json!({ "name": "fake" }), T).unwrap();
        assert!(!relayed.to_string().contains("PLANTED"), "the relay must strip tokens: {relayed}");
        assert_eq!(relayed, json!({ "type": "drive" }));

        assert_eq!(relay(&b, &a, "config/dump", json!({}), T).unwrap_err().status, 403);
    }

    #[test]
    fn live_the_wrong_password_is_refused() {
        let Some(l) = start("auth") else { return };
        let (b, a) = l.rc.endpoint();
        let wrong = format!("Basic {}", base64(b"decant:not-the-password"));
        assert_eq!(call(&b, &wrong, "core/version", json!({}), T).unwrap_err().status, 401);
        assert_eq!(call(&b, "", "core/version", json!({}), T).unwrap_err().status, 401);
        assert!(call(&b, &a, "core/version", json!({}), T).is_ok(), "control: the real password works");
    }

    #[test]
    fn live_no_website_gets_cross_origin_access() {
        let Some(l) = start("cors") else { return };
        let (b, _) = l.rc.endpoint();
        for origin in ["https://evil.example", "null", "http://127.0.0.1"] {
            let res = ureq::request("OPTIONS", &format!("{b}core/version"))
                .set("Origin", origin)
                .set("Access-Control-Request-Method", "POST")
                .set("Access-Control-Request-Headers", "authorization,content-type")
                .call();
            let allow = match &res {
                Ok(r) => r.header("Access-Control-Allow-Origin").map(str::to_string),
                Err(ureq::Error::Status(_, r)) => r.header("Access-Control-Allow-Origin").map(str::to_string),
                Err(e) => panic!("rclone did not answer the preflight: {e}"),
            };
            assert_eq!(allow, None, "no cross-origin permission for {origin}");
        }
    }

    #[test]
    fn live_stopping_ends_the_server() {
        let Some(mut l) = start("stop") else { return };
        let (b, a) = l.rc.endpoint();
        assert!(call(&b, &a, "core/version", json!({}), T).is_ok());
        l.rc.stop();
        let err = call(&b, &a, "core/version", json!({}), Duration::from_secs(3)).unwrap_err();
        assert_eq!(err.status, 0, "nothing should answer once rclone is stopped");
    }
}
