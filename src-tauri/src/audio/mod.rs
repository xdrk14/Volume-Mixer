#[cfg(windows)]
mod windows_backend;
#[cfg(windows)]
pub use windows_backend::WindowsAudioBackend;

#[cfg(not(windows))]
mod stub_backend;
#[cfg(not(windows))]
pub use stub_backend::StubAudioBackend;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct AudioSessionInfo {
    /// Stable id used for persistence + matching (lowercased exe stem).
    pub id: String,
    pub display_name: String,
}

/// Per-app volume control, abstracted so a macOS/Linux backend can be added
/// later without touching the rest of the app. Windows is the only real
/// implementation for v1 (Core Audio has no public per-app volume API on
/// macOS, and Linux differs by sound server).
pub trait AudioBackend: Send + Sync {
    fn list_sessions(&self) -> Vec<AudioSessionInfo>;
    /// volume01 in [0.0, 1.0]
    fn set_volume(&self, id: &str, volume01: f32);
    fn set_mute(&self, id: &str, muted: bool);
}

#[cfg(windows)]
pub fn create_backend() -> Box<dyn AudioBackend> {
    Box::new(WindowsAudioBackend::new())
}

#[cfg(not(windows))]
pub fn create_backend() -> Box<dyn AudioBackend> {
    Box::new(StubAudioBackend)
}
