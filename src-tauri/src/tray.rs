use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // "Settings" opens the main window — COM port picker, connection
    // status, and the live channel-assignment overview all live there.
    let settings = MenuItem::with_id(app, "settings", "Settings\u{2026}", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &sep, &quit])?;

    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Volume Mixer 2.0")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // double-click also opens settings, same as most tray apps
            if let TrayIconEvent::DoubleClick { .. } = event {
                open_settings(tray.app_handle());
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
