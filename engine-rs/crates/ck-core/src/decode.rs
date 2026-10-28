//! Frame input (video_io readers) and the per-frame preprocessing (preprocess_video_frame_views,
//! preprocess_frame_dir_path, the hint readers).
//!
//! By default every input is read exactly as CorridorKey 2.0 reads it (video_io: cv2.VideoCapture -> 8-bit BGR,
//! cv2.imread(IMREAD_COLOR) for PNG/JPEG, then RGB / 255). Video is decoded by ffmpeg with the colour conversion
//! OpenCV's VideoCapture uses (BT.601 matrix, bicubic chroma) to 8-bit RGB, whatever the source's depth: byte-identical
//! to cv2 4.11 on 8-bit H.264 and on 10/12-bit ProRes (tests: `default_reading_is_corridorkey_byte_identical`).
//! Frame folders: 8-bit PNG/JPEG as cv2.imread does, 16-bit PNG reduced to its high byte as cv2's IMREAD_COLOR
//! does, float RGB for EXR (cv2's IMREAD_UNCHANGED).
//!
//! Opt-in `input_bit_depth` 16 (backlog row 27, the film-quality path; `ClipMeta::deep_input`): video above 8 bits
//! (10/12-bit ProRes 4444, DNxHR, HEVC) is decoded to 16-bit RGB and 16-bit PNG read at full depth. That differs
//! from CorridorKey 2.0 on purpose.
use crate::clip::ClipMeta;
use crate::color::{bf16_round, finite_input, linear_to_asinh, linear_to_srgb, srgb_to_linear};
use crate::image::{pad_reflect101, resize_lanczos4, Planar};
use crate::Error;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

/// The ffmpeg filter that reproduces cv2.VideoCapture's YUV -> BGR24 conversion. The 8-bit output must be bgr24 as
/// cv2's: swscale's rgb24 writer rounds differently on 10/12-bit 4:2:2 and 4:2:0 sources (up to 4 levels on more than
/// half the samples, measured 2026-10-25 against cv2 4.11; identical on 8-bit and 4:4:4 sources).
pub(crate) const CV2_SCALE: &str = "scale=in_color_matrix=bt601:flags=bicubic";

/// RGB frames of a video (8-bit, or 16-bit with `input_bit_depth` 16 for sources above 8 bits), from an ffmpeg
/// child process (killed when dropped).
pub(crate) struct VideoDecoder {
    child: Child,
    out: BufReader<ChildStdout>,
    path: PathBuf,
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) decoded: usize,
    buf: Vec<u8>,
    /// 16-bit samples (rgb48le) instead of 8-bit (bgr24, as cv2.VideoCapture)
    deep: bool,
}

impl VideoDecoder {
    /// `deep`: decode at 16 bits (ClipMeta::decode_deep); hint videos stay 8-bit masks.
    /// `start`: the first frame (the job's start frame, `--start_mode`): the frames before it are decoded and
    /// dropped by ffmpeg's `trim` filter, counted as decoded (cv2's CAP_PROP_POS_FRAMES seek lands on the same frame).
    pub(crate) fn open(path: &Path, w: usize, h: usize, start: usize, max_frames: usize, deep: bool) -> Result<VideoDecoder, Error> {
        let vf = if start > 0 { format!("trim=start_frame={start},{CV2_SCALE}") } else { CV2_SCALE.to_string() };
        let mut child = Command::new("ffmpeg")
            .args(["-v", "error", "-nostdin", "-i"])
            .arg(path)
            .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-frames:v"])
            .arg(max_frames.to_string())
            .args(["-vf", &vf, "-f", "rawvideo", "-pix_fmt", if deep { "rgb48le" } else { "bgr24" }, "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error::assets(format!("ffmpeg could not run: {e}")))?;
        let out = BufReader::with_capacity(1 << 20, child.stdout.take().unwrap());
        Ok(VideoDecoder { child, out, path: path.to_path_buf(), w, h, decoded: 0, buf: vec![0; w * h * if deep { 6 } else { 3 }], deep })
    }

    /// The next frame as ffmpeg wrote it (8-bit BGR, or 16-bit RGB when deep), or an error naming the frame that
    /// could not be decoded.
    fn next_raw(&mut self) -> Result<&mut [u8], Error> {
        let mut got = 0;
        // loop: HOT-PATH-OK — read() fills the frame in a few large pieces
        while got < self.buf.len() {
            match self.out.read(&mut self.buf[got..]) {
                Ok(0) => return Err(Error::input(format!("{}: failed decoding frame {}", self.path.display(), self.decoded))),
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Error::input(format!("{}: {e}", self.path.display()))),
            }
        }
        self.decoded += 1;
        Ok(&mut self.buf)
    }

    /// The next frame as interleaved RGB bytes (cv2's BGR frame after cvtColor(BGR2RGB)); 8-bit decoders only.
    pub(crate) fn next_rgb(&mut self) -> Result<&[u8], Error> {
        debug_assert!(!self.deep, "next_rgb reads 8-bit frames");
        use rayon::prelude::*;
        let w = self.w;
        let raw = self.next_raw()?;
        // loop: HOT-PATH-OK — one pass per frame (hint videos and tests; the keyed frames go through next_planar), rows in parallel
        raw.par_chunks_mut(w * 3).with_min_len(crate::image::ROWS_MIN).for_each(|row| row.chunks_exact_mut(3).for_each(|px| px.swap(0, 2)));
        Ok(raw)
    }

    /// The next frame as (3, h, w) float32 in [0, 1], at the depth it was decoded at.
    pub(crate) fn next_planar(&mut self) -> Result<Planar, Error> {
        let (h, w, deep) = (self.h, self.w, self.deep);
        let raw = self.next_raw()?;
        Ok(if deep { rgb48_to_planar(raw, h, w) } else { interleaved8_to_planar(raw, h, w, [2, 1, 0]) })
    }
}

impl Drop for VideoDecoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // loop: NOT-WORTH — reaps the decoder after kill() [bounded: a killed child exits]
        let _ = self.child.wait();
    }
}

/// Interleaved RGB bytes -> (3, h, w) float32 in [0, 1] (`astype(float32) / 255`).
pub fn rgb8_to_planar(rgb: &[u8], h: usize, w: usize) -> Planar {
    interleaved8_to_planar(rgb, h, w, [0, 1, 2])
}

/// Interleaved 8-bit pixels -> (3, h, w) RGB float32 in [0, 1]; `order`: where R, G and B sit in a pixel (BGR: 2, 1, 0).
fn interleaved8_to_planar(rgb: &[u8], h: usize, w: usize, order: [usize; 3]) -> Planar {
    use rayon::prelude::*;
    let [ri, gi, bi] = order;
    let mut p = Planar::new(3, h, w);
    let (r, gb) = p.data.split_at_mut(h * w);
    let (g, b) = gb.split_at_mut(h * w);
    // one pass per frame over its pixels, the rows in parallel
    // loop: HOT-PATH-OK — one pass per decoded frame (~1.4 M pixels), rows in parallel
    r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w * 3)).with_min_len(crate::image::ROWS_MIN).for_each(
        |(((r, g), b), src)| {
            // loop: HOT-PATH-OK — one row of pixels
            for (x, px) in src.chunks_exact(3).enumerate() {
                r[x] = px[ri] as f32 / 255.0;
                g[x] = px[gi] as f32 / 255.0;
                b[x] = px[bi] as f32 / 255.0;
            }
        },
    );
    p
}

/// Interleaved 16-bit little-endian RGB -> (3, h, w) float32 in [0, 1] (`/ 65535`).
pub fn rgb48_to_planar(rgb: &[u8], h: usize, w: usize) -> Planar {
    use rayon::prelude::*;
    let mut p = Planar::new(3, h, w);
    let (r, gb) = p.data.split_at_mut(h * w);
    let (g, b) = gb.split_at_mut(h * w);
    let s = |px: &[u8], c: usize| u16::from_le_bytes([px[2 * c], px[2 * c + 1]]) as f32 / 65535.0;
    // loop: HOT-PATH-OK — one pass per decoded frame, rows in parallel (as rgb8_to_planar)
    r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w * 6)).with_min_len(crate::image::ROWS_MIN).for_each(
        |(((r, g), b), src)| {
            // loop: HOT-PATH-OK — one row of pixels
            for (x, px) in src.chunks_exact(6).enumerate() {
                r[x] = s(px, 0);
                g[x] = s(px, 1);
                b[x] = s(px, 2);
            }
        },
    );
    p
}

/// A decoded still: 8-bit, 16-bit or float samples, 1-4 channels, in the file's channel order (RGB(A)/gray).
pub enum Still {
    U8 { ch: usize, h: usize, w: usize, data: Vec<u8> },
    U16 { ch: usize, h: usize, w: usize, data: Vec<u16> },
    F32 { ch: usize, h: usize, w: usize, data: Vec<f32> },
}

fn is_exr(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("exr")).unwrap_or(false)
}

fn is_jpeg(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")).unwrap_or(false)
}

/// libjpeg-turbo's TurboJPEG library by its per-system names (Linux distributions, the Windows installer and
/// vcpkg, Homebrew on Apple Silicon and Intel Macs).
#[cfg(windows)]
const TURBOJPEG_LIBS: &[&str] = &["turbojpeg.dll"];
#[cfg(target_os = "macos")]
const TURBOJPEG_LIBS: &[&str] =
    &["libturbojpeg.0.dylib", "libturbojpeg.dylib", "/opt/homebrew/lib/libturbojpeg.0.dylib", "/usr/local/lib/libturbojpeg.0.dylib"];
#[cfg(not(any(windows, target_os = "macos")))]
const TURBOJPEG_LIBS: &[&str] = &["libturbojpeg.so.0"];

/// The TurboJPEG library, opened once (None: not installed), and the name it was opened by.
fn turbojpeg() -> Option<&'static (libloading::Library, &'static str)> {
    static LIB: std::sync::OnceLock<Option<(libloading::Library, &'static str)>> = std::sync::OnceLock::new();
    LIB.get_or_init(|| {
        TURBOJPEG_LIBS.iter().find_map(|n| {
            // SAFETY: loading libjpeg-turbo runs only its own initialisers
            unsafe { libloading::Library::new(n) }.ok().map(|l| (l, *n))
        })
    })
    .as_ref()
}

/// Which JPEG decoder frame folders get, in words (the pong's and _settings.txt's `jpeg`): libjpeg-turbo (the one
/// OpenCV uses) with the library it was found as, or the image crate's decoder, which differs by a few levels.
pub fn jpeg_decoder() -> String {
    match turbojpeg() {
        Some((lib, name)) => {
            // SAFETY: only looks a symbol up
            let api = if unsafe { lib.get::<unsafe extern "C" fn()>(b"tj3Init\0") }.is_ok() { "TurboJPEG 3 API" } else { "TurboJPEG 2 API" };
            match loaded_path("turbojpeg") {
                Some(p) => format!("libjpeg-turbo ({p}, {api})"),
                None => format!("libjpeg-turbo ({name}, {api})"),
            }
        }
        None => "image crate (libturbojpeg not found; JPEG frames may differ from OpenCV's by a few levels)".into(),
    }
}

/// Linux: the file a loaded library really is (/proc/self/maps; its name carries the version, e.g.
/// libturbojpeg.so.0.3.0). Elsewhere None.
fn loaded_path(part: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
        maps.lines().filter_map(|l| l.split_whitespace().nth(5)).find(|p| p.contains(part)).map(str::to_string)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = part;
        None
    }
}

/// `bin -version`'s version ("7.1.1" from "ffmpeg version 7.1.1 Copyright ..."), "unknown" when it runs but says
/// something else; Err when it can't be run (30 s deadline).
pub fn tool_version(bin: &str) -> Result<String, String> {
    // loop: NOT-WORTH — one `-version` run, 30 s deadline
    let out = crate::proc::output_timeout(std::process::Command::new(bin).arg("-version"), std::time::Duration::from_secs(30))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(version_token(&text).unwrap_or("unknown").to_string())
}

/// The word after "version" on the first line.
fn version_token(text: &str) -> Option<&str> {
    let mut words = text.lines().next()?.split_whitespace();
    // loop: NOT-WORTH — as above
    words.find(|w| *w == "version")?;
    words.next()
}

/// The decoders a job reads its frames with, for the pong (`decoders`) and _settings.txt (additive).
#[derive(Clone, Debug, PartialEq)]
pub struct Decoders {
    pub jpeg: String,
    pub ffmpeg: String,
    pub ffprobe: String,
}

impl Decoders {
    /// `ffmpeg`: its version when the caller already ran it; else it is asked here.
    pub fn read(ffmpeg: Option<String>) -> Decoders {
        let ver = |bin: &str| tool_version(bin).unwrap_or_else(|_| "not found".into());
        Decoders { jpeg: jpeg_decoder(), ffmpeg: ffmpeg.unwrap_or_else(|| ver("ffmpeg")), ffprobe: ver("ffprobe") }
    }
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({"jpeg": self.jpeg, "ffmpeg": self.ffmpeg, "ffprobe": self.ffprobe})
    }
}

/// JPEG through libjpeg-turbo's TurboJPEG API (opened at run time: `turbojpeg`), the decoder cv2 is built with
/// (accurate integer DCT, smooth chroma upsampling): RGB bytes. None without the library or on a decode error (the
/// image crate's decoder is used then; it differs by a few levels in places).
fn turbojpeg_rgb(buf: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    use std::ffi::{c_int, c_uchar, c_ulong, c_void};
    type Init = unsafe extern "C" fn() -> *mut c_void;
    type Header = unsafe extern "C" fn(*mut c_void, *const c_uchar, c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int) -> c_int;
    type Decomp = unsafe extern "C" fn(*mut c_void, *const c_uchar, c_ulong, *mut c_uchar, c_int, c_int, c_int, c_int, c_int) -> c_int;
    type Destroy = unsafe extern "C" fn(*mut c_void) -> c_int;
    // SAFETY: TurboJPEG 2.x C API with its documented signatures; buffers sized from the header
    unsafe {
        let (lib, _) = turbojpeg()?;
        let init: libloading::Symbol<Init> = lib.get(b"tjInitDecompress\0").ok()?;
        let header: libloading::Symbol<Header> = lib.get(b"tjDecompressHeader3\0").ok()?;
        let decomp: libloading::Symbol<Decomp> = lib.get(b"tjDecompress2\0").ok()?;
        let destroy: libloading::Symbol<Destroy> = lib.get(b"tjDestroy\0").ok()?;
        let h = init();
        if h.is_null() {
            return None;
        }
        let (mut w, mut ht, mut ss, mut cs) = (0, 0, 0, 0);
        let mut out = None;
        if header(h, buf.as_ptr(), buf.len() as c_ulong, &mut w, &mut ht, &mut ss, &mut cs) == 0 && w > 0 && ht > 0 {
            let mut dst = vec![0u8; w as usize * ht as usize * 3];
            // TJPF_RGB = 0, pitch 0 = tight, flags 0 = libjpeg's defaults
            if decomp(h, buf.as_ptr(), buf.len() as c_ulong, dst.as_mut_ptr(), w, 0, ht, 0, 0) == 0 {
                out = Some((w as usize, ht as usize, dst));
            }
        }
        destroy(h);
        out
    }
}

/// Read a still as it is stored (cv2.IMREAD_UNCHANGED, but RGB order).
pub fn read_still(p: &Path) -> Result<Still, Error> {
    if is_exr(p) {
        use exr::prelude::*;
        let img = read_first_rgba_layer_from_file(
            p,
            |res, _| (res.width(), res.height(), vec![0f32; res.width() * res.height() * 3]),
            |(w, _, px), pos, (r, g, b, _a): (f32, f32, f32, f32)| {
                let i = (pos.y() * *w + pos.x()) * 3;
                px[i] = r;
                px[i + 1] = g;
                px[i + 2] = b;
            },
        )
        .map_err(|e| crate::Error::input(format!("{}: {e}", p.display())))?;
        let (w, h, data) = img.layer_data.channel_data.pixels;
        return Ok(Still::F32 { ch: 3, h, w, data });
    }
    if is_jpeg(p) {
        if let Some((w, h, data)) = std::fs::read(p).ok().and_then(|b| turbojpeg_rgb(&b)) {
            return Ok(Still::U8 { ch: 3, h, w, data });
        }
    }
    let img = ::image::ImageReader::open(p)
        .map_err(|e| Error::input(format!("{}: {e}", p.display())))?
        .with_guessed_format()
        .map_err(|e| Error::input(format!("{}: {e}", p.display())))?
        .decode()
        .map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
    let (w, h) = (img.width() as usize, img.height() as usize);
    use ::image::DynamicImage as D;
    Ok(match img {
        D::ImageLuma8(b) => Still::U8 { ch: 1, h, w, data: b.into_raw() },
        D::ImageLumaA8(b) => Still::U8 { ch: 2, h, w, data: b.into_raw() },
        D::ImageRgb8(b) => Still::U8 { ch: 3, h, w, data: b.into_raw() },
        D::ImageRgba8(b) => Still::U8 { ch: 4, h, w, data: b.into_raw() },
        D::ImageLuma16(b) => Still::U16 { ch: 1, h, w, data: b.into_raw() },
        D::ImageLumaA16(b) => Still::U16 { ch: 2, h, w, data: b.into_raw() },
        D::ImageRgb16(b) => Still::U16 { ch: 3, h, w, data: b.into_raw() },
        D::ImageRgba16(b) => Still::U16 { ch: 4, h, w, data: b.into_raw() },
        other => {
            let b = other.to_rgb32f();
            Still::F32 { ch: 3, h, w, data: b.into_raw() }
        }
    })
}

/// A hint still as video_io.read_hint_image's cv2.imread(IMREAD_UNCHANGED) reads it: `read_still`, except an EXR's
/// first layer keeps its alpha (R, G, B and A: 4 channels) and a matte stored as `Y` alone is read (1 channel).
/// Measured against cv2 4.11: an RGBA EXR matte gave its blue channel instead of A, a Y-only EXR was refused ("no
/// layer in the image matched your specified requirements"); cv2 reads both.
pub(crate) fn read_hint_still(p: &Path) -> Result<Still, Error> {
    if !is_exr(p) {
        return read_still(p);
    }
    use exr::prelude::{ReadChannels, ReadLayers};
    let img = exr::prelude::read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .first_valid_layer()
        .all_attributes()
        .from_file(p)
        .map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
    let layer = &img.layer_data;
    let (w, h) = (layer.size.width(), layer.size.height());
    let list = &layer.channel_data.list;
    // loop: NOT-WORTH — a few channels, once per hint file
    let find = |n: &str| list.iter().find(|c| c.name.eq_case_insensitive(n));
    let picked: Vec<_> = match (find("R"), find("G"), find("B"), find("Y")) {
        // loop: NOT-WORTH — four channels at most
        (Some(r), Some(g), Some(b), _) => [Some(r), Some(g), Some(b), find("A")].into_iter().flatten().collect(),
        (_, _, _, Some(y)) => vec![y],
        _ => return Err(Error::input(format!("{}: no R, G, B or Y channels for a matte", p.display()))),
    };
    let ch = picked.len();
    let mut data = vec![0f32; w * h * ch];
    // loop: NOT-WORTH — ≤ four channels of one hint frame, each one pass
    for (c, chan) in picked.iter().enumerate() {
        // loop: HOT-PATH-OK — one channel's samples into the interleaved hint (hint EXRs only)
        for (i, v) in chan.sample_data.values_as_f32().enumerate().take(w * h) {
            data[i * ch + c] = v;
        }
    }
    Ok(Still::F32 { ch, h, w, data })
}

/// An EXR layer whose data window isn't its display window (overscan, or an autocropped frame) is refused: the
/// engine reads the data window as the whole frame and writes it at the origin, so it would key, and write, the wrong
/// region (whole-code review 2026-10-27; backlog rows 30 h and 34 read and keep both windows).
fn exr_whole_frame(hd: &exr::meta::header::Header, p: &Path) -> Result<(), Error> {
    let (data, display) = (hd.data_window(), hd.shared_attributes.display_window);
    if data == display {
        return Ok(());
    }
    let b = |r: exr::meta::attribute::IntegerBounds| format!("{}x{} at ({}, {})", r.size.x(), r.size.y(), r.position.x(), r.position.y());
    Err(Error::input(format!(
        "{}: its data window ({}) isn't its display window ({}): cropped or overscan EXR frames aren't read yet; write whole frames",
        p.display(),
        b(data),
        b(display)
    )))
}

/// (h, w) of a still without keeping its pixels.
pub(crate) fn image_size(p: &Path) -> Result<(usize, usize), Error> {
    if is_exr(p) {
        // the header only (decoding a 4K frame to learn its size took ~50 ms): the first layer with R, G and B,
        // the one read_still reads
        let meta = exr::meta::MetaData::read_from_file(p, false).map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
        let has = |hd: &exr::meta::header::Header, c: &str| hd.channels.list.iter().any(|ch| ch.name.eq_case_insensitive(c));
        // loop: NOT-WORTH — a few layers, once per clip
        let hd = meta
            .headers
            .iter()
            .find(|hd| has(hd, "R") && has(hd, "G") && has(hd, "B"))
            .ok_or_else(|| Error::input(format!("{}: no RGB layer", p.display())))?;
        exr_whole_frame(hd, p)?;
        return Ok((hd.layer_size.height(), hd.layer_size.width()));
    }
    let (w, h) = ::image::image_dimensions(p).map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
    Ok((h as usize, w as usize))
}

/// (h, w) of a still from its header, refused past `clip::MAX_SIDE` before any pixel is allocated: the decoders
/// allocate what the header claims (senior Rust review 2026-10-26 M1: a frame claiming 100000x100000 aborted the engine).
pub(crate) fn still_size(p: &Path) -> Result<(usize, usize), Error> {
    let (h, w) = match image_size(p) {
        Ok(s) => s,
        // a matte stored as Y alone (a hint EXR) has no RGB layer: the first layer's size, the one read_hint_still reads
        Err(_) if is_exr(p) => {
            let meta = exr::meta::MetaData::read_from_file(p, false).map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
            let hd = meta.headers.first().ok_or_else(|| Error::input(format!("{}: no layer", p.display())))?;
            exr_whole_frame(hd, p)?;
            (hd.layer_size.height(), hd.layer_size.width())
        }
        Err(e) => return Err(e),
    };
    let max = crate::clip::MAX_SIDE;
    if h > max || w > max {
        return Err(Error::input(format!("{}: {w}x{h} is larger than the engine takes ({max} pixels in each direction)", p.display())));
    }
    Ok((h, w))
}

/// video_io.read_image_rgb: cv2.imread(IMREAD_COLOR) / 255 for PNG/JPEG (gray replicated, alpha dropped,
/// 16-bit reduced to its high byte), the float RGB of an EXR. `deep` (`input_bit_depth` 16): 16-bit PNG at full
/// depth (/ 65535) instead.
pub fn read_image_rgb(p: &Path, deep: bool) -> Result<Planar, Error> {
    let to_planar = |ch: usize, h: usize, w: usize, get: &dyn Fn(usize) -> f32| {
        let mut out = Planar::new(3, h, w);
        let n = h * w;
        // loop: HOT-PATH-OK — one pass per frame over its pixels
        for i in 0..n {
            let (r, g, b) = if ch < 3 { (i * ch, i * ch, i * ch) } else { (i * ch, i * ch + 1, i * ch + 2) };
            out.data[i] = get(r);
            out.data[n + i] = get(g);
            out.data[2 * n + i] = get(b);
        }
        out
    };
    Ok(match read_still(p)? {
        Still::U8 { ch, h, w, data } => to_planar(ch, h, w, &|i| data[i] as f32 / 255.0),
        // 16-bit PNG at full depth (opt-in: the film-quality path keeps all 16 bits)
        Still::U16 { ch, h, w, data } if deep => to_planar(ch, h, w, &|i| data[i] as f32 / 65535.0),
        // cv2.imread(IMREAD_COLOR) keeps the high byte (libpng's strip_16), then / 255
        Still::U16 { ch, h, w, data } => to_planar(ch, h, w, &|i| (data[i] >> 8) as f32 / 255.0),
        Still::F32 { ch, h, w, data } => to_planar(ch, h, w, &|i| data[i]),
    })
}

/// One frame, ready for the networks: padded, both views rounded to bfloat16 as the runtime's tensors.
///  - `model`: signed-asinh scene-linear RGB (stage 1 and stage 2 input);
///  - `display`: display-coded RGB in [0, 1] (the foundation models' and RVM's input).
///
/// Shared (`Arc`): a frame sits in two overlapping windows and stage 2's queue without being copied.
#[derive(Clone)]
pub struct Prepped {
    pub model: std::sync::Arc<Vec<half::bf16>>,
    pub display: std::sync::Arc<Vec<half::bf16>>,
}

/// preprocess_video_frame_views / preprocess_frame_dir_path at model_scale 1.0 with no linear adjust:
/// `display` (3, h, w) in display coding (clipped to [0, 1]), or for scene-linear EXR folders `linear`.
pub fn prep_frame(display_or_linear: Planar, exr_linear: bool, meta: &ClipMeta, denom: f32) -> Prepped {
    prep_frame_views(display_or_linear, exr_linear, meta, denom, true)
}

/// `prep_frame`; without `need_model` only the display view (the RVM and foundation passes need no more,
/// as the runtime's need_model=False readers). Spread over the cores.
///
/// A colour-managed clip (`meta.color_in`, backlog row 29): the decoded values are the clip's own code values (EXR
/// float, 16-bit or 8-bit / full scale), made finite, converted by OCIO to linear Rec.709 in float32, and then take
/// the scene-linear path below (model view signed, negatives kept: decision 3; display view clipped).
pub(crate) fn prep_frame_views(display_or_linear: Planar, exr_linear: bool, meta: &ClipMeta, denom: f32, need_model: bool) -> Prepped {
    use rayon::prelude::*;
    let (display_or_linear, exr_linear) = match &meta.color_in {
        Some(x) => (to_model_space(display_or_linear, x), true),
        None => (display_or_linear, exr_linear),
    };
    if meta.scaled() || !meta.adjust.is_identity() {
        return prep_scaled_or_adjusted(display_or_linear, exr_linear, meta, denom, need_model);
    }
    let padded = if meta.pad == (crate::image::Pad { l: 0, r: 0, t: 0, b: 0 }) { display_or_linear } else { pad_reflect101(&display_or_linear, meta.pad) };
    // EXR frames can hold NaN / infinity: made finite first (`finite_input`), a no-op for every finite value
    let display_of = |v: f32| {
        let v = finite_input(v);
        if exr_linear {
            linear_to_srgb(v.max(0.0)).clamp(0.0, 1.0)
        } else {
            v.clamp(0.0, 1.0)
        }
    };
    // loop: HOT-PATH-OK — one pass per frame, parallel; the frame's display view (bf16) is the output, one allocation per frame
    let display: Vec<half::bf16> = padded.data.par_iter().with_min_len(1 << 14).map(|&v| half::bf16::from_f32(display_of(v))).collect();
    let model: Vec<half::bf16> = if need_model {
        padded
            .data
            // loop: HOT-PATH-OK — one pass per frame, parallel; the model view (bf16) is the output, one allocation per frame
            .par_iter()
            .with_min_len(1 << 14)
            .map(|&v| {
                let v = finite_input(v);
                let lin = if exr_linear { v } else { srgb_to_linear(v.clamp(0.0, 1.0)) };
                half::bf16::from_f32(linear_to_asinh(lin, denom))
            })
            .collect()
    } else {
        Vec::new()
    };
    Prepped { model: std::sync::Arc::new(model), display: std::sync::Arc::new(display) }
}

/// `prep_frame_views` at a model scale (backlog row 42) or with the linear adjust (row 45), in the original's order:
///  - video (preprocess_video_frame_views): the display-coded frame Lanczos-4 resized to the model size (values may
///    ring past [0, 1] and are kept), padded; linear = srgb_to_linear of it, adjusted; the model view its asinh;
///    the display view the resized frame itself, or with the adjust linear_to_vfm_sdr of the adjusted linear;
///  - frame folders (preprocess_frame_dir_path, no adjust): display and linear made at the native size (EXR: from
///    the linear values; else linear from the clipped display), each resized; display clipped again, both padded.
fn prep_scaled_or_adjusted(img: Planar, exr_linear: bool, meta: &ClipMeta, denom: f32, need_model: bool) -> Prepped {
    use rayon::prelude::*;
    let to_model = |p: Planar| {
        let p = if meta.scaled() { resize_lanczos4(&p, meta.model_h, meta.model_w) } else { p };
        if meta.pad == (crate::image::Pad { l: 0, r: 0, t: 0, b: 0 }) {
            p
        } else {
            pad_reflect101(&p, meta.pad)
        }
    };
    let bf = |v: &[f32], f: &(dyn Fn(f32) -> f32 + Sync)| -> Vec<half::bf16> {
        // loop: HOT-PATH-OK — one pass per frame view, parallel; the view (bf16) is the output
        v.par_iter().with_min_len(1 << 14).map(|&x| half::bf16::from_f32(f(x))).collect()
    };
    if matches!(meta.source, crate::clip::Source::Video(_)) && !exr_linear {
        let frame = to_model(img);
        let adj = meta.adjust;
        let lin_model = move |v: f32| adj.apply(srgb_to_linear(v));
        let display = if adj.is_identity() { bf(&frame.data, &|v| v) } else { bf(&frame.data, &|v| linear_to_srgb(lin_model(v).max(0.0)).clamp(0.0, 1.0)) };
        let model = if need_model { bf(&frame.data, &|v| linear_to_asinh(lin_model(v), denom)) } else { Vec::new() };
        return Prepped { model: std::sync::Arc::new(model), display: std::sync::Arc::new(display) };
    }
    let mut disp = img.clone();
    let mut lin = img;
    // loop: HOT-PATH-OK — one pass per frame, parallel, in place
    disp.data.par_iter_mut().zip(lin.data.par_iter_mut()).with_min_len(1 << 14).for_each(|(d, l)| {
        let v = finite_input(*l);
        if exr_linear {
            *d = linear_to_srgb(v.max(0.0)).clamp(0.0, 1.0);
            *l = v;
        } else {
            *d = v.clamp(0.0, 1.0);
            *l = srgb_to_linear(*d);
        }
    });
    let disp = to_model(disp);
    let display = bf(&disp.data, &|v| v.clamp(0.0, 1.0));
    let model = if need_model { bf(&to_model(lin).data, &|v| linear_to_asinh(v, denom)) } else { Vec::new() };
    Prepped { model: std::sync::Arc::new(model), display: std::sync::Arc::new(display) }
}

/// A colour-managed frame to the model's space: NaN / infinity made finite first (OCIO's matrices would spread one
/// NaN to the other channels), the input processor in float32 (rows in parallel), and finite again (a matrix can
/// take values near INPUT_MAX past float32's range).
fn to_model_space(mut img: Planar, x: &crate::ocio::Xform) -> Planar {
    use rayon::prelude::*;
    // loop: HOT-PATH-OK — one pass per frame, parallel, in place
    img.data.par_iter_mut().with_min_len(1 << 14).for_each(|v| *v = finite_input(*v));
    x.apply_planar(&mut img.data, img.h, img.w);
    // loop: HOT-PATH-OK — as above
    img.data.par_iter_mut().with_min_len(1 << 14).for_each(|v| *v = finite_input(*v));
    img
}

/// A clip's frames in order, ready for the networks (a `FrameReader`, or a test's frames made in memory).
pub(crate) trait FrameStream: Send + 'static {
    /// The next frame (None after the last).
    fn next_frame(&mut self) -> Result<Option<Prepped>, Error>;
    /// Seconds spent so far decoding and preprocessing.
    fn seconds(&self) -> f64;
}

impl FrameStream for FrameReader {
    fn next_frame(&mut self) -> Result<Option<Prepped>, Error> {
        FrameReader::next_frame(self)
    }
    fn seconds(&self) -> f64 {
        self.seconds
    }
}

/// Sequential frames of a clip (video or folder), decoded and preprocessed in order.
pub(crate) struct FrameReader {
    /// measured: seconds decoding + preprocessing
    pub(crate) seconds: f64,
    meta: ClipMeta,
    video: Option<VideoDecoder>,
    next: usize,
    denom: f32,
    need_model: bool,
    /// frame folders: frames decoded together, handed out in order
    ready: std::collections::VecDeque<Result<Prepped, Error>>,
}

/// Frames of a folder decoded at once. Measured 2026-10-24, a 4K EXR frame on one thread: 46 ms decode +
/// 9 ms to planar + prep; the RVM and foundation passes waited on it with the card mostly idle. Each frame in
/// flight costs ~0.2 GB at 4K.
const FOLDER_BATCH: usize = 4;

impl FrameReader {
    pub(crate) fn open(meta: &ClipMeta) -> Result<FrameReader, Error> {
        let video = match &meta.source {
            crate::clip::Source::Video(p) => Some(VideoDecoder::open(p, meta.w, meta.h, meta.start_frame, meta.num_frames, meta.decode_deep())?),
            crate::clip::Source::Frames(_) => None,
        };
        Ok(FrameReader { seconds: 0.0, meta: meta.clone(), video, next: 0, denom: crate::color::asinh_denom(), need_model: true, ready: Default::default() })
    }

    /// Only the display view (the RVM / foundation passes).
    pub(crate) fn display_only(mut self) -> FrameReader {
        self.need_model = false;
        self
    }

    /// The next frame (None after num_frames).
    pub(crate) fn next_frame(&mut self) -> Result<Option<Prepped>, Error> {
        if let Some(p) = self.ready.pop_front() {
            return p.map(Some);
        }
        if self.next >= self.meta.num_frames {
            return Ok(None);
        }
        let t0 = std::time::Instant::now();
        let out = match (&mut self.video, &self.meta.source) {
            (Some(v), _) => {
                let img = v.next_planar()?;
                self.next += 1;
                Ok(Some(prep_frame_views(img, self.meta.exr_linear, &self.meta, self.denom, self.need_model)))
            }
            (None, crate::clip::Source::Frames(paths)) => {
                use rayon::prelude::*;
                let end = (self.next + FOLDER_BATCH).min(self.meta.num_frames);
                let (meta, denom, need_model) = (&self.meta, self.denom, self.need_model);
                // loop: PARALLELIZE — FOLDER_BATCH frames decode at once on the pool; collected in order
                let done: Vec<Result<Prepped, Error>> = paths[self.next..end]
                    .par_iter()
                    .map(|p| {
                        let differs = |h: usize, w: usize| {
                            Error::input(format!("{}: frame size {w}x{h} differs from the first frame's {}x{}", p.display(), meta.w, meta.h))
                        };
                        // the header's size first: a frame is only decoded (allocated) at the clip's size
                        let (h, w) = still_size(p)?;
                        if (h, w) != (meta.h, meta.w) {
                            return Err(differs(h, w));
                        }
                        let img = read_image_rgb(p, meta.deep_input)?;
                        if (img.h, img.w) != (meta.h, meta.w) {
                            return Err(differs(img.h, img.w));
                        }
                        Ok(prep_frame_views(img, meta.exr_linear, meta, denom, need_model))
                    })
                    .collect();
                self.next = end;
                self.ready = done.into();
                self.ready.pop_front().unwrap().map(Some)
            }
            _ => unreachable!(),
        };
        self.seconds += t0.elapsed().as_secs_f64();
        out
    }
}

/// A frame stream (a FrameReader) on its own thread, a few frames ahead (the runtime prefetches its prepass chunks
/// the same way): decoding overlaps the networks.
pub(crate) struct Prefetch {
    frames: crate::ahead::Ahead<Prepped>,
    /// the reader's own decode + preprocessing seconds
    seconds: crate::ahead::Seconds,
}

impl Prefetch {
    /// `reader` on a thread named `name`, `depth` frames ahead (a panic in the decoder is the next frame's error).
    pub(crate) fn new(name: &str, mut reader: Box<dyn FrameStream>, depth: usize) -> Result<Prefetch, Error> {
        let seconds = crate::ahead::Seconds::default();
        let s2 = seconds.clone();
        // loop: SERIAL-REQUIRED — the prefetch thread: decodes in order; ends at the clip's end, an error, or a dropped receiver
        let frames = crate::ahead::Ahead::spawn(name, depth, move || {
            let item = reader.next_frame();
            s2.set(reader.seconds());
            item
        })?;
        Ok(Prefetch { frames, seconds })
    }

    /// The next frame, or None at the end.
    pub(crate) fn next_frame(&mut self) -> Result<Option<Prepped>, Error> {
        // loop: SERIAL-REQUIRED — frames in order [bounded: the prefetch thread ends at the clip's end (ffmpeg closes its pipe) or an error]
        self.frames.next_item()
    }

    /// Seconds the decoding thread spent (decode + preprocessing).
    pub(crate) fn seconds(&self) -> f64 {
        self.seconds.get()
    }
}

/// cv2.cvtColor(BGR2GRAY) of one pixel given as R, G, B: fixed point (14 bits) for integers.
#[inline]
fn gray_int(r: u32, g: u32, b: u32) -> u32 {
    (b * 1868 + g * 9617 + r * 4899 + (1 << 13)) >> 14
}

/// preprocess_hint_frame for a decoded still / video frame: gray (cvtColor for colour), normalised by its bit
/// depth, Lanczos-4 to the model size when it differs, clipped, padded; bfloat16 values.
pub fn prep_hint(still: Still, meta: &ClipMeta) -> Vec<f32> {
    let (h, w, g): (usize, usize, Vec<f32>) = match still {
        Still::U8 { ch, h, w, data } => {
            let g = (0..h * w)
                .map(|i| {
                    if ch >= 3 {
                        gray_int(data[i * ch] as u32, data[i * ch + 1] as u32, data[i * ch + 2] as u32) as f32 / 255.0
                    } else {
                        data[i * ch] as f32 / 255.0
                    }
                })
                .collect();
            (h, w, g)
        }
        Still::U16 { ch, h, w, data } => {
            let g = (0..h * w)
                .map(|i| {
                    if ch >= 3 {
                        gray_int(data[i * ch] as u32, data[i * ch + 1] as u32, data[i * ch + 2] as u32) as f32 / 65535.0
                    } else {
                        data[i * ch] as f32 / 65535.0
                    }
                })
                .collect();
            (h, w, g)
        }
        Still::F32 { ch, h, w, data } => {
            let g =
                // loop: HOT-PATH-OK — per hint frame (float EXR hints only), one pass; hints are optional
                (0..h * w).map(|i| if ch >= 3 { data[i * ch + 2] * 0.114 + data[i * ch + 1] * 0.587 + data[i * ch] * 0.299 } else { data[i * ch] }).collect();
            (h, w, g)
        }
    };
    let mut p = Planar::from_vec(1, h, w, g);
    // made finite before the resize: a NaN in a float hint spread to every pixel whose taps reach it (an 8x8 block
    // at 2x), which then became 0
    p.map(finite_input);
    if (h, w) != (meta.model_h, meta.model_w) {
        p = resize_lanczos4(&p, meta.model_h, meta.model_w);
    }
    p.map(|v| finite_input(v).clamp(0.0, 1.0));
    let mut out = pad_reflect101(&p, meta.pad);
    out.map(bf16_round);
    out.data
}

/// video_io.read_hint_image + load_initial_hint_frame: the first-frame matte (a file, or the first frame of a
/// folder). 4 channels: the alpha; 3: the first channel cv2 reads (blue); 2 (grey + alpha): the alpha, as cv2 reads
/// such a PNG as BGRA; its size must be the clip's.
pub fn load_initial_hint(path: &Path, meta: &ClipMeta) -> Result<Vec<f32>, Error> {
    let file = if path.is_dir() {
        crate::clip::frame_paths(path)?.into_iter().find(|p| p.is_file())
    } else if path.is_file() {
        Some(path.to_path_buf())
    } else {
        None
    };
    let file = file.ok_or_else(|| Error::input(format!("No hint frame found at {}", path.display())))?;
    let pick = |ch: usize| {
        if ch == 4 {
            3
        } else if ch == 3 {
            2
        } else if ch == 2 {
            1
        } else {
            0
        }
    }; // BGR(A) index 0 = blue = RGB index 2; grey + alpha: cv2 makes it BGRA, so the alpha
       // the header's size first: only a hint of the clip's (or the model's) size is decoded
    let (hh, hw) = still_size(&file)?;
    if (hh, hw) != (meta.h, meta.w) && (hh, hw) != (meta.model_h, meta.model_w) {
        return Err(Error::input(format!("{}: hint shape ({hh}, {hw}) does not match the clip ({}, {})", file.display(), meta.h, meta.w)));
    }
    let (h, w, g): (usize, usize, Vec<f32>) = match read_hint_still(&file)? {
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::U8 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)] as f32 / 255.0).collect()),
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::U16 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)] as f32 / 65535.0).collect()),
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::F32 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)]).collect()),
    };
    // the clip's size (resized to the model's at a model scale), or already the model's (load_initial_hint_frame)
    let model = (meta.model_h, meta.model_w);
    if (h, w) != (meta.h, meta.w) && (h, w) != model {
        return Err(Error::input(format!("{}: hint shape ({h}, {w}) does not match the clip ({}, {})", file.display(), meta.h, meta.w)));
    }
    let mut p = Planar::from_vec(1, h, w, g);
    // read_hint_image clips before the resize; nothing clips after it
    p.map(|v| finite_input(v).clamp(0.0, 1.0));
    if (h, w) != model {
        p = resize_lanczos4(&p, model.0, model.1);
    }
    let mut out = pad_reflect101(&p, meta.pad);
    out.map(bf16_round);
    Ok(out.data)
}

/// A full hint, one matte per frame: a video or a folder of stills (make_hint_reader).
pub(crate) struct HintReader {
    meta: ClipMeta,
    video: Option<VideoDecoder>,
    paths: Vec<PathBuf>,
    next: usize,
}

impl HintReader {
    pub(crate) fn open(path: &Path, meta: &ClipMeta) -> Result<HintReader, Error> {
        if path.is_dir() {
            let paths = crate::clip::frame_paths(path)?;
            // a ranged job's hint folder starts at the span's first frame (ClipMeta::select_range); otherwise at 0, as before
            let first = if meta.range.is_some() { meta.start_frame } else { 0 };
            if paths.len() < first + meta.num_frames {
                return Err(Error::input(format!("{}: only {} hint frames for {} source frames", path.display(), paths.len(), first + meta.num_frames)));
            }
            return Ok(HintReader { meta: meta.clone(), video: None, paths, next: first });
        }
        let p = crate::clip::ffprobe(path)?;
        // decoded at its own size (resized to the model's after): refused past MAX_SIDE before ffmpeg's frames are allocated
        if p.w > crate::clip::MAX_SIDE || p.h > crate::clip::MAX_SIDE {
            return Err(Error::input(format!(
                "Hint video {}: {}x{} is larger than the engine takes ({} pixels in each direction)",
                path.display(),
                p.w,
                p.h,
                crate::clip::MAX_SIDE
            )));
        }
        // the hint video starts at the clip's start frame (SequentialHintVideoWindowReader)
        let required = meta.start_frame + meta.num_frames;
        if p.frames > 0 && p.frames < required {
            let start = if meta.start_frame > 0 { format!(" (start={}, num={})", meta.start_frame, meta.num_frames) } else { String::new() };
            return Err(Error::input(format!(
                "Hint video {} has only {} frames, but the source video requires {required} frames{start}",
                path.display(),
                p.frames,
            )));
        }
        Ok(HintReader {
            meta: meta.clone(),
            video: Some(VideoDecoder::open(path, p.w, p.h, meta.start_frame, meta.num_frames, false)?),
            paths: vec![],
            next: 0,
        })
    }

    pub(crate) fn next_frame(&mut self) -> Result<Vec<f32>, Error> {
        let still = match &mut self.video {
            Some(v) => {
                let (w, h) = (v.w, v.h);
                Still::U8 { ch: 3, h, w, data: v.next_rgb()?.to_vec() }
            }
            None => {
                // the header's size first (MAX_SIDE), before the still's pixels are allocated
                still_size(&self.paths[self.next])?;
                read_hint_still(&self.paths[self.next])?
            }
        };
        self.next += 1;
        Ok(prep_hint(still, &self.meta))
    }
}

/// A real w x h RGB EXR whose header then claims `claim_w` x `claim_h` (its data window patched, as in the senior Rust
/// review's M1 reproduction): what the decoders would allocate from. The display window is patched the same, so the
/// header is a whole frame of that size (not a cropped one, which the header check refuses first).
#[cfg(test)]
pub(crate) fn exr_claiming(path: &Path, w: usize, h: usize, claim_w: i32, claim_h: i32) {
    crate::writers::write_exr(path, w, h, 3, &vec![0.5f32; w * h * 3], crate::writers::ExrType::Float).unwrap();
    let lines = exr::meta::MetaData::read_from_file(path, false).unwrap().headers[0].compression.scan_lines_per_block() as i32;
    let mut b = std::fs::read(path).unwrap();
    // loop: NOT-WORTH — a test file's header bytes, three times
    let value_at = |b: &[u8], key: &[u8]| b.windows(key.len()).position(|k| k == key).unwrap() + key.len() + 4;
    // loop: NOT-WORTH — the two windows
    for key in [&b"dataWindow\0box2i\0"[..], &b"displayWindow\0box2i\0"[..]] {
        let at = value_at(&b, key);
        b[at + 8..at + 12].copy_from_slice(&(claim_w - 1).to_le_bytes());
        b[at + 12..at + 16].copy_from_slice(&(claim_h - 1).to_le_bytes());
    }
    // the chunk count the header states follows the claimed size, so a reader that checks it gets as far as allocating
    let at = value_at(&b, b"chunkCount\0int\0");
    b[at..at + 4].copy_from_slice(&((claim_h + lines - 1) / lines).to_le_bytes());
    std::fs::write(path, b).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// senior Rust review 2026-10-26 M1: a later frame of a folder whose header claims 100000x100000 is a clean error
    /// before it is decoded (it was decoded first, and the 120 GB allocation aborted the engine); a hint the same
    #[test]
    fn a_frame_claiming_a_huge_size_is_an_error_before_it_is_decoded() {
        let dir = std::env::temp_dir().join(format!("ck-huge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::writers::write_exr(&dir.join("f_0001.exr"), 16, 8, 3, &[0.5f32; 16 * 8 * 3], crate::writers::ExrType::Float).unwrap();
        exr_claiming(&dir.join("f_0002.exr"), 16, 8, 100_000, 100_000);
        let meta = crate::clip::probe_size(&dir, -1, 1.0).unwrap();
        assert_eq!((meta.w, meta.h, meta.num_frames), (16, 8, 2));
        let mut r = FrameReader::open(&meta).unwrap();
        assert!(r.next_frame().unwrap().is_some());
        let e = r.next_frame().err().expect("an error");
        let hint = load_initial_hint(&dir.join("f_0002.exr"), &meta).unwrap_err();
        let mut hints = HintReader::open(&dir, &meta).unwrap();
        hints.next_frame().unwrap();
        let later_hint = hints.next_frame().unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(e.code, crate::ErrorCode::Input);
        assert!(e.message.contains("100000x100000 is larger than the engine takes (16384"), "{}", e.message);
        assert!(hint.message.contains("100000x100000 is larger"), "{}", hint.message);
        assert!(later_hint.message.contains("100000x100000 is larger"), "{}", later_hint.message);
    }

    /// A later frame of another (allowed) size is refused from its header, with the size it has.
    #[test]
    fn a_later_frame_of_another_size_is_refused_from_its_header() {
        let dir = std::env::temp_dir().join(format!("ck-size2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::writers::write_exr(&dir.join("f_0001.exr"), 16, 8, 3, &[0.5f32; 16 * 8 * 3], crate::writers::ExrType::Float).unwrap();
        // the pixels are 16x8, the header says 4000x3000: the header's size is the one reported (nothing decoded)
        exr_claiming(&dir.join("f_0002.exr"), 16, 8, 4000, 3000);
        let meta = crate::clip::probe_size(&dir, -1, 1.0).unwrap();
        let mut r = FrameReader::open(&meta).unwrap();
        r.next_frame().unwrap();
        let e = r.next_frame().err().expect("an error");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(e.message.ends_with("frame size 4000x3000 differs from the first frame's 16x8"), "{}", e.message);
    }

    #[test]
    fn gray_matches_cv2_fixed_point() {
        assert_eq!(gray_int(255, 255, 255), 255);
        assert_eq!(gray_int(0, 0, 0), 0);
        assert_eq!(gray_int(255, 0, 0), 76); // cv2: BGR(0,0,255) -> 76
        assert_eq!(gray_int(0, 255, 0), 150);
        assert_eq!(gray_int(0, 0, 255), 29);
    }

    #[test]
    fn non_finite_frame_values_reach_the_networks_finite() {
        let meta = ClipMeta {
            source: crate::clip::Source::Frames(vec![]),
            fps: 24.0,
            h: 1,
            w: 4,
            model_h: 1,
            model_w: 4,
            model_scale: 1.0,
            start_frame: 0,
            adjust: Default::default(),
            shape_h: 1,
            shape_w: 4,
            pad: crate::image::Pad { l: 0, r: 0, t: 0, b: 0 },
            num_frames: 1,
            video_bits: 8,
            deep_input: false,
            exr_linear: true,
            color_in: None,
            range: None,
        };
        // loop: NOT-WORTH — both EXR codings
        for linear in [true, false] {
            let v = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.5];
            let p = prep_frame(Planar::from_vec(3, 1, 4, v.repeat(3)), linear, &meta, crate::color::asinh_denom());
            // loop: NOT-WORTH — twelve values
            assert!(p.model.iter().chain(p.display.iter()).all(|x| x.to_f32().is_finite()), "linear={linear}: {:?} {:?}", p.model, p.display);
        }
    }

    #[test]
    fn decoder_versions_are_read_and_reported() {
        assert_eq!(version_token("ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc"), Some("7.1.1"));
        assert_eq!(version_token("ffprobe version n8.0-12-gabc Copyright"), Some("n8.0-12-gabc"));
        assert_eq!(version_token("something else"), None);
        assert!(tool_version("ck-no-such-program-here").is_err());
        let d = Decoders::read(Some("7.1.1".into()));
        assert_eq!(d.ffmpeg, "7.1.1");
        assert!(d.jpeg.starts_with("libjpeg-turbo (") || d.jpeg.starts_with("image crate"), "{}", d.jpeg);
        let j = d.to_json();
        assert_eq!(j["ffmpeg"], "7.1.1");
        assert!(j["ffprobe"].is_string() && j["jpeg"].is_string());
    }

    #[test]
    fn rgb48_to_planes_keeps_16_bits() {
        // 65535 -> 1.0, 0 -> 0.0, and a value an 8-bit read can't hold (257*51 + 128)
        let v: u16 = 257 * 51 + 128;
        let px: Vec<u8> = [65535u16, 0, v, 0, 65535, 1].iter().flat_map(|x| x.to_le_bytes()).collect();
        let p = rgb48_to_planar(&px, 1, 2);
        assert_eq!(p.data, vec![1.0, 0.0, 0.0, 1.0, v as f32 / 65535.0, 1.0 / 65535.0]);
        assert!((p.data[4] - 51.0 / 255.0).abs() > 1e-4, "more than 8 bits survive");
    }

    /// The default reading is CorridorKey 2.0's own reader, byte for byte: the 12-bit ProRes 4444 and 10-bit ProRes
    /// 422 HQ clips through cv2.VideoCapture, the 16-bit PNGs through cv2.imread(IMREAD_COLOR), against the uint8 RGB
    /// cv2 made of them (tests/fixtures/input, tools/gen_input_fixtures.py). Video: the strict check runs on x86-64
    /// Linux, where the references were made (another platform's ffmpeg build prints its difference).
    #[test]
    fn default_reading_is_corridorkey_byte_identical() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/input");
        let reference = |name: &str| std::fs::read(dir.join(format!("{name}.cv2.rgb"))).unwrap();
        let count = |a: &[u8], b: &[u8]| a.iter().zip(b).filter(|(x, y)| x != y).count();
        // (3, h, w) floats that must be 8-bit levels / 255 -> interleaved RGB bytes
        let to_bytes = |p: &Planar, name: &str| -> Vec<u8> {
            let n = p.h * p.w;
            // loop: NOT-WORTH — a 64x48 fixture
            assert!(p.data.iter().all(|v| (v * 255.0).round() / 255.0 == *v), "{name}: not 8-bit levels / 255");
            // loop: NOT-WORTH — as above
            (0..3 * n).map(|i| (p.data[(i % 3) * n + i / 3] * 255.0).round() as u8).collect()
        };
        // loop: NOT-WORTH — three stills
        for name in ["rgb16.png", "rgba16.png", "gray16.png"] {
            let got = to_bytes(&read_image_rgb(&dir.join(name), false).unwrap(), name);
            let want = reference(name);
            assert_eq!(got.len(), want.len(), "{name}: size");
            assert_eq!(count(&got, &want), 0, "{name}: bytes differ from cv2.imread(IMREAD_COLOR)");
            println!("{name}: {} bytes identical to CorridorKey 2.0's read", got.len());
        }
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("no ffmpeg: video skipped");
            return;
        }
        // loop: NOT-WORTH — two clips
        for name in ["prores4444_12bit.mov", "prores422hq_10bit.mov"] {
            let path = dir.join(name);
            let meta = crate::clip::probe_video(&path, &crate::clip::ProbeOpts::frames(-1)).unwrap();
            assert!(meta.video_bits > 8 && !meta.deep_input && !meta.decode_deep(), "{name}: the default must read at 8 bits");
            let mut v = VideoDecoder::open(&path, meta.w, meta.h, meta.start_frame, meta.num_frames, meta.decode_deep()).unwrap();
            let mut got = Vec::new();
            // loop: NOT-WORTH — the fixture's three frames
            for _ in 0..meta.num_frames {
                // the keyed path (next_planar: / 255 floats), back to bytes
                let p = v.next_planar().unwrap();
                got.extend(to_bytes(&p, name));
            }
            let want = reference(name);
            assert_eq!(got.len(), want.len(), "{name}: size");
            let differ = count(&got, &want);
            println!("{name} ({}-bit): {differ} of {} bytes differ from cv2.VideoCapture", meta.video_bits, got.len());
            if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
                assert_eq!(differ, 0, "{name}: bytes differ from cv2.VideoCapture");
            }
            // input_bit_depth 16 opts in to the deep decode
            assert!(ClipMeta { deep_input: true, ..meta }.decode_deep());
        }
    }

    #[test]
    fn rgb_bytes_to_planes() {
        let p = rgb8_to_planar(&[255, 0, 51, 0, 255, 102], 1, 2);
        assert_eq!(p.data, vec![1.0, 0.0, 0.0, 1.0, 0.2, 0.4]);
    }

    /// bug hunt 2026-10-26: the first-frame hint is the matte cv2.imread(IMREAD_UNCHANGED) gives
    /// (video_io.read_hint_image), measured with cv2 4.11: a grey + alpha PNG reads as BGRA (its alpha is the matte; it
    /// took the grey), an RGBA EXR keeps its A (it took blue), a Y-only EXR is read (it was refused).
    #[test]
    fn first_frame_hint_reads_the_matte_cv2_reads() {
        use exr::prelude::{AnyChannel, AnyChannels, FlatSamples, Image, WritableImage};
        let dir = std::env::temp_dir().join(format!("ck-hint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (h, w) = (8, 8);
        let meta = ClipMeta::with_shape(crate::clip::Source::Frames(vec![]), 24.0, h, w, 1, false, 1.0);
        let centre = |v: &[f32]| v[(meta.pad.t + 4) * meta.shape_w + meta.pad.l + 4];
        // grey 255, alpha 51: the matte is 0.2
        let la = dir.join("la.png");
        ::image::GrayAlphaImage::from_pixel(w as u32, h as u32, ::image::LumaA([255, 51])).save(&la).unwrap();
        // RGBA EXR (written B, G, R, A as the engine writes a cutout): blue 0.3, alpha 0.9
        let rgba = dir.join("rgba.exr");
        let px: Vec<f32> = (0..h * w).flat_map(|_| [0.3f32, 0.2, 0.1, 0.9]).collect();
        crate::writers::write_exr(&rgba, w, h, 4, &px, crate::writers::ExrType::Float).unwrap();
        // a matte as Y alone (cv2.imwrite of a one-channel float image): 0.7
        let y = dir.join("y.exr");
        let chans = AnyChannels::sort(vec![AnyChannel::new("Y", FlatSamples::F32(vec![0.7; h * w]))].into_iter().collect());
        Image::from_channels((w, h), chans).write().to_file(&y).unwrap();
        let got: Vec<std::result::Result<f32, String>> =
            [&la, &rgba, &y].into_iter().map(|p| load_initial_hint(p, &meta).map(|v| centre(&v)).map_err(|e| e.message)).collect();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got, vec![Ok(bf16_round(51.0 / 255.0)), Ok(bf16_round(0.9)), Ok(bf16_round(0.7))]);
    }

    /// whole-code review 2026-10-27: an EXR whose data window isn't its display window (autocropped, overscan) was
    /// keyed as if the data window were the frame; it is refused until rows 30 h / 34
    #[test]
    fn a_cropped_exr_frame_is_refused() {
        use exr::prelude::*;
        let dir = std::env::temp_dir().join(format!("ck-crop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rgb = |n: usize| AnyChannels::sort(["B", "G", "R"].map(|c| AnyChannel::new(c, FlatSamples::F32(vec![0.5; n]))).into_iter().collect());
        let at = LayerAttributes { layer_position: Vec2(2, 2), ..LayerAttributes::default() };
        // 4x4 pixels at (2, 2) of an 8x8 frame (autocropped), and a whole one written the same way
        let cropped = dir.join("crop.exr");
        Image::new(ImageAttributes::new(IntegerBounds::from_dimensions((8, 8))), Layer::new((4, 4), at, Encoding::FAST_LOSSLESS, rgb(16)))
            .write()
            .to_file(&cropped)
            .unwrap();
        let whole = dir.join("whole.exr");
        Image::from_layer(Layer::new((8, 8), LayerAttributes::default(), Encoding::FAST_LOSSLESS, rgb(64))).write().to_file(&whole).unwrap();
        let (c, w) = (still_size(&cropped), still_size(&whole));
        std::fs::remove_dir_all(&dir).unwrap();
        let e = c.unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Input);
        assert!(e.message.contains("data window (4x4 at (2, 2)) isn't its display window (8x8 at (0, 0))"), "{}", e.message);
        assert_eq!(w.unwrap(), (8, 8));
    }

    /// bug hunt 2026-10-26: a NaN in a float hint frame that is resized (model scale) became 0 over a whole block (it
    /// spread through the Lanczos taps first); made finite first, only its own neighbourhood dips.
    #[test]
    fn a_nan_hint_pixel_stays_local_when_resized() {
        let (h, w) = (8, 8);
        let meta = ClipMeta::with_shape(crate::clip::Source::Frames(vec![]), 24.0, h, w, 1, false, 2.0);
        let mut g = vec![1.0f32; h * w];
        g[4 * w + 4] = f32::NAN;
        let out = prep_hint(Still::F32 { ch: 1, h, w, data: g }, &meta);
        let zeros = (0..meta.model_h)
            .flat_map(|y| (0..meta.model_w).map(move |x| (y, x)))
            .filter(|&(y, x)| out[(meta.pad.t + y) * meta.shape_w + meta.pad.l + x] == 0.0)
            .count();
        assert!(zeros <= 4, "{zeros} hint pixels became 0 around one NaN");
    }
}
