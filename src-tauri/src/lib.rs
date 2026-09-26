mod audio;
mod commands;
mod config;
mod serial;
mod state;
mod tray;
mod window;

use config::ConfigStore;
use state::AppState;
use std::sync::Arc;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("resolve app data dir");
            let config_store = ConfigStore::load(data_dir);
            let last_port = config_store.get().last_port;
            let audio_backend = audio::create_backend();
            let app_state = Arc::new(AppState::new(config_store, audio_backend));
            let serial_mgr = serial::SerialManager::new();

            app.manage(app_state.clone());
            app.manage(serial_mgr);

            tray::build(&app_handle)?;

            window::position_overlay_top_center(&app_handle);
            // starts collapsed: click-through so it never blocks the game underneath
            window::set_overlay_expanded(&app_handle, false);

            // best-effort auto-reconnect to the last-used port; if it fails
            // (unplugged, different port, first run) the main window's
            // manual picker is already visible for the user to pick one
            if let Some(port) = last_port {
                let serial_mgr = app.state::<serial::SerialManager>();
                let _ = serial_mgr.connect(app_handle.clone(), app_state.clone(), port);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_serial_ports,
            commands::connect_serial_port,
            commands::get_state,
            commands::get_config,
            commands::list_audio_sessions,
            commands::assign_channel,
            commands::set_channel_colors,
            commands::set_ui_busy,
            commands::get_appearance,
            commands::set_appearance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
