use tauri::{AppHandle, Manager, PhysicalPosition};

pub const OVERLAY_LABEL: &str = "overlay";

/// Overlay must be click-through while collapsed (so it never blocks clicks
/// on a game underneath) and NOT click-through while expanded (so the user
/// can click app names / gear icons with the mouse). Tauri v2 exposes this
/// as `set_ignore_cursor_events` at runtime on the window handle.
pub fn set_overlay_expanded(app: &AppHandle, expanded: bool) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_ignore_cursor_events(!expanded);
    }
}

/// Centers the overlay window horizontally at the top of the primary
/// monitor. Called once at startup; the window itself stays a fixed size
/// (large enough for the expanded panel) and the HTML/CSS inside aligns
/// content to the top, so no resize is needed on expand/collapse.
pub fn position_overlay_top_center(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let Ok(Some(monitor)) = win.primary_monitor() else {
        return;
    };
    let Ok(size) = win.outer_size() else { return };
    let screen = monitor.size();
    let x = (screen.width as i32 - size.width as i32) / 2;
    let y = 16 * monitor.scale_factor().round() as i32;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
