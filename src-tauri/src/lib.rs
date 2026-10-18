//! Offload's native core. It owns rclone (starts it, holds its password,
//! stops it), relays the page's calls through an allowlist, moves freed files
//! to the Recycle Bin, and keeps a tray icon while jobs run.

mod paths;
mod rclone;

use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

struct Core {
    rclone: Mutex<Option<rclone::Rclone>>,
    start_error: Mutex<Option<String>>,
    /// Background jobs (uploads and checks) started through `rc`. rclone
    /// counts every call as a job while it runs, including the one asking
    /// which jobs are running, so "is anything running" has to ask about
    /// these ids, not rclone's whole list.
    jobs: Mutex<Vec<u64>>,
}

impl Core {
    fn endpoint(&self) -> Result<(String, String), rclone::Failure> {
        let guard = self.rclone.lock().unwrap();
        guard.as_ref().map(|r| r.endpoint()).ok_or(rclone::Failure {
            status: 0,
            error: "unreachable".into(),
        })
    }
}

/// Relay one call to rclone. Refused unless it is on the allowlist; the
/// request is trimmed on the way in and the reply on the way out.
#[tauri::command]
async fn rc(core: State<'_, Core>, path: String, params: Value, timeout_ms: Option<u64>) -> Result<Value, rclone::Failure> {
    if !rclone::allowed(&path) {
        return Err(rclone::Failure { status: 403, error: format!("{path} is not available to the interface") });
    }
    let (base, auth) = core.endpoint()?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 600_000));
    let is_async = params.get("_async").and_then(Value::as_bool) == Some(true);
    let params = rclone::sanitize_params(params);
    let reply = tauri::async_runtime::spawn_blocking(move || {
        rclone::call(&base, &auth, &path, params, timeout).map(|reply| rclone::sanitize_reply(&path, reply))
    })
    .await
    .map_err(|e| rclone::Failure { status: 500, error: e.to_string() })??;
    if is_async {
        if let Some(id) = reply.get("jobid").and_then(Value::as_u64) {
            core.jobs.lock().unwrap().push(id);
        }
    }
    Ok(reply)
}

/// Remove one local file that has been verified in the cloud, after proving it
/// sits inside the folder being offloaded. By default it goes to the Recycle
/// Bin (Trash on macOS and Linux); `permanent` deletes it outright, which is
/// the only way to get the space back without emptying the bin.
#[tauri::command]
async fn free_file(root: String, rel: String, permanent: bool) -> Result<(), String> {
    let path = paths::resolve_inside(&root, &rel).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        if permanent {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        } else {
            trash::delete(&path).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the page needs to know about the app it is running in.
#[tauri::command]
fn app_info(app: AppHandle, core: State<'_, Core>) -> Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "error": core.start_error.lock().unwrap().clone(),
    })
}

/// Is any upload or check still running? Decides whether closing the window
/// quits or tucks Offload into the tray.
fn jobs_running(app: &AppHandle) -> bool {
    let core = app.state::<Core>();
    let Ok((base, auth)) = core.endpoint() else { return false };
    let ids = core.jobs.lock().unwrap().clone();
    let mut still = Vec::new();
    for id in ids {
        let status = rclone::call(&base, &auth, "job/status", serde_json::json!({ "jobid": id }), Duration::from_secs(3));
        if let Ok(v) = status {
            if v.get("finished").and_then(Value::as_bool) == Some(false) {
                still.push(id);
            }
        }
    }
    let running = !still.is_empty();
    *core.jobs.lock().unwrap() = still;
    running
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Core { rclone: Mutex::new(None), start_error: Mutex::new(None), jobs: Mutex::new(Vec::new()) })
        .invoke_handler(tauri::generate_handler![rc, free_file, app_info])
        .setup(|app| {
            let handle = app.handle().clone();

            // Start rclone before the page asks for it.
            let log_dir = handle.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            let started = rclone::bundled_binary().and_then(|bin| rclone::Rclone::start(&bin, &log_dir.join("rclone.log")));
            let core = handle.state::<Core>();
            match started {
                Ok(r) => *core.rclone.lock().unwrap() = Some(r),
                Err(e) => *core.start_error.lock().unwrap() = Some(e),
            }

            let show = MenuItem::with_id(app, "show", "Show Offload", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (stops any upload)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("offload")
                .tooltip("Offload")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing with a job running would kill the upload with it,
                // so keep running in the tray instead. Otherwise just quit.
                if jobs_running(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Offload");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut r) = app.state::<Core>().rclone.lock().unwrap().take() {
                r.stop();
            }
        }
    });
}
