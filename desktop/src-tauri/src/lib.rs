mod commands;
mod error;
mod handlers;
mod state;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

/// Grab a free loopback port for the engine sidecar. Binding to port 0 lets the OS pick an
/// unused one; the listener is dropped immediately and the number handed to `uv run serve`.
/// A per-run port means the app can never silently talk to a stale/foreign server squatting
/// on a fixed port. Falls back to 8765 if the probe fails (near-impossible on loopback).
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map_or(8765, |a| a.port())
}

/// Prepend the usual `uv` install locations to the inherited PATH. A macOS app launched from
/// Finder gets a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew,
/// `~/.local/bin`, and `~/.cargo/bin` — where `uv` typically lives — so a bare `Command::new("uv")`
/// fails to resolve and the engine never starts. Idempotent: skips any dir already on PATH.
fn augmented_path() -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();
    let mut extra = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        extra.push(format!("{home}/.local/bin"));
        extra.push(format!("{home}/.cargo/bin"));
    }
    for dir in extra {
        if !path.split(':').any(|p| p == dir) {
            path = if path.is_empty() {
                dir
            } else {
                format!("{dir}:{path}")
            };
        }
    }
    path
}

fn engine_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Bundles (including debug .app bundles) carry the engine under Resources. `tauri dev`
    // does not copy bundle resources, so fall back to the repository root only there.
    let bundled = app.path().resource_dir()?.join("engine");
    if bundled.join("pyproject.toml").is_file() {
        Ok(bundled)
    } else {
        Ok(PathBuf::from(".."))
    }
}

/// # Errors
///
/// Returns an error if the Tauri runtime fails to initialize or run.
///
/// # Panics
///
/// Panics if the app has no default window icon (needed for the tray icon)
/// or if the sidecar mutex is poisoned during shutdown.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)] // one long Tauri builder + setup closure; splitting hurts clarity
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Workaround for tauri-apps/tauri#6200 and #14427: scrolling is broken in
    // AppImage bundles on Wayland because the bundled webkit2gtk uses the
    // DMA-BUF renderer. Disabling it restores wheel scroll. Must be set before
    // the webview initializes. Harmless on X11; does not affect .deb builds.
    #[cfg(target_os = "linux")]
    // SAFETY: single-threaded process startup, no other threads read env yet.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            handlers::greet,
            handlers::greet_checked,
            handlers::get_app_info,
            handlers::get_api_config
        ])
        .setup(|app| {
            // Per-run port + secret. The port is ephemeral (never a fixed :8765 a stale
            // server could already own) and the token authenticates every API call — the
            // loopback API is otherwise CSRF-able by any local web page / process. Both are
            // handed to the webview via get_api_config so the frontend talks to *this*
            // sidecar with *this* token.
            let port = free_port();
            let port_arg = port.to_string();
            let token = uuid::Uuid::new_v4().to_string();
            let engine_dir = engine_dir(app)?;
            let bundled_engine = app
                .path()
                .resource_dir()?
                .join("engine-sidecar")
                .join("macfleet-engine");

            // Release bundles carry a standalone engine, avoiding Python discovery and uv's
            // environment check on every launch. Source/dev builds retain the uv fallback.
            let standalone = bundled_engine.is_file();
            let mut cmd = if standalone {
                let mut command = Command::new(&bundled_engine);
                command.args(["--port", &port_arg]);
                command
            } else {
                let mut command = Command::new("uv");
                command.args(["run", "--frozen", "macfleet", "serve", "--port", &port_arg]);
                command
            };
            cmd.current_dir(&engine_dir)
                // Resolve uv in source/dev builds launched from Finder.
                .env("PATH", augmented_path())
                // Enable computer-use control. Safe: Fleet.computer() only ever targets
                // fleet VMs over their guest IP, never the host. This is the app's purpose.
                .env("MACFLEET_ALLOW_CONTROL", "1")
                .env("MACFLEET_API_TOKEN", &token)
                // Freeze the fleet on app quit: RunEvent::Exit SIGTERMs this group, uvicorn
                // shuts down gracefully, and its lifespan suspends every running VM before
                // the process exits. Scoped to the desktop sidecar so a standalone
                // `macfleet serve` (CLI) never suspends VMs on Ctrl-C.
                .env("MACFLEET_SUSPEND_VMS_ON_EXIT", "1");
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                // 0 => a new process group whose id equals the child's pid.
                cmd.process_group(0);
            }
            // Log a spawn failure instead of `.ok()` swallowing it — otherwise a missing `uv`
            // leaves the app running against a port nobody listens on, with no clue why.
            let child = match cmd.spawn() {
                Ok(c) => Some(c),
                Err(e) => {
                    let mode = if standalone { "standalone" } else { "uv" };
                    log::error!("failed to start {mode} engine sidecar: {e}");
                    None
                }
            };
            let started = child.is_some();
            app.manage(Sidecar(Mutex::new(child)));
            app.manage(state::ApiConfig { port, token });

            // Readiness probe: uvicorn cold-starts over a few seconds. Poll the loopback port
            // so a spawn-ok-but-crashed engine (or one that never binds) surfaces in the log
            // rather than as silent connection-refused in the webview.
            if started {
                std::thread::spawn(move || {
                    use std::net::TcpStream;
                    use std::time::{Duration, Instant};
                    let deadline = Instant::now() + Duration::from_secs(30);
                    loop {
                        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                            log::info!("engine sidecar ready on 127.0.0.1:{port}");
                            return;
                        }
                        if Instant::now() >= deadline {
                            log::error!(
                                "engine sidecar did not become ready on 127.0.0.1:{port} within 30s"
                            );
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                });
            }

            let show = MenuItem::with_id(app, "show", "Show macfleet", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(sc) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = sc.0.lock().unwrap().take() {
                        // Kill the whole process group (uv -> python -> uvicorn), not
                        // just `uv`, so the grandchild holding the port is released too.
                        #[cfg(unix)]
                        if let Ok(pid) = i32::try_from(child.id()) {
                            // Negating the pid targets the process group (the child is
                            // its leader via process_group(0) at spawn). SIGTERM lets
                            // uvicorn shut down cleanly and free the port.
                            unsafe {
                                libc::kill(-pid, libc::SIGTERM);
                            }
                            // Bound the graceful window: uvicorn's shutdown suspends the fleet
                            // (can be slow), but a hung shutdown must not block app exit forever.
                            // Each suspend has a 300s engine ceiling and runs concurrently;
                            // allow that operation to finish rather than killing Tart midway.
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_secs(330);
                            loop {
                                if matches!(child.try_wait(), Ok(Some(_))) {
                                    break;
                                }
                                if std::time::Instant::now() >= deadline {
                                    unsafe {
                                        libc::kill(-pid, libc::SIGKILL);
                                    }
                                    let _ = child.wait();
                                    break;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(100));
                            }
                        }
                        #[cfg(not(unix))]
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
    Ok(())
}
