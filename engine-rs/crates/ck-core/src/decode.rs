//! Frame input (video_io readers) and the per-frame preprocessing (preprocess_video_frame_views,
//! preprocess_frame_dir_path, the hint readers).
//!
//! Video is decoded by ffmpeg into 8-bit RGB with the colour conversion OpenCV's VideoCapture uses (BT.601
//! matrix, bicubic chroma): measured bit-identical to cv2 4.11 on a ProRes 4444 plate, an untagged and a
//! BT.709-tagged H.264 clip and a 10-bit 4:4:4 clip (docs/ENGINE_RUST.md). Frame folders are read as
//! cv2.imread does: 8-bit RGB for PNG/JPEG (16-bit PNGs keep their high byte), float RGB for EXR.
use crate::clip::ClipMeta;
use crate::color::{bf16_round, finite_input, linear_to_asinh, linear_to_srgb, srgb_to_linear};
use crate::image::{pad_reflect101, resize_lanczos4, Planar};
use crate::Error;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

/// The ffmpeg filter that reproduces cv2.VideoCapture's YUV -> BGR24 conversion.
pub(crate) const CV2_SCALE: &str = "scale=in_color_matrix=bt601:flags=bicubic";

/// 8-bit RGB frames of a video, from an ffmpeg child process (killed when dropped).
pub(crate) struct VideoDecoder {
    child: Child,
    out: BufReader<ChildStdout>,
    path: PathBuf,
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) decoded: usize,
    buf: Vec<u8>,
}

impl VideoDecoder {
    pub(crate) fn open(path: &Path, w: usize, h: usize, max_frames: usize) -> Result<VideoDecoder, Error> {
        let mut child = Command::new("ffmpeg")
            .args(["-v", "error", "-nostdin", "-i"])
            .arg(path)
            .args(["-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-frames:v"])
            .arg(max_frames.to_string())
            .args(["-vf", CV2_SCALE, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error::assets(format!("ffmpeg could not run: {e}")))?;
        let out = BufReader::with_capacity(1 << 20, child.stdout.take().unwrap());
        Ok(VideoDecoder { child, out, path: path.to_path_buf(), w, h, decoded: 0, buf: vec![0; w * h * 3] })
    }

    /// The next frame as interleaved RGB bytes, or an error naming the frame that could not be decoded.
    pub(crate) fn next_rgb(&mut self) -> Result<&[u8], Error> {
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
        Ok(&self.buf)
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
    use rayon::prelude::*;
    let mut p = Planar::new(3, h, w);
    let (r, gb) = p.data.split_at_mut(h * w);
    let (g, b) = gb.split_at_mut(h * w);
    // one pass per frame over its pixels, the rows in parallel
    // loop: HOT-PATH-OK — one pass per decoded frame (~1.4 M pixels), rows in parallel (this pass: was one thread)
    r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w * 3)).with_min_len(crate::image::ROWS_MIN).for_each(
        |(((r, g), b), src)| {
            // loop: HOT-PATH-OK — one row of pixels
            for (x, px) in src.chunks_exact(3).enumerate() {
                r[x] = px[0] as f32 / 255.0;
                g[x] = px[1] as f32 / 255.0;
                b[x] = px[2] as f32 / 255.0;
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

/// JPEG through libjpeg-turbo's TurboJPEG API (libturbojpeg.so.0, opened at run time), the decoder cv2 is
/// built with (accurate integer DCT, smooth chroma upsampling): RGB bytes. None without the library or on a
/// decode error (the image crate's decoder is used then; it differs by a few levels in places).
fn turbojpeg_rgb(buf: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    use std::ffi::{c_int, c_uchar, c_ulong, c_void};
    type Init = unsafe extern "C" fn() -> *mut c_void;
    type Header = unsafe extern "C" fn(*mut c_void, *const c_uchar, c_ulong, *mut c_int, *mut c_int, *mut c_int, *mut c_int) -> c_int;
    type Decomp = unsafe extern "C" fn(*mut c_void, *const c_uchar, c_ulong, *mut c_uchar, c_int, c_int, c_int, c_int, c_int) -> c_int;
    type Destroy = unsafe extern "C" fn(*mut c_void) -> c_int;
    static LIB: std::sync::OnceLock<Option<libloading::Library>> = std::sync::OnceLock::new();
    // SAFETY: TurboJPEG 2.x C API with its documented signatures; buffers sized from the header
    unsafe {
        let lib = LIB.get_or_init(|| libloading::Library::new("libturbojpeg.so.0").ok()).as_ref()?;
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

/// (h, w) of a still without keeping its pixels.
pub(crate) fn image_size(p: &Path) -> Result<(usize, usize), Error> {
    if is_exr(p) {
        // the header only (decoding a 4K frame to learn its size took ~50 ms): the first layer with R, G and B,
        // the one read_still reads
        let meta = exr::meta::MetaData::read_from_file(p, false).map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
        // loop: NOT-WORTH — a few layers, once per clip
        let has = |hd: &exr::meta::header::Header, c: &str| hd.channels.list.iter().any(|ch| ch.name.eq_case_insensitive(c));
        // loop: NOT-WORTH — a few layers, once per clip
        let hd = meta
            .headers
            .iter()
            .find(|hd| has(hd, "R") && has(hd, "G") && has(hd, "B"))
            .ok_or_else(|| Error::input(format!("{}: no RGB layer", p.display())))?;
        return Ok((hd.layer_size.height(), hd.layer_size.width()));
    }
    let (w, h) = ::image::image_dimensions(p).map_err(|e| Error::input(format!("{}: {e}", p.display())))?;
    Ok((h as usize, w as usize))
}

/// video_io.read_image_rgb: cv2.imread(IMREAD_COLOR) / 255 for PNG/JPEG (gray replicated, alpha dropped,
/// 16-bit reduced to its high byte), the float RGB of an EXR.
pub fn read_image_rgb(p: &Path) -> Result<Planar, Error> {
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
pub(crate) fn prep_frame_views(display_or_linear: Planar, exr_linear: bool, meta: &ClipMeta, denom: f32, need_model: bool) -> Prepped {
    use rayon::prelude::*;
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
            crate::clip::Source::Video(p) => Some(VideoDecoder::open(p, meta.w, meta.h, meta.num_frames)?),
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
                let rgb = v.next_rgb()?;
                let img = rgb8_to_planar(rgb, self.meta.h, self.meta.w);
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
                        let img = read_image_rgb(p)?;
                        if (img.h, img.w) != (meta.h, meta.w) {
                            return Err(Error::input(format!(
                                "{}: frame size {}x{} differs from the first frame's {}x{}",
                                p.display(),
                                img.w,
                                img.h,
                                meta.w,
                                meta.h
                            )));
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

/// A FrameReader on its own thread, a few frames ahead (the runtime prefetches its prepass chunks the same way):
/// decoding overlaps the networks.
pub(crate) struct Prefetch {
    frames: crate::ahead::Ahead<Prepped>,
    /// the reader's own decode + preprocessing seconds
    seconds: crate::ahead::Seconds,
}

impl Prefetch {
    /// `reader` on a thread named `name`, `depth` frames ahead (a panic in the decoder is the next frame's error).
    pub(crate) fn new(name: &str, mut reader: FrameReader, depth: usize) -> Result<Prefetch, Error> {
        let seconds = crate::ahead::Seconds::default();
        let s2 = seconds.clone();
        // loop: SERIAL-REQUIRED — the prefetch thread: decodes in order; ends at the clip's end, an error, or a dropped receiver
        let frames = crate::ahead::Ahead::spawn(name, depth, move || {
            let item = reader.next_frame();
            s2.set(reader.seconds);
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
    if (h, w) != (meta.h, meta.w) {
        p = resize_lanczos4(&p, meta.h, meta.w);
    }
    p.map(|v| finite_input(v).clamp(0.0, 1.0));
    let mut out = pad_reflect101(&p, meta.pad);
    out.map(bf16_round);
    out.data
}

/// video_io.read_hint_image + load_initial_hint_frame: the first-frame matte (a file, or the first frame of a
/// folder). 4 channels: the alpha; 3: the first channel cv2 reads (blue); its size must be the clip's.
pub(crate) fn load_initial_hint(path: &Path, meta: &ClipMeta) -> Result<Vec<f32>, Error> {
    let file = if path.is_dir() {
        // loop: NOT-WORTH — a hint folder's file names, once per job
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
        } else {
            0
        }
    }; // BGR(A) index 0 = blue = RGB index 2
    let (h, w, g): (usize, usize, Vec<f32>) = match read_still(&file)? {
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::U8 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)] as f32 / 255.0).collect()),
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::U16 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)] as f32 / 65535.0).collect()),
        // loop: NOT-WORTH — the first-frame hint: one image per job
        Still::F32 { ch, h, w, data } => (h, w, (0..h * w).map(|i| data[i * ch + pick(ch)]).collect()),
    };
    if (h, w) != (meta.h, meta.w) {
        return Err(Error::input(format!("{}: hint shape ({h}, {w}) does not match the clip ({}, {})", file.display(), meta.h, meta.w)));
    }
    let mut p = Planar::from_vec(1, h, w, g);
    p.map(|v| finite_input(v).clamp(0.0, 1.0));
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
            if paths.len() < meta.num_frames {
                return Err(Error::input(format!("{}: only {} hint frames for {} source frames", path.display(), paths.len(), meta.num_frames)));
            }
            return Ok(HintReader { meta: meta.clone(), video: None, paths, next: 0 });
        }
        let p = crate::clip::ffprobe(path)?;
        if p.frames > 0 && p.frames < meta.num_frames {
            return Err(Error::input(format!(
                "Hint video {} has only {} frames, but the source video requires {} frames",
                path.display(),
                p.frames,
                meta.num_frames
            )));
        }
        Ok(HintReader { meta: meta.clone(), video: Some(VideoDecoder::open(path, p.w, p.h, meta.num_frames)?), paths: vec![], next: 0 })
    }

    pub(crate) fn next_frame(&mut self) -> Result<Vec<f32>, Error> {
        let still = match &mut self.video {
            Some(v) => {
                let (w, h) = (v.w, v.h);
                Still::U8 { ch: 3, h, w, data: v.next_rgb()?.to_vec() }
            }
            None => read_still(&self.paths[self.next])?,
        };
        self.next += 1;
        Ok(prep_hint(still, &self.meta))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            shape_h: 1,
            shape_w: 4,
            pad: crate::image::Pad { l: 0, r: 0, t: 0, b: 0 },
            num_frames: 1,
            exr_linear: true,
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
    fn rgb_bytes_to_planes() {
        let p = rgb8_to_planar(&[255, 0, 51, 0, 255, 102], 1, 2);
        assert_eq!(p.data, vec![1.0, 0.0, 0.0, 1.0, 0.2, 0.4]);
    }
}
