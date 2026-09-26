use crate::config::{AppConfig, BANK_COUNT, CHANNEL_COUNT};
use crate::state::{AppState, HoldInfo, RuntimeState};
use crate::window;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const REPEAT_MS: u64 = 340;
/// How long each step of the hold-cycle lasts. The cycle order is
/// Normal -> Mute -> Solo -> Normal, and a hold always starts at the step
/// *after* the channel's current state, so every step visibly changes
/// something. A quick click (release before the first step) still closes.
const CYCLE_STEP_MS: u64 = 1000;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CycleStage {
    Normal,
    Mute,
    Solo,
}

/// Cycle order. A hold starts at the entry after the channel's current one.
const CYCLE: [CycleStage; 3] = [CycleStage::Normal, CycleStage::Mute, CycleStage::Solo];

fn stage_name(stage: CycleStage) -> &'static str {
    match stage {
        CycleStage::Normal => "normal",
        CycleStage::Mute => "mute",
        CycleStage::Solo => "solo",
    }
}

/// What the overlay needs to draw the hold countdown: how far through the
/// current step, and which stage the next step lands on.
fn hold_info(nav: &NavState, frame: &HwFrame, now: Instant, expanded: bool) -> Option<HoldInfo> {
    if !frame.btn || !expanded {
        return None;
    }
    let started = nav.press_started_at?;
    let elapsed = now.duration_since(started).as_millis() as u64;
    let stage_at = |step: u64| CYCLE[(nav.cycle_base + 1 + step as usize) % CYCLE.len()];
    let next_step = nav.cycle_step.map(|s| s + 1).unwrap_or(0);
    Some(HoldInfo {
        progress: (elapsed % CYCLE_STEP_MS) as f32 / CYCLE_STEP_MS as f32,
        next: stage_name(stage_at(next_step)),
        current: nav.cycle_step.map(|s| stage_name(stage_at(s))),
    })
}

fn stage_index(stage: CycleStage) -> usize {
    CYCLE.iter().position(|s| *s == stage).unwrap_or(0)
}

#[derive(Clone, Copy, Debug)]
enum ButtonAction {
    None,
    Expand,
    Close,
    CycleTo(CycleStage),
}

struct NavState {
    locked_axis: Option<LockedAxis>,
    last_dir: Option<Dir>,
    last_fire_at: Instant,
    btn_prev: bool,
    /// When the current button-down press started, while held on an
    /// already-expanded overlay.
    press_started_at: Option<Instant>,
    /// Which step of the cycle is currently applied for this hold, if the
    /// hold has reached the first step yet. `None` means still under CYCLE_STEP_MS — a release here
    /// is a quick click (closes), not a hold.
    cycle_step: Option<u64>,
    /// The selected channel's stage when this hold began; steps count on
    /// from here so the first step always changes something.
    cycle_base: usize,
    /// True when the current press is the one that opened the overlay —
    /// releasing that same press shouldn't *also* immediately close it.
    opened_this_press: bool,
}

impl NavState {
    fn new() -> Self {
        Self {
            locked_axis: None,
            last_dir: None,
            last_fire_at: Instant::now(),
            btn_prev: false,
            press_started_at: None,
            cycle_step: None,
            cycle_base: 0,
            opened_this_press: false,
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

/// Pure hold-duration, no directional push needed: collapsed -> a quick
/// press expands immediately and *sticks open* (no auto-hide). Expanded ->
/// a quick click (released before the first CYCLE_STEP_MS) closes; holding
/// past that steps live through Normal -> Mute -> Solo -> Normal -> ...
/// every CYCLE_STEP_MS, starting from the step after the channel's current
/// state, applying each stage as it's reached so you can listen for the one
/// you want and just let go. Releasing the very press that opened the
/// overlay never also closes it.
fn step_button(
    nav: &mut NavState,
    frame: &HwFrame,
    now: Instant,
    expanded: bool,
    current: CycleStage,
) -> ButtonAction {
    let mut action = ButtonAction::None;
    let pressed_edge = frame.btn && !nav.btn_prev;
    let released_edge = !frame.btn && nav.btn_prev;

    if pressed_edge {
        if !expanded {
            action = ButtonAction::Expand;
            nav.opened_this_press = true;
            nav.press_started_at = None; // this press already did its job; don't also start the cycle timer
        } else {
            nav.opened_this_press = false;
            nav.press_started_at = Some(now);
            nav.cycle_base = stage_index(current);
        }
        nav.cycle_step = None;
    } else if frame.btn && expanded {
        if let Some(started) = nav.press_started_at {
            let elapsed_ms = now.duration_since(started).as_millis() as u64;
            if elapsed_ms >= CYCLE_STEP_MS {
                let step = (elapsed_ms - CYCLE_STEP_MS) / CYCLE_STEP_MS;
                if nav.cycle_step != Some(step) {
                    nav.cycle_step = Some(step);
                    let stage = CYCLE[(nav.cycle_base + 1 + step as usize) % CYCLE.len()];
                    action = ButtonAction::CycleTo(stage);
                }
            }
        }
    } else if released_edge {
        if !nav.opened_this_press && nav.cycle_step.is_none() && expanded {
            action = ButtonAction::Close;
        }
        nav.press_started_at = None;
        nav.cycle_step = None;
        nav.opened_this_press = false;
    }

    nav.btn_prev = frame.btn;
    action
}

/// Forces the selected channel to an absolute Mute / Solo / Normal state
/// (not a toggle — the hold-cycle needs to set a specific stage each step,
/// not flip whatever was there before). Solo mutes every other assigned
/// channel across all banks and remembers the real baseline so Mute/Normal
/// can cleanly restore it; only that baseline is ever persisted.
fn apply_cycle_stage(
    state: &Arc<AppState>,
    runtime: &mut RuntimeState,
    cfg: &AppConfig,
    b: usize,
    c: usize,
    stage: CycleStage,
) {
    if cfg.banks[b][c].app_id.is_none() {
        return;
    }

    match stage {
        CycleStage::Solo => {
            if runtime.solo != Some((b, c)) {
                let current = runtime.muted;
                let baseline = *runtime.pre_solo_muted.get_or_insert(current);
                runtime.muted = baseline;
                for bb in 0..BANK_COUNT {
                    for cc in 0..CHANNEL_COUNT {
                        if cfg.banks[bb][cc].app_id.is_some() {
                            runtime.muted[bb][cc] = !(bb == b && cc == c);
                        }
                    }
                }
                runtime.solo = Some((b, c));
            }
        }
        CycleStage::Mute | CycleStage::Normal => {
            if runtime.solo.is_some() {
                if let Some(baseline) = runtime.pre_solo_muted.take() {
                    runtime.muted = baseline;
                }
                runtime.solo = None;
            }
            runtime.muted[b][c] = stage == CycleStage::Mute;
        }
    }

    // apply the live effective mute to every assigned session across all
    // banks — solo affects audio that's playing right now regardless of
    // which bank the HUD has active
    for bb in 0..BANK_COUNT {
        for cc in 0..CHANNEL_COUNT {
            if let Some(app_id) = &cfg.banks[bb][cc].app_id {
                state.audio.set_mute(app_id, runtime.muted[bb][cc]);
            }
        }
    }
    // only the baseline (what mute would be with no solo active) is
    // persisted — never the solo-forced mutes, so a restart never leaves
    // channels silently muted with no solo indicator to explain why
    let persisted = runtime.pre_solo_muted.unwrap_or(runtime.muted);
    state.config.update(|cfg| cfg.muted = persisted);
}

fn process_frame(app: &AppHandle, state: &Arc<AppState>, nav: &mut NavState, frame: HwFrame) {
    let now = Instant::now();
    let cfg = state.config.get();
    let mut runtime = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
    let bank = runtime.bank;

    for c in 0..CHANNEL_COUNT {
        runtime.volumes[bank][c] = frame.k[c];
        if let Some(app_id) = &cfg.banks[bank][c].app_id {
            state.audio.set_volume(app_id, frame.k[c] as f32 / 100.0);
        }
    }

    let ui_busy = state.ui_busy.load(std::sync::atomic::Ordering::Relaxed);

    let dir = step_nav(nav, &frame, now);
    // Navigation only applies from a "bare" joystick push — while the
    // button is also held down (mid hold-cycle, see step_button), any
    // stick drift shouldn't change which channel the cycle is targeting.
    if runtime.expanded && !ui_busy && !frame.btn {
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

    // Still stepped every tick regardless of ui_busy so its own press-edge
    // timing doesn't get confused by a gap in ticks — only whether the
    // resulting action gets *applied* is gated.
    let (sb, sc) = (runtime.bank, runtime.channel);
    let current = if runtime.solo == Some((sb, sc)) {
        CycleStage::Solo
    } else if runtime.muted[sb][sc] {
        CycleStage::Mute
    } else {
        CycleStage::Normal
    };
    let action = step_button(nav, &frame, now, runtime.expanded, current);
    runtime.hold = hold_info(nav, &frame, now, runtime.expanded);
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
            ButtonAction::CycleTo(stage) => {
                let b = runtime.bank;
                let c = runtime.channel;
                apply_cycle_stage(state, &mut runtime, &cfg, b, c, stage);
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
        if let Some(prev) = self.stop_current.lock().unwrap_or_else(|e| e.into_inner()).take() {
            prev.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop_current.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop.clone());

        state.set_connected(true);
        state.config.update(|c| c.last_port = Some(port_name.clone()));
        state.emit(&app);

        thread::Builder::new()
            .name("serial-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(port);
                let mut nav = NavState::new();
                // raw bytes, not read_line: read_line errors on any non-UTF-8
                // byte, and the junk an Arduino sends while the port opens or
                // the board resets would drop the connection
                let mut buf: Vec<u8> = Vec::with_capacity(64);
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) => break, // port closed (device unplugged)
                        Ok(_) => {
                            if buf.last() == Some(&b'\n') {
                                let line = String::from_utf8_lossy(&buf);
                                if let Some(frame) = parse_line(&line) {
                                    process_frame(&app, &state, &mut nav, frame);
                                }
                                buf.clear();
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {
                            // a partial line survives a timeout; noise without
                            // newlines can't grow the buffer forever
                            if buf.len() > 256 {
                                buf.clear();
                            }
                            continue;
                        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{AudioBackend, AudioSessionInfo};
    use crate::config::ConfigStore;
    use std::time::Duration;

    fn f(x: XAxis, y: YAxis, btn: bool) -> HwFrame {
        HwFrame { k: [50, 50, 50, 50], x, y, btn }
    }
    fn idle(btn: bool) -> HwFrame {
        f(XAxis::Neutral, YAxis::Neutral, btn)
    }
    fn ms(t0: Instant, n: u64) -> Instant {
        t0 + Duration::from_millis(n)
    }

    #[test]
    fn parses_good_lines_and_drops_torn_ones() {
        let fr = parse_line("34,78,12,55,NEUTRAL,UP,0\r\n").expect("valid line");
        assert_eq!(fr.k, [34, 78, 12, 55]);
        assert_eq!(fr.x, XAxis::Neutral);
        assert_eq!(fr.y, YAxis::Up);
        assert!(!fr.btn);
        assert!(parse_line("34,78,12,55,NEUTRAL,UP").is_none(), "6 fields");
        assert!(parse_line("34,78,12,55,NEUTRAL,UP,0,9").is_none(), "8 fields");
        assert!(parse_line("34,78,1").is_none(), "torn line");
        assert!(parse_line("101,0,0,0,NEUTRAL,NEUTRAL,0").is_none(), "knob over 100");
        assert!(parse_line("0,0,0,0,SIDEWAYS,NEUTRAL,0").is_none(), "bad x label");
        assert!(parse_line("0,0,0,0,NEUTRAL,NEUTRAL,2").is_none(), "bad button");
    }

    #[test]
    fn press_opens_and_its_release_does_not_close() {
        let mut nav = NavState::new();
        let t0 = Instant::now();
        assert!(matches!(step_button(&mut nav, &idle(true), t0, false, CycleStage::Normal), ButtonAction::Expand));
        // the same press is released after the overlay is open: must stay open
        assert!(matches!(step_button(&mut nav, &idle(false), ms(t0, 120), true, CycleStage::Normal), ButtonAction::None));
    }

    #[test]
    fn quick_click_while_open_closes() {
        let mut nav = NavState::new();
        let t0 = Instant::now();
        assert!(matches!(step_button(&mut nav, &idle(true), t0, true, CycleStage::Normal), ButtonAction::None));
        assert!(matches!(step_button(&mut nav, &idle(false), ms(t0, 200), true, CycleStage::Normal), ButtonAction::Close));
    }

    fn hold_sequence(start: CycleStage) -> Vec<CycleStage> {
        let mut nav = NavState::new();
        let t0 = Instant::now();
        step_button(&mut nav, &idle(true), t0, true, start);
        let mut got = vec![];
        let mut t = 50;
        while t <= 3100 {
            if let ButtonAction::CycleTo(s) = step_button(&mut nav, &idle(true), ms(t0, t), true, start) {
                got.push(s);
            }
            t += 50;
        }
        // releasing after a hold that fired must not close the overlay
        assert!(matches!(step_button(&mut nav, &idle(false), ms(t0, t), true, start), ButtonAction::None));
        got
    }

    #[test]
    fn hold_cycles_one_step_per_second_from_normal() {
        assert_eq!(hold_sequence(CycleStage::Normal), vec![CycleStage::Mute, CycleStage::Solo, CycleStage::Normal]);
    }

    #[test]
    fn hold_starts_after_the_current_state() {
        assert_eq!(hold_sequence(CycleStage::Mute), vec![CycleStage::Solo, CycleStage::Normal, CycleStage::Mute]);
        assert_eq!(hold_sequence(CycleStage::Solo), vec![CycleStage::Normal, CycleStage::Mute, CycleStage::Solo]);
    }

    #[test]
    fn hold_info_reports_next_stage() {
        let mut nav = NavState::new();
        let t0 = Instant::now();
        step_button(&mut nav, &idle(true), t0, true, CycleStage::Normal);
        let h = hold_info(&nav, &idle(true), ms(t0, 500), true).expect("holding");
        assert_eq!(h.next, "mute");
        assert!(h.current.is_none());
        assert!((h.progress - 0.5).abs() < 0.01);
        assert!(hold_info(&nav, &idle(false), ms(t0, 500), true).is_none());
    }

    #[test]
    fn nav_locks_to_one_axis_and_repeats() {
        let mut nav = NavState::new();
        let t0 = Instant::now();
        assert_eq!(step_nav(&mut nav, &f(XAxis::Right, YAxis::Neutral, false), t0), Some(Dir::NextChannel));
        // Y pushed while X is still locked: ignored
        assert_eq!(step_nav(&mut nav, &f(XAxis::Right, YAxis::Up, false), ms(t0, 50)), None);
        // still held past the repeat interval: fires again
        assert_eq!(step_nav(&mut nav, &f(XAxis::Right, YAxis::Up, false), ms(t0, 400)), Some(Dir::NextChannel));
        // X released: lock clears, Y can now fire
        assert_eq!(step_nav(&mut nav, &f(XAxis::Neutral, YAxis::Neutral, false), ms(t0, 450)), None);
        assert_eq!(step_nav(&mut nav, &f(XAxis::Neutral, YAxis::Up, false), ms(t0, 500)), Some(Dir::PrevBank));
    }

    struct NoAudio;
    impl AudioBackend for NoAudio {
        fn list_sessions(&self) -> Vec<AudioSessionInfo> { vec![] }
        fn set_volume(&self, _: &str, _: f32) {}
        fn set_mute(&self, _: &str, _: bool) {}
    }

    fn test_state() -> Arc<AppState> {
        let dir = std::env::temp_dir().join(format!("vm2-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = ConfigStore::load(dir);
        store.update(|c| {
            c.banks[0][0].app_id = Some("brave".into());
            c.banks[0][1].app_id = Some("spotify".into());
            c.banks[1][0].app_id = Some("discord".into());
            c.muted[0][1] = true; // spotify starts muted
        });
        Arc::new(AppState::new(store, Box::new(NoAudio)))
    }

    #[test]
    fn solo_mutes_every_bank_and_restores_the_baseline() {
        let state = test_state();
        let cfg = state.config.get();
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());

        apply_cycle_stage(&state, &mut rt, &cfg, 0, 0, CycleStage::Solo);
        assert_eq!(rt.solo, Some((0, 0)));
        assert!(!rt.muted[0][0], "soloed channel plays");
        assert!(rt.muted[0][1] && rt.muted[1][0], "every other assigned channel, in every bank, is muted");
        assert!(!rt.muted[0][2], "empty slots are left alone");

        apply_cycle_stage(&state, &mut rt, &cfg, 0, 0, CycleStage::Normal);
        assert_eq!(rt.solo, None);
        assert!(rt.muted[0][1], "spotify's own mute comes back");
        assert!(!rt.muted[1][0], "discord goes back to unmuted");
        drop(rt);
        assert!(state.config.get().muted[0][1] && !state.config.get().muted[1][0], "only the baseline is persisted");
    }
}
