use crate::config::{BANK_COUNT, CHANNEL_COUNT};
use crate::state::AppState;
use crate::window;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const REPEAT_MS: u64 = 340;
const DBLCLICK_MS: u64 = 320;
const BAUD_RATE: u32 = 115_200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum XAxis {
    Right,
    Left,
    Neutral,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum YAxis {
    Up,
    Down,
    Neutral,
}

#[derive(Clone, Copy, Debug)]
struct HwFrame {
    k: [u8; 4],
    x: XAxis,
    y: YAxis,
    btn: bool,
}

/// Drop any line that doesn't cleanly parse into exactly 7 fields — a torn
/// USB read shouldn't crash the reader thread.
fn parse_line(line: &str) -> Option<HwFrame> {
    let parts: Vec<&str> = line.trim().split(',').collect();
    if parts.len() != 7 {
        return None;
    }
    let mut k = [0u8; 4];
    for i in 0..4 {
        let v: u8 = parts[i].trim().parse().ok()?;
        if v > 100 {
            return None;
        }
        k[i] = v;
    }
    let x = match parts[4].trim() {
        "RIGHT" => XAxis::Right,
        "LEFT" => XAxis::Left,
        "NEUTRAL" => XAxis::Neutral,
        _ => return None,
    };
    let y = match parts[5].trim() {
        "UP" => YAxis::Up,
        "DOWN" => YAxis::Down,
        "NEUTRAL" => YAxis::Neutral,
        _ => return None,
    };
    let btn = match parts[6].trim() {
        "0" => false,
        "1" => true,
        _ => return None,
    };
    Some(HwFrame { k, x, y, btn })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LockedAxis {
    X,
    Y,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dir {
    PrevBank,
    NextBank,
    PrevChannel,
    NextChannel,
}

fn dir_from_x(x: XAxis) -> Option<Dir> {
    match x {
        XAxis::Right => Some(Dir::NextChannel),
        XAxis::Left => Some(Dir::PrevChannel),
        XAxis::Neutral => None,
    }
}

fn dir_from_y(y: YAxis) -> Option<Dir> {
    match y {
        YAxis::Up => Some(Dir::PrevBank),
        YAxis::Down => Some(Dir::NextBank),
        YAxis::Neutral => None,
    }
}

#[derive(Clone, Copy, Debug)]
enum ButtonAction {
    None,
    Expand,
    Close,
    ToggleMute,
}

struct NavState {
    locked_axis: Option<LockedAxis>,
    last_dir: Option<Dir>,
    last_fire_at: Instant,
    btn_prev: bool,
    press_pending_at: Option<Instant>,
}

impl NavState {
    fn new() -> Self {
        Self {
            locked_axis: None,
            last_dir: None,
            last_fire_at: Instant::now(),
            btn_prev: false,
            press_pending_at: None,
        }
    }
}

/// Axis-locked, debounced, repeat-while-held direction from the firmware's
/// raw per-tick labels. The firmware only ever reports the current
/// direction (no edge detection, no release hysteresis vs. fire threshold —
/// see README), so "release" here means the locked axis's label returning
/// to NEUTRAL rather than crossing a separate lower threshold.
fn step_nav(nav: &mut NavState, frame: &HwFrame, now: Instant) -> Option<Dir> {
    if let Some(locked) = nav.locked_axis {
        let neutral = match locked {
            LockedAxis::X => frame.x == XAxis::Neutral,
            LockedAxis::Y => frame.y == YAxis::Neutral,
        };
        if neutral {
            nav.locked_axis = None;
            nav.last_dir = None;
        }
    }

    let (dir, axis) = if let Some(locked) = nav.locked_axis {
        let d = match locked {
            LockedAxis::X => dir_from_x(frame.x),
            LockedAxis::Y => dir_from_y(frame.y),
        };
        (d, locked)
    } else if frame.x != XAxis::Neutral {
        (dir_from_x(frame.x), LockedAxis::X)
    } else if frame.y != YAxis::Neutral {
        (dir_from_y(frame.y), LockedAxis::Y)
    } else {
        (None, LockedAxis::X)
    };

    if dir.is_some() && nav.locked_axis.is_none() {
        nav.locked_axis = Some(axis);
    }

    if dir != nav.last_dir {
        nav.last_dir = dir;
        nav.last_fire_at = now;
        return dir;
    }
    if let Some(d) = dir {
        if now.duration_since(nav.last_fire_at) >= Duration::from_millis(REPEAT_MS) {
            nav.last_fire_at = now;
            return Some(d);
        }
    }
    None
}

/// Press-edge (0->1) driven, per spec: while collapsed, expand immediately;
/// while expanded, wait out a double-click window before muting so a
/// close-via-double-click never fires a mute on the way.
fn step_button(nav: &mut NavState, frame: &HwFrame, now: Instant, expanded: bool) -> ButtonAction {
    let mut action = ButtonAction::None;
    let pressed_edge = frame.btn && !nav.btn_prev;

    if pressed_edge {
        if !expanded {
            action = ButtonAction::Expand;
            nav.press_pending_at = None;
        } else if nav.press_pending_at.is_some() {
            nav.press_pending_at = None;
            action = ButtonAction::Close;
        } else {
            nav.press_pending_at = Some(now);
        }
    } else if let Some(pending_at) = nav.press_pending_at {
        if now.duration_since(pending_at) >= Duration::from_millis(DBLCLICK_MS) {
            nav.press_pending_at = None;
            action = ButtonAction::ToggleMute;
        }
    }

    nav.btn_prev = frame.btn;
    action
}

fn process_frame(app: &AppHandle, state: &Arc<AppState>, nav: &mut NavState, frame: HwFrame) {
    let now = Instant::now();
    let cfg = state.config.get();
    let mut runtime = state.runtime.lock().unwrap();
    let bank = runtime.bank;

    for c in 0..CHANNEL_COUNT {
        runtime.volumes[bank][c] = frame.k[c];
        if let Some(app_id) = &cfg.banks[bank][c].app_id {
            state.audio.set_volume(app_id, frame.k[c] as f32 / 100.0);
        }
    }

    let ui_busy = state.ui_busy.load(std::sync::atomic::Ordering::Relaxed);

    let dir = step_nav(nav, &frame, now);
    if runtime.expanded && !ui_busy {
        if let Some(d) = dir {
            let (prev_bank, prev_channel) = (runtime.bank, runtime.channel);
            match d {
                Dir::PrevBank => runtime.bank = runtime.bank.saturating_sub(1),
                Dir::NextBank => runtime.bank = (runtime.bank + 1).min(BANK_COUNT - 1),
                Dir::PrevChannel => runtime.channel = runtime.channel.saturating_sub(1),
                Dir::NextChannel => runtime.channel = (runtime.channel + 1).min(CHANNEL_COUNT - 1),
            }
            if runtime.bank != prev_bank || runtime.channel != prev_channel {
                let (b, c) = (runtime.bank, runtime.channel);
                state.config.update(|cfg| {
                    cfg.last_bank = b;
                    cfg.last_channel = c;
                });
            }
        }
    }

    // Still stepped every tick regardless of ui_busy so its own press-edge/
    // double-click timing doesn't get confused by a gap in ticks — only
    // whether the resulting action gets *applied* is gated.
    let action = step_button(nav, &frame, now, runtime.expanded);
    if !ui_busy {
        match action {
            ButtonAction::Expand => {
                runtime.expanded = true;
                window::set_overlay_expanded(app, true);
            }
            ButtonAction::Close => {
                runtime.expanded = false;
                window::set_overlay_expanded(app, false);
            }
            ButtonAction::ToggleMute => {
                let b = runtime.bank;
                let c = runtime.channel;
                if let Some(app_id) = cfg.banks[b][c].app_id.clone() {
                    runtime.muted[b][c] = !runtime.muted[b][c];
                    state.audio.set_mute(&app_id, runtime.muted[b][c]);
                    let muted_snapshot = runtime.muted;
                    state.config.update(|cfg| cfg.muted = muted_snapshot);
                }
            }
            ButtonAction::None => {}
        }
    }

    drop(runtime);
    state.emit(app);
}

/// Owns the currently-running reader thread's stop flag so switching ports
/// (or the manual picker retrying) cleanly tears down the previous one.
pub struct SerialManager {
    stop_current: Mutex<Option<Arc<AtomicBool>>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            stop_current: Mutex::new(None),
        }
    }

    pub fn connect(&self, app: AppHandle, state: Arc<AppState>, port_name: String) -> Result<(), String> {
        let port = serialport::new(&port_name, BAUD_RATE)
            .timeout(Duration::from_millis(500))
            .open()
            .map_err(|e| format!("couldn't open {port_name}: {e}"))?;

        // stop whatever reader is currently running before starting a new one
        if let Some(prev) = self.stop_current.lock().unwrap().take() {
            prev.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop_current.lock().unwrap() = Some(stop.clone());

        state.set_connected(true);
        state.config.update(|c| c.last_port = Some(port_name.clone()));
        state.emit(&app);

        thread::Builder::new()
            .name("serial-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(port);
                let mut nav = NavState::new();
                let mut line = String::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break, // port closed (device unplugged)
                        Ok(_) => {
                            if let Some(frame) = parse_line(&line) {
                                process_frame(&app, &state, &mut nav, frame);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(_) => break,
                    }
                }
                if !stop.load(Ordering::Relaxed) {
                    // thread is exiting because of a real error/unplug, not
                    // because a newer connect() superseded it
                    state.set_connected(false);
                    state.emit(&app);
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}
