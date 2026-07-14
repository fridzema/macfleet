use serde::Serialize;

/// Per-run API config handed to the webview via `get_api_config`: the ephemeral port the
/// engine sidecar was launched on (so the app never silently talks to a stale server on a
/// fixed port) and the secret token required on every API call. Regenerated each launch.
#[derive(Clone, Serialize)]
pub struct ApiConfig {
    pub port: u16,
    pub token: String,
}
