//! Live backdrop for the overlay's glass. A transparent window can't see
//! what's behind it, so to make the glass actually bend the game we grab the
//! screen region under the overlay, hand it to the overlay page, and the
//! page's rim shader bends it along the panel's edge.
//!
//! Cost is kept down on purpose: only while the overlay is open, at a third
//! of the resolution by default (only the rim uses it, bent and softened),
//! JPEG-compressed, at the fps chosen in settings, and a frame identical to
//! the last one is never encoded or sent. The overlay window is excluded from
//! screen capture, so it never captures itself.

use crate::state::AppState;
use std::sync::Arc;
use tauri::AppHandle;

pub const FRAME_EVENT: &str = "backdrop-frame";

/// (live glass on, fps, downscale, overlay visible to screen share)
fn settings(state: &AppState) -> (bool, u64, i32, bool) {
    let a = state.config.get().appearance;
    let enabled = a.get("liveGlass").and_then(|v| v.as_bool()).unwrap_or(true);
    let in_share = a.get("showInShare").and_then(|v| v.as_bool()).unwrap_or(false);
    let fps = a.get("captureFps").and_then(|v| v.as_u64()).unwrap_or(30).clamp(10, 60);
    // downscale divisor per side: 2 sharp, 3 balanced, 4 fastest
    let scale = a.get("captureScale").and_then(|v| v.as_u64()).unwrap_or(3).clamp(2, 4) as i32;
    (enabled, fps, scale, in_share)
}

#[cfg(windows)]
pub fn start(app: AppHandle, state: Arc<AppState>) {
    let _ = std::thread::Builder::new()
        .name("backdrop-capture".into())
        .spawn(move || win::run(app, state));
}

#[cfg(not(windows))]
pub fn start(_app: AppHandle, _state: Arc<AppState>) {}

#[cfg(windows)]
mod win {
    use super::*;
    use base64::Engine;
    use std::time::{Duration, Instant};
    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        COLORONCOLOR, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

    pub fn run(app: AppHandle, state: Arc<AppState>) {
        // the overlay window may not exist the instant setup() runs
        let mut hwnd = None;
        for _ in 0..50 {
            if let Some(w) = app.get_webview_window(crate::window::OVERLAY_LABEL) {
                if let Ok(h) = w.hwnd() {
                    hwnd = Some(HWND(h.0 as *mut core::ffi::c_void));
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let Some(hwnd) = hwnd else { return };
        // Hiding the overlay from capture is what lets live glass see the game
        // under it; without it the glass would refract its own previous frame.
        // The catch: it also hides the overlay from screen share, OBS and
        // screenshots. "Show in screen share" flips that, and live glass
        // pauses while it's on.
        let mut hidden_from_capture: Option<bool> = None;

        let mut grabber = Grabber::default();
        let mut last_hash = 0u64;
        let mut last_sent = Instant::now();
        loop {
            let (enabled, fps, scale, in_share) = settings(&state);
            if hidden_from_capture != Some(!in_share) {
                unsafe {
                    let _ = SetWindowDisplayAffinity(hwnd, if in_share { WDA_NONE } else { WDA_EXCLUDEFROMCAPTURE });
                }
                hidden_from_capture = Some(!in_share);
            }
            let expanded = state.runtime.lock().map(|r| r.expanded).unwrap_or(false);
            if !enabled || in_share || !expanded {
                grabber.release();
                last_hash = 0;
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            let t0 = Instant::now();
            if let Some(px) = unsafe { grabber.grab(hwnd, scale) } {
                // a still screen (a web page, a paused game, the desktop) costs
                // almost nothing: identical frames skip encoding and sending. One
                // frame a second still goes out so the page never goes stale.
                let h = hash(&px.data);
                if h != last_hash || last_sent.elapsed() > Duration::from_secs(1) {
                    last_hash = h;
                    last_sent = Instant::now();
                    if let Some(frame) = encode(&px) {
                        let _ = app.emit_to(crate::window::OVERLAY_LABEL, FRAME_EVENT, frame);
                    }
                }
            }
            let budget = Duration::from_millis(1000 / fps);
            if let Some(rest) = budget.checked_sub(t0.elapsed()) {
                std::thread::sleep(rest);
            }
        }
    }

    pub struct Pixels<'a> {
        pub data: &'a [u8],
        pub w: i32,
        pub h: i32,
    }

    /// FNV-1a over 8-byte words; a few microseconds for a rim-sized frame.
    fn hash(b: &[u8]) -> u64 {
        let mut h = 0xcbf29ce484222325u64;
        for c in b.chunks_exact(8) {
            h = (h ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(0x100000001b3);
        }
        h
    }

    fn encode(px: &Pixels) -> Option<String> {
        let mut jpg = Vec::with_capacity(16 * 1024);
        jpeg_encoder::Encoder::new(&mut jpg, 70)
            .encode(px.data, px.w as u16, px.h as u16, jpeg_encoder::ColorType::Bgra)
            .ok()?;
        Some(base64::engine::general_purpose::STANDARD.encode(&jpg))
    }

    /// Keeps the memory DC, bitmap and pixel buffer between frames instead of
    /// creating and destroying GDI objects 30 times a second.
    #[derive(Default)]
    struct Grabber {
        mem: Option<(HDC, HBITMAP, HGDIOBJ, i32, i32)>,
        buf: Vec<u8>,
    }

    impl Grabber {
        fn release(&mut self) {
            if let Some((mem, bmp, old, _, _)) = self.mem.take() {
                unsafe {
                    SelectObject(mem, old);
                    let _ = DeleteObject(bmp);
                    let _ = DeleteDC(mem);
                }
            }
        }

        /// Downscaled (1/scale per side) BGRA grab of the screen under `hwnd`.
        unsafe fn grab(&mut self, hwnd: HWND, scale: i32) -> Option<Pixels<'_>> {
            let mut r = RECT::default();
            GetWindowRect(hwnd, &mut r).ok()?;
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            let (dw, dh) = (w / scale, h / scale);
            if dw < 4 || dh < 4 {
                return None;
            }
            let screen = GetDC(HWND::default());
            if !matches!(self.mem, Some((_, _, _, mw, mh)) if mw == dw && mh == dh) {
                self.release();
                let mem = CreateCompatibleDC(screen);
                let bmp = CreateCompatibleBitmap(screen, dw, dh);
                let old = SelectObject(mem, bmp);
                // fast point-sampled downscale: the rim bends and softens what
                // it shows, so HALFTONE's expensive filtering buys nothing visible
                SetStretchBltMode(mem, COLORONCOLOR);
                self.mem = Some((mem, bmp, old, dw, dh));
            }
            let (mem, bmp, _, _, _) = self.mem?;
            let blt = StretchBlt(mem, 0, 0, dw, dh, screen, r.left, r.top, w, h, SRCCOPY);
            ReleaseDC(HWND::default(), screen);

            let mut bi = BITMAPINFO::default();
            bi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dw,
                biHeight: -dh, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            self.buf.resize((dw * dh * 4) as usize, 0);
            let lines = GetDIBits(mem, bmp, 0, dh as u32, Some(self.buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            if !blt.as_bool() || lines == 0 {
                return None;
            }
            Some(Pixels { data: &self.buf, w: dw, h: dh })
        }
    }

    impl Drop for Grabber {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

        #[test]
        fn grabs_the_screen_as_a_jpeg_reusing_gdi_objects() {
            let mut g = Grabber::default();
            let size = unsafe { g.grab(GetDesktopWindow(), 3) }.map(|p| (p.w, p.h)).expect("a frame");
            let px = unsafe { g.grab(GetDesktopWindow(), 3) }.expect("a second frame");
            assert_eq!((px.w, px.h), size, "same size on reuse");
            let jpg = base64::engine::general_purpose::STANDARD.decode(encode(&px).expect("encodes")).unwrap();
            assert_eq!(&jpg[..2], &[0xFF, 0xD8], "JPEG start marker");
            assert!(jpg.len() > 500, "non-trivial image, got {} bytes", jpg.len());
        }

        #[test]
        fn identical_frames_hash_the_same() {
            let a = vec![7u8; 4096];
            let mut b = a.clone();
            assert_eq!(hash(&a), hash(&b));
            b[100] = 8;
            assert_ne!(hash(&a), hash(&b));
        }

        #[test]
        #[cfg_attr(debug_assertions, ignore = "timing only meaningful in an optimized build")]
        fn capture_is_fast_enough_for_30fps() {
            let desk = unsafe { GetDesktopWindow() };
            let mut g = Grabber::default();
            let n = 10;
            let (mut grab_t, mut enc_t) = (0.0, 0.0);
            for _ in 0..n {
                let t = std::time::Instant::now();
                let px = unsafe { g.grab(desk, 3) }.unwrap();
                grab_t += t.elapsed().as_secs_f64();
                let t = std::time::Instant::now();
                let _ = encode(&px);
                enc_t += t.elapsed().as_secs_f64();
            }
            let (grab_ms, enc_ms) = (grab_t * 1000.0 / n as f64, enc_t * 1000.0 / n as f64);
            let per = grab_ms + enc_ms;
            println!("full-screen at 1/3: grab {:.1} ms + jpeg {:.1} ms per frame", grab_ms, enc_ms);
            // a whole screen is far bigger than the overlay; even so it must fit a 30fps budget
            assert!(per < 33.0, "too slow: {:.1} ms", per);
        }
    }
}
