use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub const BANK_COUNT: usize = 3;
pub const CHANNEL_COUNT: usize = 4;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ChannelConfig {
    /// Stable session id (lowercased exe stem, e.g. "spotify") the channel is
    /// assigned to. None = empty slot.
    pub app_id: Option<String>,
    /// Display name cached at assignment time, shown even if the session is
    /// momentarily not running.
    pub app_name: Option<String>,
    pub bg_color: Option<String>,
    pub sel_color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub last_port: Option<String>,
    pub banks: [[ChannelConfig; CHANNEL_COUNT]; BANK_COUNT],
    /// Persisted so the overlay comes back exactly where you left it —
    /// same bank, same selected channel, same mutes — across restarts.
    /// `#[serde(default)]` so config.json files written before these
    /// fields existed still load instead of silently resetting.
    #[serde(default)]
    pub last_bank: usize,
    #[serde(default)]
    pub last_channel: usize,
    #[serde(default)]
    pub muted: [[bool; CHANNEL_COUNT]; BANK_COUNT],
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            last_port: None,
            banks: Default::default(),
            last_bank: 0,
            last_channel: 0,
            muted: Default::default(),
        }
    }
}

pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<AppConfig>,
}

impl ConfigStore {
    pub fn load(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join("config.json");
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    pub fn get(&self) -> AppConfig {
        self.inner.lock().unwrap().clone()
    }

    pub fn update<F: FnOnce(&mut AppConfig)>(&self, f: F) {
        let mut cfg = self.inner.lock().unwrap();
        f(&mut cfg);
        let cfg_clone = cfg.clone();
        drop(cfg);
        self.persist(&cfg_clone);
    }

    fn persist(&self, cfg: &AppConfig) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(cfg) {
            let _ = fs::write(&self.path, json);
        }
    }
}
