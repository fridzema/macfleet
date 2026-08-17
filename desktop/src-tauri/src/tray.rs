use serde::Deserialize;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Authenticated blocking client for the local engine, used from the tray's background
/// threads (never the UI thread). Blocking + a short timeout keeps each call self-contained:
/// a wedged engine can't pin a UI thread, and a poll that stalls just skips a cycle.
pub struct Engine {
    base: String,
    token: String,
    client: reqwest::blocking::Client,
}

fn url(base: &str, path: &str) -> String {
    format!("{base}{path}")
}

impl Engine {
    pub fn new(port: u16, token: &str) -> Engine {
        Engine {
            base: format!("http://127.0.0.1:{port}"),
            token: token.to_string(),
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .unwrap_or_default(),
        }
    }

    /// # Errors
    ///
    /// Returns the transport/status/decode error as a string if the fleet cannot be listed.
    pub fn list_vms(&self) -> Result<Vec<TrayVm>, String> {
        self.client
            .get(url(&self.base, "/vms"))
            .header("X-Macfleet-Token", &self.token)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| e.to_string())?
            .json::<Vec<TrayVm>>()
            .map_err(|e| e.to_string())
    }

    /// Fire a lifecycle POST (restart/suspend/resume/down/nuke). No body; the engine takes the
    /// VM name from the path.
    ///
    /// # Errors
    ///
    /// Returns the error as a string on any transport failure or non-2xx status, so the caller
    /// can surface it.
    pub fn post(&self, path: &str) -> Result<(), String> {
        self.client
            .post(url(&self.base, path))
            .header("X-Macfleet-Token", &self.token)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// # Errors
    ///
    /// Returns an error if the connection lookup fails or the VM has no IP assigned yet.
    pub fn connection_ip(&self, short_name: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Conn {
            ip: String,
        }
        let conn = self
            .client
            .get(url(&self.base, &format!("/vms/{short_name}/connection")))
            .header("X-Macfleet-Token", &self.token)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| e.to_string())?
            .json::<Conn>()
            .map_err(|e| e.to_string())?;
        if conn.ip.is_empty() || conn.ip == "—" {
            return Err("VM has no IP yet".into());
        }
        Ok(conn.ip)
    }
}

/// One VM as the tray needs it — three fields, not the whole engine `Vm`. Deserialized from
/// `GET /vms`; extra JSON fields (source, cpu, `memory_mb`, `lease_expires_at`…) are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TrayVm {
    pub name: String,
    pub state: String,
    pub healthy: bool,
}

/// Status glyph. `◐` is "running but the guest health check hasn't passed yet" (booting);
/// suspended and stopped both read as `○` — neither is reachable, and the submenu differs by
/// offering Resume vs the running actions.
pub fn dot(vm: &TrayVm) -> &'static str {
    match (vm.state.as_str(), vm.healthy) {
        ("running", true) => "●",
        ("running", false) => "◐",
        _ => "○",
    }
}

pub fn short(name: &str) -> &str {
    name.strip_prefix("mf-").unwrap_or(name)
}

/// Stable display order so the menu doesn't reshuffle between rebuilds.
pub fn project(mut vms: Vec<TrayVm>) -> Vec<TrayVm> {
    vms.sort_by(|a, b| a.name.cmp(&b.name));
    vms
}

#[derive(Debug)]
pub enum Action {
    Vm { name: String, verb: String },
    Global(String),
}

/// Menu ID for a per-VM action. `name` is the SHORT name (what the engine's URL layer accepts
/// either way); it cannot contain a colon (see the name charset), so `vm:<name>:<verb>` parses
/// unambiguously.
pub fn vm_id(name: &str, verb: &str) -> String {
    format!("vm:{name}:{verb}")
}

pub fn parse_id(id: &str) -> Option<Action> {
    if let Some(rest) = id.strip_prefix("vm:") {
        let (name, verb) = rest.split_once(':')?;
        if name.is_empty() || verb.is_empty() {
            return None;
        }
        return Some(Action::Vm {
            name: name.to_string(),
            verb: verb.to_string(),
        });
    }
    if id.is_empty() {
        return None;
    }
    Some(Action::Global(id.to_string()))
}

/// One clickable tray item. Wraps the builder so the menu code below reads as structure
/// rather than five-line constructor calls; no tray item ever needs an accelerator.
fn item(
    app: &tauri::AppHandle,
    id: String,
    label: &str,
    enabled: bool,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, label, enabled, None::<&str>)
}

/// One VM's submenu. Running VMs get connect + lifecycle actions (connect/copy are enabled
/// only once the guest health check passes); anything else gets Resume.
fn vm_submenu(app: &tauri::AppHandle, vm: &TrayVm) -> tauri::Result<Submenu<tauri::Wry>> {
    let name = short(&vm.name).to_string();
    let sub = Submenu::with_id(
        app,
        vm_id(&name, "sub"),
        format!("{} {}", dot(vm), name),
        true,
    )?;
    if vm.state == "running" {
        let can = vm.healthy; // connect/copy only make sense once the guest is up
        sub.append(&item(app, vm_id(&name, "vnc"), "Connect VNC", can)?)?;
        sub.append(&item(app, vm_id(&name, "ssh"), "Connect SSH", can)?)?;
        sub.append(&item(app, vm_id(&name, "ip"), "Copy IP address", can)?)?;
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        sub.append(&item(app, vm_id(&name, "restart"), "Restart", true)?)?;
        sub.append(&item(app, vm_id(&name, "suspend"), "Suspend", true)?)?;
        sub.append(&item(app, vm_id(&name, "down"), "Stop", true)?)?;
    } else {
        sub.append(&item(app, vm_id(&name, "resume"), "Resume", true)?)?;
    }
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&item(app, vm_id(&name, "show"), "Show in app", true)?)?;
    sub.append(&item(app, vm_id(&name, "delete"), "Delete…", true)?)?;
    Ok(sub)
}

/// Build the whole tray menu for the current fleet. Per-VM submenus first, then the globals,
/// then Show/Quit. Called on the main thread only (menu objects aren't Send on macOS).
///
/// # Errors
///
/// Returns the Tauri error if any menu item or submenu fails to construct.
pub fn build_menu(app: &tauri::AppHandle, vms: &[TrayVm]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for vm in vms {
        menu.append(&vm_submenu(app, vm)?)?;
    }
    if !vms.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&item(app, "new".into(), "New VM", true)?)?;
    menu.append(&item(app, "suspend-all".into(), "Suspend all", true)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(app, "settings".into(), "Settings…", true)?)?;
    menu.append(&item(app, "doctor".into(), "Doctor…", true)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(app, "show".into(), "Show macfleet", true)?)?;
    menu.append(&item(app, "quit".into(), "Quit", true)?)?;
    Ok(menu)
}

/// Background poll: fetch `/vms`, project, and rebuild the tray menu only when the projection
/// changes. Runs off the UI thread (blocking HTTP); menu rebuilds hop to the main thread via
/// `run_on_main_thread` because macOS menu objects aren't Send. A failed poll (engine still
/// booting, transient error) just skips a cycle and retries — the tray keeps its last good menu.
pub fn spawn_poll(app: tauri::AppHandle, port: u16, token: String) {
    std::thread::spawn(move || {
        let engine = Engine::new(port, &token);
        let mut last: Option<Vec<TrayVm>> = None;
        loop {
            if let Ok(vms) = engine.list_vms() {
                let projected = project(vms);
                if last.as_ref() != Some(&projected) {
                    let app2 = app.clone();
                    let for_menu = projected.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let (Some(tray), Ok(menu)) =
                            (app2.tray_by_id("main"), build_menu(&app2, &for_menu))
                        {
                            let _ = tray.set_menu(Some(menu));
                        }
                    });
                    last = Some(projected);
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// Tray click dispatch. Runs on the main thread (Tauri calls it there). Anything that does
/// blocking I/O (HTTP, a confirm dialog) is pushed to a worker thread so the menu closes
/// immediately and the UI thread never stalls. Engine access needs the per-run config, read
/// from managed state.
pub fn on_menu_event(app: &tauri::AppHandle, id: &str) {
    let Some(action) = parse_id(id) else { return };
    match action {
        Action::Global(g) => on_global(app, &g),
        Action::Vm { name, verb } => on_vm(app, &name, &verb),
    }
}

fn engine_from(app: &tauri::AppHandle) -> Option<Engine> {
    let cfg = app.try_state::<crate::state::ApiConfig>()?;
    Some(Engine::new(cfg.port, &cfg.token))
}

fn on_vm(app: &tauri::AppHandle, name: &str, verb: &str) {
    match verb {
        "restart" | "suspend" | "resume" | "down" => {
            let Some(engine) = engine_from(app) else {
                return;
            };
            let (name, verb) = (name.to_string(), verb.to_string());
            let path = format!("/vms/{name}/{verb}");
            std::thread::spawn(move || {
                if let Err(e) = engine.post(&path) {
                    log::warn!("tray {verb} {name} failed: {e}");
                }
            });
        }
        "delete" => confirm_and_delete(app, name),
        "vnc" | "ssh" | "ip" => {
            let Some(engine) = engine_from(app) else {
                return;
            };
            let (app2, name, verb) = (app.clone(), name.to_string(), verb.to_string());
            std::thread::spawn(move || match engine.connection_ip(&name) {
                Ok(ip) => connect(&app2, &verb, &ip),
                Err(e) => log::warn!("tray {verb} {name}: {e}"),
            });
        }
        // show lands in Task 6.
        _ => {}
    }
}

/// VNC/SSH hand off to macOS via `open(1)` — no tauri-plugin-opener scope needed (opener only
/// permits http/https/mailto/tel by default; shelling out sidesteps that). Copy IP writes to
/// the clipboard. All three already have the IP resolved.
fn connect(app: &tauri::AppHandle, verb: &str, ip: &str) {
    match verb {
        "vnc" => {
            let _ = std::process::Command::new("open")
                .arg(format!("vnc://admin@{ip}"))
                .spawn();
        }
        "ssh" => {
            let _ = std::process::Command::new("open")
                .arg(format!("ssh://admin@{ip}"))
                .spawn();
        }
        "ip" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            if let Err(e) = app.clipboard().write_text(ip.to_string()) {
                log::warn!("tray copy ip failed: {e}");
            }
        }
        _ => {}
    }
}

fn confirm_and_delete(app: &tauri::AppHandle, name: &str) {
    let Some(engine) = engine_from(app) else {
        return;
    };
    let (app2, name) = (app.clone(), name.to_string());
    std::thread::spawn(move || {
        // Native two-button confirm — the app's in-UI two-step arm can't be expressed in a
        // native menu, so a modal is the equivalent guard against a stray click.
        let ok = app2
            .dialog()
            .message(format!(
                "Delete {name}? This stops and removes the VM. It cannot be undone."
            ))
            .title("macfleet")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Delete".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if ok {
            if let Err(e) = engine.post(&format!("/vms/{name}/nuke")) {
                log::warn!("tray delete {name} failed: {e}");
            }
        }
    });
}

fn on_global(app: &tauri::AppHandle, g: &str) {
    match g {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "quit" => app.exit(0),
        // new / suspend-all / settings / doctor land in Task 6.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_reflects_running_and_health() {
        assert_eq!(dot(&tv("mf-a", "running", true)), "●");
        assert_eq!(dot(&tv("mf-a", "running", false)), "◐");
        assert_eq!(dot(&tv("mf-a", "stopped", false)), "○");
        assert_eq!(dot(&tv("mf-a", "suspended", false)), "○");
    }

    #[test]
    fn short_strips_the_mf_prefix() {
        assert_eq!(short("mf-web"), "web");
        assert_eq!(short("web"), "web");
    }

    #[test]
    fn project_sorts_by_name() {
        let out = project(vec![
            tv("mf-c", "running", true),
            tv("mf-a", "stopped", false),
        ]);
        assert_eq!(
            out.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
            ["mf-a", "mf-c"]
        );
    }

    #[test]
    fn projection_equality_drives_change_detection() {
        // The poll loop rebuilds only when project(old) != project(new). Health flips must count.
        let a = project(vec![tv("mf-a", "running", true)]);
        let b = project(vec![tv("mf-a", "running", false)]);
        assert_ne!(a, b);
        assert_eq!(a, project(vec![tv("mf-a", "running", true)]));
    }

    #[test]
    fn vm_id_round_trips_through_parse_id() {
        let id = vm_id("web", "restart");
        assert_eq!(id, "vm:web:restart");
        match parse_id(&id) {
            Some(Action::Vm { name, verb }) => {
                assert_eq!(name, "web");
                assert_eq!(verb, "restart");
            }
            other => panic!("expected Vm action, got {other:?}"),
        }
    }

    #[test]
    fn parse_id_reads_globals() {
        assert!(matches!(parse_id("settings"), Some(Action::Global(g)) if g == "settings"));
        assert!(matches!(parse_id("quit"), Some(Action::Global(g)) if g == "quit"));
    }

    #[test]
    fn parse_id_rejects_malformed() {
        assert!(parse_id("vm:web").is_none()); // missing verb
        assert!(parse_id("vm::restart").is_none()); // empty name
        assert!(parse_id("vm:web:").is_none()); // empty verb
    }

    #[test]
    fn url_joins_base_and_path() {
        assert_eq!(
            url("http://127.0.0.1:8765", "/vms"),
            "http://127.0.0.1:8765/vms"
        );
        assert_eq!(
            url("http://127.0.0.1:8765", "/vms/web/restart"),
            "http://127.0.0.1:8765/vms/web/restart"
        );
    }

    #[test]
    fn engine_new_builds_the_loopback_base() {
        let e = Engine::new(53019, "tok");
        assert_eq!(e.base, "http://127.0.0.1:53019");
        assert_eq!(e.token, "tok");
    }

    fn tv(name: &str, state: &str, healthy: bool) -> TrayVm {
        TrayVm {
            name: name.into(),
            state: state.into(),
            healthy,
        }
    }
}
