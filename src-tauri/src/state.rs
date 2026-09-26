use crate::audio::AudioBackend;
use crate::config::{ConfigStore, BANK_COUNT, CHANNEL_COUNT};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub const STATE_EVENT: &str = "overlay-state";
pub const APPEARANCE_EVENT: &str = "appearance-changed";

/// Progress of an in-flight hold on the joystick button, so the overlay can
/// show how long until the next mute/solo/normal step.
#[derive(Clone, Debug, Serialize)]
pub struct HoldInfo {
    /// 0.0..1.0 through the current step
    pub progress: f32,
    /// the stage the next step will apply: "normal" | "mute" | "solo"
    pub next: &'static str,
    /// the stage this hold has applied so far, if any
    pub current: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChannelPayload {
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub volume: u8,
    pub muted: bool,
    /// True only for the one channel currently soloed (if any) — see
    /// `RuntimeState::solo`.
    pub solo: bool,
    pub bg_color: Option<String>,
    pub sel_color: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OverlayPayload {
    pub connected: bool,
    pub expanded: bool,
    pub bank: usize,
    pub channel: usize,
    pub banks: Vec<Vec<ChannelPayload>>,
    pub hold: Option<HoldInfo>,
}

#[derive(Debug)]
pub struct RuntimeState {
    pub expanded: bool,
    pub bank: usize,
    pub channel: usize,
    /// Live effective mute per slot — what's actually applied to audio and
    /// shown in the UI. While `solo` is active this includes the
    /// solo-forced mutes on every other channel; `pre_solo_muted` holds
    /// the real baseline underneath so it can be restored.
    pub muted: [[bool; CHANNEL_COUNT]; BANK_COUNT],
    /// The one (bank, channel) currently soloed, if any. Solo is global —
    /// it mutes every other assigned channel across all banks, not just
    /// the active one, since an app's Windows audio session keeps playing
    /// regardless of which bank the HUD currently has active.
    pub solo: Option<(usize, usize)>,
    /// Snapshot of `muted` from just before solo engaged. `None` when no
    /// solo is active. This is the config's persisted baseline — solo
    /// itself is a momentary audition tool and is never persisted.
    pub pre_solo_muted: Option<[[bool; CHANNEL_COUNT]; BANK_COUNT]>,
    /// Set every tick by the serial thread while the button is being held.
    pub hold: Option<HoldInfo>,
    /// Last known live volume per slot (0-100). Only the active bank's
    /// values are driven by real knob ticks; the rest hold their last value.
    pub volumes: [[u8; CHANNEL_COUNT]; BANK_COUNT],
}

impl RuntimeState {
    /// Restores the last-saved bank/channel/mute state so the overlay comes
    /// back exactly where it was left, across app restarts. Always starts
    /// collapsed regardless of what was saved — the HUD shouldn't pop up
    /// expanded (and non-click-through) the moment the app launches.
    fn from_config(cfg: &crate::config::AppConfig) -> Self {
        Self {
            expanded: false,
            bank: cfg.last_bank.min(BANK_COUNT - 1),
            channel: cfg.last_channel.min(CHANNEL_COUNT - 1),
            muted: cfg.muted,
            solo: None,
            pre_solo_muted: None,
            hold: None,
            volumes: Default::default(),
        }
    }
}

pub struct AppState {
    pub config: ConfigStore,
    pub audio: Box<dyn AudioBackend>,
    pub runtime: Mutex<RuntimeState>,
    pub connected: AtomicBool,
    /// True while the frontend has a mouse-only panel open (the app
    /// dropdown or the per-channel color settings). While true, hardware
    /// nav/button input is still read (to keep its own debounce timing
    /// consistent) but not applied — otherwise a joystick nudge (or just
    /// drift) mid-drag yanks the bank/channel out from under an open panel
    /// and closes it on you.
    pub ui_busy: AtomicBool,
    /// JSON of the last state sent to the windows, to skip identical re-sends.
    last_emitted: Mutex<String>,
}

impl AppState {
    pub fn new(config: ConfigStore, audio: Box<dyn AudioBackend>) -> Self {
        let runtime = RuntimeState::from_config(&config.get());
        // Windows itself keeps a session's mute flag as long as that
        // session survives, but re-apply on our end too in case the app
        // producing audio was restarted independently of us.
        for (b, bank) in config.get().banks.iter().enumerate() {
            for (c, chan) in bank.iter().enumerate() {
                if runtime.muted[b][c] {
                    if let Some(app_id) = &chan.app_id {
                        audio.set_mute(app_id, true);
                    }
                }
            }
        }
        Self {
            config,
            audio,
            runtime: Mutex::new(runtime),
            connected: AtomicBool::new(false),
            ui_busy: AtomicBool::new(false),
            last_emitted: Mutex::new(String::new()),
        }
    }

    pub fn set_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn build_payload(&self) -> OverlayPayload {
        let cfg = self.config.get();
        let runtime = self.runtime.lock().unwrap();
        let mut banks = Vec::with_capacity(BANK_COUNT);
        for b in 0..BANK_COUNT {
            let mut chans = Vec::with_capacity(CHANNEL_COUNT);
            for c in 0..CHANNEL_COUNT {
                let cc = &cfg.banks[b][c];
                chans.push(ChannelPayload {
                    app_id: cc.app_id.clone(),
                    app_name: cc.app_name.clone(),
                    volume: if cc.app_id.is_some() {
                        runtime.volumes[b][c]
                    } else {
                        0
                    },
                    muted: runtime.muted[b][c],
                    solo: runtime.solo == Some((b, c)),
                    bg_color: cc.bg_color.clone(),
                    sel_color: cc.sel_color.clone(),
                });
            }
            banks.push(chans);
        }
        OverlayPayload {
            connected: self.is_connected(),
            expanded: runtime.expanded,
            bank: runtime.bank,
            channel: runtime.channel,
            banks,
            hold: runtime.hold.clone(),
        }
    }

    /// Sends the state to both windows, but only when it differs from the
    /// last one sent. The serial thread calls this on every 20 Hz controller
    /// frame; most of those change nothing, and skipping them saves both
    /// windows a JSON parse and a render pass each time. A window that loads
    /// later asks for the current state with `get_state`, so nothing is lost.
    pub fn emit(&self, app: &AppHandle) {
        let payload = self.build_payload();
        let Ok(json) = serde_json::to_string(&payload) else { return };
        {
            let mut last = self.last_emitted.lock().unwrap();
            if *last == json {
                return;
            }
            *last = json;
        }
        let _ = app.emit(STATE_EVENT, payload);
    }
}
