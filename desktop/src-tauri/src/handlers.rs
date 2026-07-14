use crate::state::ApiConfig;

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_api_config(state: tauri::State<'_, ApiConfig>) -> ApiConfig {
    state.inner().clone()
}
