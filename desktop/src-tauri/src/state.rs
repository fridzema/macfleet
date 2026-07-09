use serde::Serialize;
use std::sync::Mutex;

/// Per-run API config handed to the webview via `get_api_config`: the ephemeral port the
/// engine sidecar was launched on (so the app never silently talks to a stale server on a
/// fixed port) and the secret token required on every API call. Regenerated each launch.
#[derive(Clone, Serialize)]
pub struct ApiConfig {
    pub port: u16,
    pub token: String,
}

pub struct AppState {
    pub app_name: String,
    pub visit_count: Mutex<u32>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            app_name: "OxideDock".to_string(),
            visit_count: Mutex::new(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_state() {
        let state = AppState::default();
        assert_eq!(state.app_name, "OxideDock");
        assert_eq!(*state.visit_count.lock().unwrap(), 0);
    }

    #[test]
    fn test_visit_count_increment() {
        let state = AppState::default();
        {
            let mut count = state.visit_count.lock().unwrap();
            *count += 1;
        }
        assert_eq!(*state.visit_count.lock().unwrap(), 1);
    }
}
