use serde::Deserialize;

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

    fn tv(name: &str, state: &str, healthy: bool) -> TrayVm {
        TrayVm {
            name: name.into(),
            state: state.into(),
            healthy,
        }
    }
}
