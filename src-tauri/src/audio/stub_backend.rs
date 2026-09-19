use super::{AudioBackend, AudioSessionInfo};

/// Non-Windows placeholder: per-app volume control has no public API on
/// macOS and works differently per sound server on Linux. Real backends can
/// be added later behind the same `AudioBackend` trait.
pub struct StubAudioBackend;

impl AudioBackend for StubAudioBackend {
    fn list_sessions(&self) -> Vec<AudioSessionInfo> {
        Vec::new()
    }

    fn set_volume(&self, _id: &str, _volume01: f32) {}

    fn set_mute(&self, _id: &str, _muted: bool) {}
}
