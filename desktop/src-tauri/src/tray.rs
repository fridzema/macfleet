use serde::Deserialize;
use std::time::Duration;

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
