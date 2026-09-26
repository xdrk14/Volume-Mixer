use crate::audio::AudioSessionInfo;
use crate::config::AppConfig;
use crate::serial::{self, SerialManager};
use crate::state::{AppState, OverlayPayload};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn get_serial_ports() -> Vec<String> {
    serial::list_ports()
}

#[tauri::command]
pub fn connect_serial_port(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    serial_mgr: State<'_, SerialManager>,
    port: String,
) -> Result<(), String> {
    serial_mgr.connect(app, state.inner().clone(), port)
}

#[tauri::command]
pub fn get_state(state: State<'_, Arc<AppState>>) -> OverlayPayload {
    state.build_payload()
}

#[tauri::command]
pub fn get_config(state: State<'_, Arc<AppState>>) -> AppConfig {
    state.config.get()
}

#[tauri::command]
pub fn list_audio_sessions(state: State<'_, Arc<AppState>>) -> Vec<AudioSessionInfo> {
    state.audio.list_sessions()
}

#[tauri::command]
pub fn get_appearance(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    state.config.get().appearance
}

/// Saves the overlay look and tells every window, so the overlay restyles
/// live while the settings window's sliders move.
#[tauri::command]
pub fn set_appearance(app: AppHandle, state: State<'_, Arc<AppState>>, appearance: serde_json::Value) {
    state.config.update(|cfg| cfg.appearance = appearance.clone());
    let _ = app.emit(crate::state::APPEARANCE_EVENT, appearance);
}

/// The frontend calls this while the app-assignment dropdown or the
/// per-channel color settings panel is open, so hardware nav/mute input
/// can't yank a bank/channel switch (or a mute) out from under an
/// in-progress mouse interaction.
#[tauri::command]
pub fn set_ui_busy(state: State<'_, Arc<AppState>>, busy: bool) {
    state.ui_busy.store(busy, Ordering::Relaxed);
}

#[tauri::command]
pub fn assign_channel(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    bank: usize,
    channel: usize,
    session_id: Option<String>,
    display_name: Option<String>,
) -> Result<(), String> {
    if bank >= crate::config::BANK_COUNT || channel >= crate::config::CHANNEL_COUNT {
        return Err("bank/channel out of range".into());
    }
    state.config.update(|cfg| {
        cfg.banks[bank][channel].app_id = session_id;
        cfg.banks[bank][channel].app_name = display_name;
        cfg.muted[bank][channel] = false;
    });
    {
        let mut runtime = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        runtime.muted[bank][channel] = false;
    }
    state.emit(&app);
    Ok(())
}

#[tauri::command]
pub fn set_channel_colors(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    bank: usize,
    channel: usize,
    bg_color: Option<String>,
    sel_color: Option<String>,
) -> Result<(), String> {
    if bank >= crate::config::BANK_COUNT || channel >= crate::config::CHANNEL_COUNT {
        return Err("bank/channel out of range".into());
    }
    state.config.update(|cfg| {
        cfg.banks[bank][channel].bg_color = bg_color;
        cfg.banks[bank][channel].sel_color = sel_color;
    });
    state.emit(&app);
    Ok(())
}
