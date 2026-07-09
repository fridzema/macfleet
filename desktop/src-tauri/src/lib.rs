mod commands;
mod error;
mod handlers;
mod state;

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

/// # Errors
///
/// Returns an error if the Tauri runtime fails to initialize or run.
///
/// # Panics
///
/// Panics if the app has no default window icon (needed for the tray icon)
/// or if the sidecar mutex is poisoned during shutdown.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
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

            // Spawn the Python engine's local API as a managed sidecar.
            // In dev the app runs from `desktop/`, so the engine repo root is `..`.
            // Put it in its own process group so we can later kill the whole tree:
            // `uv run` spawns a uvicorn grandchild that actually holds the port, and
            // killing only `uv` would orphan it (leaking the server across restarts).
            let mut cmd = Command::new("uv");
            cmd.args(["run", "macfleet", "serve", "--port", &port_arg])
                .current_dir("..")
                // Enable computer-use control. Safe: Fleet.computer() only ever targets
                // fleet VMs over their guest IP, never the host. This is the app's purpose.
                .env("MACFLEET_ALLOW_CONTROL", "1")
                .env("MACFLEET_API_TOKEN", &token);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                // 0 => a new process group whose id equals the child's pid.
                cmd.process_group(0);
            }
            let child = cmd.spawn().ok();
            app.manage(Sidecar(Mutex::new(child)));
            app.manage(state::ApiConfig { port, token });

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
                        }
                        #[cfg(not(unix))]
                        {
                            let _ = child.kill();
                        }
                        let _ = child.wait();
                    }
                }
            }
        });
    Ok(())
}
