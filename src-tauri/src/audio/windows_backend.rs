//! Windows Core Audio (WASAPI session) backend, per-app volume/mute via
//! ISimpleAudioVolume. All COM work happens on one dedicated STA thread —
//! COM apartment/thread affinity means these interfaces can't just be
//! shared across whatever thread a Tauri command happens to run on, so
//! everything is funneled through a channel instead.
//!
//! NOTE: this is hand-written against the `windows` crate's typical 0.58
//! surface for these interfaces. It has not been compiled in this
//! environment (no Rust toolchain available here) — if `cargo check` flags
//! a signature mismatch, check docs.rs/windows for the installed version;
//! COM binding signatures occasionally shift between minor versions.

use super::{AudioBackend, AudioSessionInfo};
use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, BOOL};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

enum Cmd {
    List(Sender<Vec<AudioSessionInfo>>),
    SetVolume(String, f32),
    SetMute(String, bool),
}

pub struct WindowsAudioBackend {
    tx: Sender<Cmd>,
}

impl WindowsAudioBackend {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();
        thread::Builder::new()
            .name("audio-com".into())
            .spawn(move || audio_thread(rx))
            .expect("failed to spawn audio COM thread");
        Self { tx }
    }
}

impl AudioBackend for WindowsAudioBackend {
    fn list_sessions(&self) -> Vec<AudioSessionInfo> {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(Cmd::List(reply_tx)).is_err() {
            return Vec::new();
        }
        reply_rx.recv().unwrap_or_default()
    }

    fn set_volume(&self, id: &str, volume01: f32) {
        let _ = self
            .tx
            .send(Cmd::SetVolume(id.to_string(), volume01.clamp(0.0, 1.0)));
    }

    fn set_mute(&self, id: &str, muted: bool) {
        let _ = self.tx.send(Cmd::SetMute(id.to_string(), muted));
    }
}

/// Some apps (Discord notably) run more than one simultaneous audio
/// session under the same process — e.g. a voice-call stream and a
/// separate UI-sounds stream — so a single exe id can map to several live
/// `ISimpleAudioVolume`s that all need to move together.
type Cache = HashMap<String, Vec<ISimpleAudioVolume>>;

/// How often a `SetVolume`/`SetMute` call forces a full re-enumeration even
/// on a cache *hit*. A session that gets torn down and recreated (Discord
/// does this constantly — its audio session comes and goes with voice
/// calls) leaves behind a stale, silently-no-op'ing COM reference; only
/// refreshing on a miss never notices that. A time-based refresh bounds
/// how stale the cache can get without re-enumerating on every single
/// knob tick (which fires at 20Hz per assigned channel).
const MAX_CACHE_AGE: Duration = Duration::from_millis(1500);

fn audio_thread(rx: mpsc::Receiver<Cmd>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let mut cache: Cache = HashMap::new();
    let mut cache_built_at = Instant::now() - MAX_CACHE_AGE;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::List(reply) => {
                let sessions = unsafe { list_all_sessions(&mut cache) };
                cache_built_at = Instant::now();
                let _ = reply.send(sessions);
            }
            Cmd::SetVolume(id, vol) => unsafe {
                apply(&mut cache, &mut cache_built_at, &id, |v| {
                    let _ = v.SetMasterVolume(vol, std::ptr::null());
                });
            },
            Cmd::SetMute(id, muted) => unsafe {
                apply(&mut cache, &mut cache_built_at, &id, |v| {
                    let _ = v.SetMute(BOOL::from(muted), std::ptr::null());
                });
            },
        }
    }

    unsafe { CoUninitialize() };
}

unsafe fn apply<F: Fn(&ISimpleAudioVolume)>(
    cache: &mut Cache,
    cache_built_at: &mut Instant,
    id: &str,
    f: F,
) {
    let stale = cache_built_at.elapsed() >= MAX_CACHE_AGE;
    if stale || !cache.contains_key(id) {
        let _ = list_all_sessions(cache);
        *cache_built_at = Instant::now();
    }
    if let Some(sessions) = cache.get(id) {
        for v in sessions {
            f(v);
        }
    }
}

unsafe fn get_session_manager() -> windows::core::Result<IAudioSessionManager2> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device: IMMDevice = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
    device.Activate(CLSCTX_ALL, None)
}

unsafe fn list_all_sessions(cache: &mut Cache) -> Vec<AudioSessionInfo> {
    cache.clear();
    let mut out = Vec::new();
    let Ok(manager) = get_session_manager() else {
        return out;
    };
    let Ok(session_enum) = manager.GetSessionEnumerator() else {
        return out;
    };
    let Ok(count) = session_enum.GetCount() else {
        return out;
    };

    for i in 0..count {
        let Ok(control) = session_enum.GetSession(i) else {
            continue;
        };
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
            continue;
        };
        let Ok(pid) = control2.GetProcessId() else {
            continue;
        };
        if pid == 0 {
            continue; // system sounds session — nothing to attribute to an app
        }
        let Some(exe_stem) = process_exe_stem(pid) else {
            continue;
        };
        let Ok(simple_volume) = control.cast::<ISimpleAudioVolume>() else {
            continue;
        };

        let id = exe_stem.to_lowercase();
        if !cache.contains_key(&id) {
            let display_name = display_name_for(&control2, &exe_stem);
            out.push(AudioSessionInfo {
                id: id.clone(),
                display_name,
            });
        }
        cache.entry(id).or_default().push(simple_volume);
    }
    out
}

unsafe fn process_exe_stem(pid: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let result = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut len,
    );
    let _ = CloseHandle(handle);
    if result.is_err() {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let stem = std::path::Path::new(&path)
        .file_stem()?
        .to_string_lossy()
        .to_string();
    Some(stem)
}

unsafe fn display_name_for(control2: &IAudioSessionControl2, exe_stem: &str) -> String {
    if let Ok(pwstr) = control2.GetDisplayName() {
        if !pwstr.is_null() {
            if let Ok(s) = pwstr.to_string() {
                CoTaskMemFree(Some(pwstr.0 as *const _));
                if !s.is_empty() && !s.starts_with('@') {
                    return s;
                }
            }
        }
    }
    title_case(exe_stem)
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}
