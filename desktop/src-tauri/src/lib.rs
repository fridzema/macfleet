mod commands;
mod error;
mod handlers;
mod state;

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

/// # Errors
///
/// Returns an error if the Tauri runtime fails to initialize or run.
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
            handlers::get_app_info
        ])
        .setup(|app| {
            // Spawn the Python engine's local API as a managed sidecar.
            // In dev the app runs from `desktop/`, so the engine repo root is `..`.
            let child = Command::new("uv")
                .args(["run", "macfleet", "serve", "--port", "8765"])
                .current_dir("..")
                .spawn()
                .ok();
            app.manage(Sidecar(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(sc) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = sc.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
    Ok(())
}
