//! What a job's input is (video_io.probe_video_meta / probe_frame_dir_meta, raw_clip_name, frame_paths,
//! none_path): native size, the padded model shape (128 px quantum), frame count and rate.
use crate::image::{ceil_to_multiple, center_pad, Pad};
use crate::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const SHAPE_QUANTUM: usize = 128;

/// The largest frame side the engine takes, native and at the model scale: 16384 px, the cap `trt_build` and the app's
/// size fields already have (ck-engine `trt_build_job`, src/shared/trt.ts). 8K and 12K plates (7680x4320, 12288x6480)
/// and 4K DCI at model scale 2.0 (8192x4320) are inside it; the networks have no size limit of their own, host memory
/// is the bound (each frame in flight is h x w x 3 floats: 3.2 GB at 16384 x 16384). Senior Rust review 2026-10-26 M1:
/// with no cap, an EXR header claiming 100000x100000 passed the probe and the decoder's 120 GB allocation aborted the
/// engine (exit 134, no error reply, the queued requests lost); now it is an `input` error at the probe.
pub const MAX_SIDE: usize = 16384;

/// Whether the engine takes a frame of `w` x `h` (native) that the networks see at `model_w` x `model_h`; an `input`
/// error that says why when it doesn't (MAX_SIDE).
pub(crate) fn size_supported(w: usize, h: usize, model_w: usize, model_h: usize) -> Result<(), Error> {
    if w > MAX_SIDE || h > MAX_SIDE {
        return Err(Error::input(format!("This clip is too large ({w}x{h}): the engine takes at most {MAX_SIDE} pixels in each direction.")));
    }
    if model_w > MAX_SIDE || model_h > MAX_SIDE {
        return Err(Error::input(format!(
            "At this model scale the networks would run at {model_w}x{model_h} (the clip is {w}x{h}): the engine takes at most {MAX_SIDE} pixels in each direction. Choose a smaller model scale."
        )));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Video(PathBuf),
    /// frame paths in order (num_frames applied)
    Frames(Vec<PathBuf>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipMeta {
    pub source: Source,
    pub fps: f64,
    /// native height, width (the decoded frames and the outputs)
    pub h: usize,
    pub w: usize,
    /// the size the networks see before padding: the native size at `model_scale` (video_io.scaled_hw; = h, w at 1.0)
    pub model_h: usize,
    pub model_w: usize,
    /// `--model_scale` (backlog row 42): frames Lanczos-4 resized to model_h x model_w on the way in, the outputs
    /// back to h x w on the way out
    pub model_scale: f64,
    /// a video's first frame (`--start_mode` / `--seed` with `num_frames`; 0 for frame folders, as upstream)
    pub start_frame: usize,
    /// `--linear_brightness` / `--linear_contrast` / `--linear_contrast_pivot` (backlog row 45): video inputs only;
    /// a frame folder keeps the identity, as upstream's probe_frame_dir_meta does
    pub adjust: crate::color::LinearAdjust,
    /// padded model shape
    pub shape_h: usize,
    pub shape_w: usize,
    pub pad: Pad,
    pub num_frames: usize,
    /// frame folders of scene-linear EXRs (frame_dir_linear)
    pub exr_linear: bool,
    /// a video source's bits per sample (8 for frame folders and 8-bit video), as probed
    pub video_bits: u32,
    /// the job's `input_bit_depth` 16 (backlog row 27): a video above 8 bits is decoded at 16 bits and 16-bit PNG
    /// read at full depth. false (the default) = CorridorKey 2.0's own reader: 8 bits, as cv2 reads them (decode.rs)
    pub deep_input: bool,
    /// the clip's colour space -> the model's linear Rec.709 (ocio.rs; backlog row 29). None: read as CorridorKey
    /// 2.0 reads it (display-coded sRGB, or scene-linear EXR with `exr_linear`)
    pub color_in: Option<crate::ocio::XformRef>,
}

impl ClipMeta {
    pub(crate) fn with_shape(source: Source, fps: f64, h: usize, w: usize, num_frames: usize, exr_linear: bool, model_scale: f64) -> ClipMeta {
        let (model_h, model_w) = scaled_hw(h, w, model_scale);
        let (shape_h, shape_w) = (ceil_to_multiple(model_h, SHAPE_QUANTUM), ceil_to_multiple(model_w, SHAPE_QUANTUM));
        ClipMeta {
            source,
            fps,
            h,
            w,
            model_h,
            model_w,
            model_scale,
            start_frame: 0,
            adjust: crate::color::LinearAdjust::default(),
            shape_h,
            shape_w,
            pad: center_pad(model_h, model_w, shape_h, shape_w),
            num_frames,
            exr_linear,
            video_bits: 8,
            deep_input: false,
            color_in: None,
        }
    }

    /// The video is decoded at 16 bits: asked for (`deep_input`) and a source above 8 bits.
    pub fn decode_deep(&self) -> bool {
        self.deep_input && self.video_bits > 8
    }

    /// The networks run below (or above) the native size: frames and outputs are resized.
    pub fn scaled(&self) -> bool {
        (self.model_h, self.model_w) != (self.h, self.w)
    }
}

/// video_io.scaled_hw: max(1, int(round(h * scale))) for each side, Python's round (half to even) on the double
/// product. `scale` > 0 (the job parser checks it).
pub fn scaled_hw(h: usize, w: usize, scale: f64) -> (usize, usize) {
    let s = |n: usize| ((n as f64 * scale).round_ties_even() as usize).max(1);
    (s(h), s(w))
}

/// How a video's first frame is chosen when `num_frames` takes part of it (video_io.probe_video_meta).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartMode {
    Begin,
    Middle,
    RandomMiddle,
}

impl StartMode {
    pub fn parse(s: &str) -> Option<StartMode> {
        match s {
            "begin" => Some(StartMode::Begin),
            "middle" => Some(StartMode::Middle),
            "random_middle" => Some(StartMode::RandomMiddle),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            StartMode::Begin => "begin",
            StartMode::Middle => "middle",
            StartMode::RandomMiddle => "random_middle",
        }
    }
}

/// probe_video_meta's start frame: only when `num_frames` > 0 leaves frames over (max_start > 0); `middle` =
/// max_start // 2; `random_middle` = default_rng(seed).integers(max_start // 4, 3 * max_start // 4 + 1).
pub fn start_frame(n_total: usize, n_to_load: usize, num_frames: i64, mode: StartMode, seed: u64) -> usize {
    let max_start = n_total.saturating_sub(n_to_load);
    if max_start == 0 || num_frames <= 0 {
        return 0;
    }
    match mode {
        StartMode::Begin => 0,
        StartMode::Middle => max_start / 2,
        StartMode::RandomMiddle => crate::rng::numpy_integers(seed, (max_start / 4) as i64, (3 * max_start / 4) as i64) as usize,
    }
}

/// Whether the ONNX networks take this padded model shape; an `input` error that says why when they don't.
/// `portrait`: the model set's C-RADIO takes frames taller than wide (`ModelSet::takes_portrait`). Measured:
/// - the 2.0.0-onnx.1 / onnx.2 C-RADIO failed on every frame taller than wide (its export dropped the position
///   grid's column crop: 400 position tokens against 240 patches at 1280x768 padded, H x W); 2.0.0-onnx.3's grid
///   follows the frame's rows and columns (CPU fp32 against PyTorch: max 1.2e-5 to 3.3e-5 on features up to 25,
///   384x256 to 1920x1152).
/// - a side of 128 px fails in stage 1 with every set (onnx.3 too, CPU fp32): a reflect pad of 3 on a 2-cell
///   grid, where upstream PyTorch switches to a replicate pad (blocks.py; the export fixed the trace's branch).
///
/// Refused before any work, in words, instead of an ONNX Runtime message after the RVM pass.
pub(crate) fn model_shape_supported(shape_h: usize, shape_w: usize, w: usize, h: usize, portrait: bool) -> Result<(), Error> {
    if shape_h <= SHAPE_QUANTUM || shape_w <= SHAPE_QUANTUM {
        return Err(Error::input(format!("This clip is too small ({w}x{h}): CorridorKey's networks need more than {SHAPE_QUANTUM} pixels in each direction.")));
    }
    if shape_h > shape_w && !portrait {
        return Err(Error::input(format!(
            "Portrait clips (taller than wide, here {w}x{h}) need the 2.0.0-onnx.3 models or newer: this models folder's C-RADIO only takes landscape or square frames."
        )));
    }
    Ok(())
}

/// video_io.none_path: "", none, null, off, false, - mean no path.
pub(crate) fn none_path(p: Option<&str>) -> Option<&str> {
    let p = p?;
    match p.trim().to_lowercase().as_str() {
        "" | "none" | "null" | "off" | "false" | "-" => None,
        _ => Some(p),
    }
}

/// video_io.raw_clip_name: the file stem, or the parent folder's name for input/frames/rgb.
pub(crate) fn raw_clip_name(path: &str) -> String {
    let norm = normpath(path);
    let p = Path::new(&norm);
    let base = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = splitext(&base);
    if ["input", "frames", "rgb"].contains(&name.to_lowercase().as_str()) {
        let parent = p.parent().and_then(|q| q.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !parent.is_empty() {
            return parent;
        }
    }
    name
}

/// os.path.splitext's stem: a leading dot is not an extension.
fn splitext(base: &str) -> String {
    let trimmed = base.trim_start_matches('.');
    match trimmed.rfind('.') {
        Some(i) => base[..base.len() - trimmed.len() + i].to_string(),
        None => base.to_string(),
    }
}

/// os.path.normpath for the cases a clip path has (trailing slashes, `.` and `..`).
fn normpath(path: &str) -> String {
    let abs = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." if parts.last().is_some_and(|l| *l != "..") => {
                parts.pop();
            }
            ".." if abs => {}
            _ => parts.push(c),
        }
    }
    let j = parts.join("/");
    if abs {
        format!("/{j}")
    } else if j.is_empty() {
        ".".into()
    } else {
        j
    }
}

/// "f_2" before "f_10": runs of digits compare by value, the rest by text (then plain text, so the order is total).
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut x, mut y) = (a.as_bytes(), b.as_bytes());
    // loop: NOT-WORTH — one pass over two file names, per comparison of a sort
    while let (Some(&ca), Some(&cb)) = (x.first(), y.first()) {
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            // loop: NOT-WORTH — a digit run's length, per comparison
            let na = x.iter().take_while(|c| c.is_ascii_digit()).count();
            // loop: NOT-WORTH — as above
            let nb = y.iter().take_while(|c| c.is_ascii_digit()).count();
            // loop: NOT-WORTH — strips leading zeros of one digit run
            let (da, db) = (strip_zeros(&x[..na]), strip_zeros(&y[..nb]));
            let ord = da.len().cmp(&db.len()).then_with(|| da.cmp(db));
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
            x = &x[na..];
            y = &y[nb..];
        } else {
            if ca != cb {
                return ca.cmp(&cb);
            }
            x = &x[1..];
            y = &y[1..];
        }
    }
    x.len().cmp(&y.len()).then_with(|| a.cmp(b))
}

fn strip_zeros(d: &[u8]) -> &[u8] {
    let i = d.iter().position(|&c| c != b'0').unwrap_or(d.len());
    &d[i..]
}

/// video_io.frame_paths, with upstream's two bugs fixed (CorridorKey2.0 PR #4): *.exr, *.png, *.jpg, *.jpeg directly in
/// the folder, the extension in any case (.EXR too), in natural order (f_2 before f_10, not as text).
pub(crate) fn frame_paths(dir: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut out: Vec<String> = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| Error::input(format!("{}: {e}", dir.display())))?;
    // loop: HOT-PATH-OK — one pass over the folder's entries
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // loop: NOT-WORTH — four extensions per file name, once per probe
        let lower = name.to_ascii_lowercase();
        // loop: NOT-WORTH — four extensions per file name, once per probe
        let ok = [".exr", ".png", ".jpg", ".jpeg"].iter().any(|x| lower.ends_with(x) && name.len() > x.len() && !name.starts_with('.'));
        if ok && e.path().is_file() {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
    // loop: NOT-WORTH — sorts the folder's file names once per probe
    out.sort_by(|a, b| natural_cmp(a, b));
    // loop: NOT-WORTH — the folder's file names, once per probe
    Ok(out.into_iter().map(PathBuf::from).collect())
}

/// What ffprobe says about the first video stream.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct VideoProbe {
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) fps: f64,
    pub(crate) frames: usize,
    /// bits per sample of the decoded picture (bits_per_raw_sample, else read from pix_fmt; 8 when unknown)
    pub(crate) bits: u32,
}

/// Bits per sample of a stream: ffprobe's bits_per_raw_sample, else the number in its pixel format's name
/// (yuv422p10le -> 10, yuv444p12le -> 12, gbrp16le -> 16, rgb48le -> 16); 8 when neither says more.
pub(crate) fn stream_bits(bits_per_raw_sample: Option<&str>, pix_fmt: Option<&str>) -> u32 {
    if let Some(b) = bits_per_raw_sample.and_then(|s| s.trim().parse::<u32>().ok()).filter(|b| *b > 0) {
        return b;
    }
    let Some(f) = pix_fmt else { return 8 };
    if f.starts_with("rgb48") || f.starts_with("bgr48") || f.starts_with("rgba64") || f.starts_with("bgra64") {
        return 16;
    }
    // nv12 / nv21 / nv16 / nv24 are 8-bit (the digits name the layout); p010 / p016 / p210 / p410: the last two
    let base = f.trim_end_matches("le").trim_end_matches("be");
    if base.starts_with("nv") {
        return 8;
    }
    // loop: NOT-WORTH — four characters, once per probe
    if base.len() == 4 && base.starts_with('p') && base[1..].chars().all(|c| c.is_ascii_digit()) {
        return base[2..].parse().unwrap_or(8);
    }
    // the digits after the layout letters: yuv444p12le -> "12"
    // loop: NOT-WORTH — a pixel format name (a dozen characters), once per probe
    let tail: String = f.trim_end_matches("le").trim_end_matches("be").chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    // loop: NOT-WORTH — as above
    let n: u32 = tail.chars().rev().collect::<String>().parse().unwrap_or(0);
    if (9..=16).contains(&n) {
        n
    } else {
        8
    }
}

fn rational(s: &str) -> f64 {
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b): (f64, f64) = (a.trim().parse().unwrap_or(0.0), b.trim().parse().unwrap_or(0.0));
            if b == 0.0 {
                0.0
            } else {
                a / b
            }
        }
        None => s.trim().parse().unwrap_or(0.0),
    }
}

/// OpenCV's reading of an ffprobe answer (cap_ffmpeg get_fps / get_total_frames): the average frame rate,
/// else the real base rate, else 24 (probe_video_meta's `or 24.0`); nb_frames, else
/// round(duration * fps); a 90/270 degree rotation swaps width and height (both auto-rotate).
pub(crate) fn read_probe(json: &serde_json::Value) -> Result<VideoProbe, Error> {
    let st = json["streams"].get(0).ok_or_else(|| Error::input("no video stream".into()))?;
    let num = |v: &serde_json::Value| -> f64 {
        match v {
            serde_json::Value::String(s) => s.parse().unwrap_or(0.0),
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
            _ => 0.0,
        }
    };
    let (mut w, mut h) = (num(&st["width"]) as usize, num(&st["height"]) as usize);
    let mut fps = rational(st["avg_frame_rate"].as_str().unwrap_or("0/0"));
    if fps < 1e-6 {
        fps = rational(st["r_frame_rate"].as_str().unwrap_or("0/0"));
    }
    if fps < 1e-6 {
        fps = 24.0;
    }
    let mut frames = num(&st["nb_frames"]) as usize;
    if frames == 0 {
        let mut dur = num(&json["format"]["duration"]);
        if dur < 1e-6 {
            dur = num(&st["duration"]);
        }
        frames = (dur * fps + 0.5).floor().max(0.0) as usize;
    }
    let rot = st["side_data_list"]
        .as_array()
        .and_then(|l| l.iter().find_map(|d| d.get("rotation").map(num)))
        .or_else(|| st["tags"].get("rotate").map(num))
        .unwrap_or(0.0);
    if (rot.abs().round() as i64) % 180 == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    if w == 0 || h == 0 {
        return Err(Error::input("the video stream has no size".into()));
    }
    let bits = stream_bits(st["bits_per_raw_sample"].as_str(), st["pix_fmt"].as_str());
    Ok(VideoProbe { w, h, fps, frames, bits })
}

/// ffprobe's deadline.
pub(crate) const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub(crate) fn ffprobe(path: &Path) -> Result<VideoProbe, Error> {
    let mut cmd = Command::new("ffprobe");
    cmd.args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
        .arg("stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,pix_fmt,bits_per_raw_sample:stream_tags=rotate:stream_side_data=rotation:format=duration")
        .args(["-of", "json"])
        .arg(path);
    // a local file answers in well under a second; a stalled mount or device doesn't hold the job
    // loop: SERIAL-REQUIRED — one ffprobe per clip, PROBE_TIMEOUT 120 s
    let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(|e| {
        if e.starts_with("no answer") {
            Error::input(format!("ffprobe on {}: {e}", path.display()))
        } else {
            Error::assets(format!("ffprobe could not run: {e}"))
        }
    })?;
    if !out.status.success() {
        return Err(Error::input(format!("Could not open video: {} ({})", path.display(), String::from_utf8_lossy(&out.stderr).trim())));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| Error::input(format!("ffprobe output: {e}")))?;
    let mut p = read_probe(&v)?;
    // No frame count in the container (Matroska, WebM): duration x nominal rate is only an estimate. Measured on a
    // variable-frame-rate MKV: 18 estimated (0.75 s x 24), 8 real; the job failed "failed decoding frame 8". The
    // packets are counted instead (the frames the decoder delivers; it reads the file once, no decoding).
    let st = &v["streams"][0];
    let has_count = st["nb_frames"].as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| st["nb_frames"].as_u64()).is_some_and(|n| n > 0);
    if !has_count {
        if let Some(n) = count_packets(path)? {
            p.frames = n;
        }
    }
    Ok(p)
}

/// The video stream's packets, counted by ffprobe (None: ffprobe gave no count).
fn count_packets(path: &Path) -> Result<Option<usize>, Error> {
    let mut cmd = Command::new("ffprobe");
    cmd.args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "json"]).arg(path);
    // loop: SERIAL-REQUIRED — one ffprobe per clip without a frame count, PROBE_TIMEOUT 120 s
    let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(|e| Error::input(format!("ffprobe on {}: {e}", path.display())))?;
    if !out.status.success() {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| Error::input(format!("ffprobe output: {e}")))?;
    Ok(v["streams"][0]["nb_read_packets"].as_str().and_then(|s| s.parse::<usize>().ok()).filter(|n| *n > 0))
}

/// What a video probe needs besides the input (the job's options).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProbeOpts {
    pub num_frames: i64,
    pub model_scale: f64,
    pub start_mode: StartMode,
    pub seed: u64,
    pub adjust: crate::color::LinearAdjust,
}

impl ProbeOpts {
    /// infer.py's defaults with `num_frames`
    pub fn frames(num_frames: i64) -> ProbeOpts {
        ProbeOpts { num_frames, model_scale: 1.0, start_mode: StartMode::Begin, seed: 0, adjust: Default::default() }
    }
}

/// probe_video_meta: `num_frames` frames (all when <= 0) from the start frame `start_mode` picks, at `model_scale`.
pub(crate) fn probe_video(path: &Path, o: &ProbeOpts) -> Result<ClipMeta, Error> {
    let num_frames = o.num_frames;
    let p = ffprobe(path)?;
    let n = if num_frames <= 0 { p.frames } else { (num_frames as usize).min(p.frames) };
    if n == 0 {
        return Err(Error::input(format!("{}: no frames", path.display())));
    }
    let mut meta = ClipMeta::with_shape(Source::Video(path.to_path_buf()), p.fps, p.h, p.w, n, false, o.model_scale);
    size_supported(meta.w, meta.h, meta.model_w, meta.model_h)?;
    meta.video_bits = p.bits;
    meta.start_frame = start_frame(p.frames, n, num_frames, o.start_mode, o.seed);
    meta.adjust = o.adjust;
    Ok(meta)
}

/// probe_frame_dir_meta: the folder's frames at `fps`; the size comes from the first frame. No start mode and no
/// linear adjust (upstream's frame-folder probe fixes both).
pub(crate) fn probe_frame_dir(dir: &Path, num_frames: i64, fps: f64, exr_linear: bool, model_scale: f64) -> Result<ClipMeta, Error> {
    let mut paths = frame_paths(dir)?;
    if paths.is_empty() {
        return Err(Error::input(format!("No frames found under {}", dir.display())));
    }
    if num_frames > 0 {
        paths.truncate(num_frames as usize);
    }
    let (h, w) = crate::decode::image_size(&paths[0])?;
    let n = paths.len();
    let meta = ClipMeta::with_shape(Source::Frames(paths), fps, h, w, n, exr_linear, model_scale);
    size_supported(meta.w, meta.h, meta.model_w, meta.model_h)?;
    Ok(meta)
}

/// A clip's size and frame count as a job's probe reads them (the `estimate` command): ffprobe for a video, the first
/// frame's header for a frame folder (its rate and colour don't change the size). Nothing is decoded.
pub fn probe_size(input: &Path, num_frames: i64, model_scale: f64) -> Result<ClipMeta, Error> {
    if !input.exists() {
        return Err(Error::input(format!("input not found: {}", input.display())));
    }
    if input.is_dir() {
        probe_frame_dir(input, num_frames, 24.0, false, model_scale)
    } else {
        probe_video(input, &ProbeOpts { model_scale, ..ProbeOpts::frames(num_frames) })
    }
}

/// The first frame number of a video's (or an unnumbered folder's) EXR sequence: the VFX convention.
pub(crate) const FIRST_FRAME: u64 = 1001;

/// How a job's EXR frames are numbered (backlog row 30 a): `<stem>.<number>.exr`, the number zero-padded to `width`.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameNumbers {
    /// one per output frame, in order
    pub numbers: Vec<u64>,
    /// the zero padding (at least 4)
    pub width: usize,
    /// the numbers are the input frames' own
    pub from_source: bool,
    /// why a frame folder's own numbers weren't used (None: they were, or the input is a video)
    pub fallback: Option<String>,
}

/// The trailing run of digits of a file's stem ("04_5d_00065.exr" -> "00065"), if there is one.
fn trailing_digits(p: &Path) -> Option<&str> {
    let stem = p.file_stem()?.to_str()?;
    let start = stem.len() - stem.bytes().rev().take_while(|c| c.is_ascii_digit()).count();
    (start < stem.len()).then(|| &stem[start..])
}

impl FrameNumbers {
    /// A frame folder keeps its frames' own numbers (the trailing digits of each stem) and their padding (at
    /// least 4); a video, or a folder where any frame has no number or the numbers don't strictly increase, counts
    /// from FIRST_FRAME for the whole job.
    pub fn for_source(source: &Source, n: usize) -> FrameNumbers {
        let paths = match source {
            Source::Frames(p) => p,
            Source::Video(_) => return FrameNumbers::counted(n, None),
        };
        let mut numbers = Vec::with_capacity(paths.len());
        let mut width = 4;
        // loop: NOT-WORTH — one pass over the folder's names, once per job
        for p in paths.iter().take(n) {
            let name = p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            // more than 18 digits don't fit a u64's 19: no number (the fallback) rather than a wrapped one
            let Some(num) = trailing_digits(p).filter(|d| d.len() <= 18).and_then(|d| d.parse::<u64>().ok().map(|v| (v, d.len()))) else {
                return FrameNumbers::counted(n, Some(format!("{name} has no frame number")));
            };
            if let Some(&last) = numbers.last() {
                if num.0 <= last {
                    return FrameNumbers::counted(n, Some(format!("the frame numbers don't increase ({name} after {last})")));
                }
            }
            numbers.push(num.0);
            width = width.max(num.1);
        }
        FrameNumbers { numbers, width, from_source: true, fallback: None }
    }

    /// FIRST_FRAME + index, padded to 4 (wider when the last number needs it).
    fn counted(n: usize, fallback: Option<String>) -> FrameNumbers {
        // loop: NOT-WORTH — one number per frame, once per job
        let numbers: Vec<u64> = (0..n as u64).map(|i| FIRST_FRAME + i).collect();
        let width = numbers.last().map(|v| v.to_string().len()).unwrap_or(4).max(4);
        FrameNumbers { numbers, width, from_source: false, fallback }
    }

    /// The file name of output frame `i`: `<stem>.<number>.exr` (None past the clip's frames).
    pub fn file_name(&self, stem: &str, i: usize) -> Option<String> {
        self.numbers.get(i).map(|v| format!("{stem}.{v:0w$}.exr", w = self.width))
    }

    /// The range in words, for `_settings.txt` and the log: "source (65-184)" or "1001-1120".
    pub fn describe(&self) -> String {
        let range = match (self.numbers.first(), self.numbers.last()) {
            (Some(a), Some(b)) => format!("{a}-{b}"),
            _ => "none".into(),
        };
        if self.from_source {
            format!("source ({range})")
        } else {
            range
        }
    }
}

#[cfg(test)]
mod tests {

    /// senior Rust review 2026-10-26 M1: a clip past MAX_SIDE (here an EXR header claiming 100000x100000) is an
    /// `input` error at the probe, for a run and for the `estimate` command (probe_size), before anything is decoded
    #[test]
    fn a_clip_past_the_largest_side_is_refused_at_the_probe() {
        let dir = std::env::temp_dir().join(format!("ck-maxside-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::decode::exr_claiming(&dir.join("f_0001.exr"), 16, 8, 100_000, 100_000);
        let run = probe_frame_dir(&dir, -1, 24.0, false, 1.0).unwrap_err();
        let estimate = probe_size(&dir, -1, 1.0).unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(run.code, crate::ErrorCode::Input);
        assert!(run.message.starts_with("This clip is too large (100000x100000): the engine takes at most 16384"), "{}", run.message);
        assert_eq!(estimate, run);
        // the limit itself is taken; one pixel past it, natively or at the model scale, is not
        assert_eq!(size_supported(MAX_SIDE, MAX_SIDE, MAX_SIDE, MAX_SIDE), Ok(()));
        assert!(size_supported(MAX_SIDE + 1, 100, MAX_SIDE + 1, 100).unwrap_err().message.contains("too large"));
        let scaled = size_supported(8192, 4320, 16384 + 2, 8640).unwrap_err();
        assert_eq!(scaled.code, crate::ErrorCode::Input);
        assert!(scaled.message.contains("model scale"), "{}", scaled.message);
    }

    #[test]
    fn exr_frame_numbers() {
        let frames = |names: &[&str]| Source::Frames(names.iter().map(|n| PathBuf::from(format!("/plates/04_5d/{n}"))).collect());
        // a folder's own numbers and padding
        let f = FrameNumbers::for_source(&frames(&["04_5d_00065.exr", "04_5d_00066.exr", "04_5d_00184.exr"]), 3);
        assert_eq!((f.numbers.clone(), f.width, f.from_source, f.fallback.clone()), (vec![65, 66, 184], 5, true, None));
        assert_eq!(f.file_name("04_5d_alpha", 0).unwrap(), "04_5d_alpha.00065.exr");
        assert_eq!(f.describe(), "source (65-184)");
        // padding at least 4; plate.1001.exr style names; unpadded names get one width
        let f = FrameNumbers::for_source(&frames(&["plate.1001.exr", "plate.1002.exr"]), 2);
        assert_eq!((f.file_name("plate_alpha", 1).unwrap(), f.from_source), ("plate_alpha.1002.exr".to_string(), true));
        let f = FrameNumbers::for_source(&frames(&["f_9.png", "f_10.png", "f_12000.png"]), 3);
        assert_eq!((f.width, f.file_name("x", 0).unwrap(), f.file_name("x", 2).unwrap()), (5, "x.00009.exr".to_string(), "x.12000.exr".to_string()));
        // num_frames: only the job's frames
        assert_eq!(FrameNumbers::for_source(&frames(&["a_0007.png", "a_0008.png", "b.png"]), 2).numbers, vec![7, 8]);
        // a frame without a number, or numbers that don't strictly increase: 1001+ for the whole job, with the reason
        let f = FrameNumbers::for_source(&frames(&["a_0001.png", "a_0002b.png"]), 2);
        assert_eq!((f.numbers.clone(), f.width, f.from_source), (vec![1001, 1002], 4, false));
        assert_eq!(f.fallback.as_deref(), Some("a_0002b.png has no frame number"));
        let f = FrameNumbers::for_source(&frames(&["a_10.png", "b_010.png"]), 2);
        assert_eq!((f.numbers.clone(), f.fallback.as_deref()), (vec![1001, 1002], Some("the frame numbers don't increase (b_010.png after 10)")));
        assert!(FrameNumbers::for_source(&frames(&["a_1234567890123456789.png"]), 1).fallback.is_some());
        // a video: 1001 + index, padding 4, wider when the count needs it
        let v = FrameNumbers::for_source(&Source::Video(PathBuf::from("/c/a.mp4")), 120);
        assert_eq!((v.numbers[0], v.numbers[119], v.width, v.from_source, v.fallback.clone()), (1001, 1120, 4, false, None));
        assert_eq!((v.file_name("a_fg", 0).unwrap(), v.describe()), ("a_fg.1001.exr".to_string(), "1001-1120".to_string()));
        let v = FrameNumbers::for_source(&Source::Video(PathBuf::from("/c/a.mp4")), 9000);
        assert_eq!((v.width, v.file_name("a", 8999).unwrap()), (5, "a.10000.exr".to_string()));
        assert_eq!(v.file_name("a", 9000), None);
    }

    #[test]
    fn bit_depth_from_ffprobe() {
        assert_eq!(super::stream_bits(Some("12"), Some("yuv444p12le")), 12);
        assert_eq!(super::stream_bits(None, Some("yuv422p10le")), 10);
        assert_eq!(super::stream_bits(Some("N/A"), Some("yuv444p12le")), 12);
        assert_eq!(super::stream_bits(None, Some("gbrp16le")), 16);
        assert_eq!(super::stream_bits(None, Some("rgb48le")), 16);
        assert_eq!(super::stream_bits(None, Some("yuv420p")), 8);
        assert_eq!(super::stream_bits(None, Some("nv12")), 8);
        assert_eq!(super::stream_bits(None, Some("p010le")), 10);
        assert_eq!(super::stream_bits(None, Some("gray12le")), 12);
        assert_eq!(super::stream_bits(None, None), 8);
    }
    use super::*;

    #[test]
    fn frames_in_natural_order_any_case() {
        let dir = std::env::temp_dir().join(format!("ck-frames-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // loop: NOT-WORTH — a test's few files
        for n in ["f_1.png", "f_10.PNG", "f_2.Png", "notes.txt", "f_002b.exr"] {
            std::fs::write(dir.join(n), b"").unwrap();
        }
        // loop: NOT-WORTH — a test's few paths
        let names: Vec<String> = frame_paths(&dir).unwrap().iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(names, ["f_1.png", "f_2.Png", "f_002b.exr", "f_10.PNG"]);
        assert_eq!(natural_cmp("frame_0009", "frame_0010"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("a9", "a09"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn clip_names() {
        assert_eq!(raw_clip_name("/clips/shot.mp4"), "shot");
        assert_eq!(raw_clip_name("/clips/shot01/rgb/"), "shot01");
        assert_eq!(raw_clip_name("/clips/shot01/Frames"), "shot01");
        assert_eq!(raw_clip_name("/clips/a.b.mov"), "a.b");
        assert_eq!(raw_clip_name("/clips/.hidden"), ".hidden");
        assert_eq!(raw_clip_name("clips/../x/take.mov"), "take");
    }

    #[test]
    fn none_paths() {
        assert_eq!(none_path(Some(" None ")), None);
        assert_eq!(none_path(Some("-")), None);
        assert_eq!(none_path(Some("/a.png")), Some("/a.png"));
        assert_eq!(none_path(None), None);
    }

    #[test]
    fn probe_reading() {
        let v = serde_json::json!({"streams":[{"width":960,"height":720,"avg_frame_rate":"24000/1001","r_frame_rate":"24000/1001","nb_frames":"349"}],"format":{"duration":"14.5"}});
        let p = read_probe(&v).unwrap();
        assert_eq!((p.w, p.h, p.frames), (960, 720, 349));
        assert!((p.fps - 23.976023976023978).abs() < 1e-12);
        let v = serde_json::json!({"streams":[{"width":1920,"height":1080,"avg_frame_rate":"0/0","r_frame_rate":"25/1","side_data_list":[{"rotation":-90}]}],"format":{"duration":"2.0"}});
        let p = read_probe(&v).unwrap();
        assert_eq!((p.w, p.h, p.frames, p.fps), (1080, 1920, 50, 25.0));
    }

    #[test]
    fn a_variable_frame_rate_mkv_counts_its_real_frames() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("no ffmpeg: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("ck-vfr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("vfr.mkv");
        // 8 frames: four 40 ms apart, then 100 ms apart (0.75 s at a nominal 24 fps: 18 by duration x rate)
        let st = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24", "-frames:v", "8"])
            .args(["-vf", "setpts='if(lt(N,4),N*0.04,N*0.1)/TB'", "-fps_mode", "vfr", "-c:v", "libx264"])
            .arg(&f)
            .status()
            .unwrap();
        assert!(st.success());
        let n = probe_video(&f, &ProbeOpts::frames(-1)).map(|m| m.num_frames);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(n, Ok(8));
    }

    #[test]
    fn shapes_the_networks_take() {
        // measured: these ran with every set (CPU fp32 / CUDA fp16)
        // loop: NOT-WORTH — a few test shapes
        for (sh, sw) in [(256, 384), (256, 256), (384, 384), (768, 1280), (2176, 3840)] {
            assert_eq!(model_shape_supported(sh, sw, sw, sh, false), Ok(()), "{sh}x{sw}");
            assert_eq!(model_shape_supported(sh, sw, sw, sh, true), Ok(()), "{sh}x{sw}");
        }
        // portrait: refused for the landscape-only sets (failed inside C-RADIO), taken from 2.0.0-onnx.3 on
        // loop: NOT-WORTH — a few test shapes
        for (sh, sw) in [(384, 256), (1280, 768), (1920, 1152), (3840, 2176)] {
            assert_eq!(model_shape_supported(sh, sw, sw, sh, false).unwrap_err().code.as_str(), "input", "{sh}x{sw}");
            assert_eq!(model_shape_supported(sh, sw, sw, sh, true), Ok(()), "{sh}x{sw}");
        }
        // a 128 px side failed in stage 1 with every set, onnx.3 included
        // loop: NOT-WORTH — a few test shapes
        for (sh, sw) in [(384, 128), (128, 384), (128, 128)] {
            assert_eq!(model_shape_supported(sh, sw, sw, sh, true).unwrap_err().code.as_str(), "input", "{sh}x{sw}");
        }
    }

    #[test]
    fn shape_and_pad() {
        let m = ClipMeta::with_shape(Source::Frames(vec![]), 24.0, 200, 320, 8, false, 1.0);
        assert_eq!((m.shape_h, m.shape_w), (256, 384));
        assert_eq!(m.pad, Pad { l: 32, r: 32, t: 28, b: 28 });
        assert!(!m.scaled());
        // model scale: the pad is the scaled size's (1080p at 0.5 -> 540x960 -> 640x1024)
        let m = ClipMeta::with_shape(Source::Frames(vec![]), 24.0, 1080, 1920, 8, false, 0.5);
        assert_eq!((m.model_h, m.model_w, m.shape_h, m.shape_w, m.h, m.w), (540, 960, 640, 1024, 1080, 1920));
        assert_eq!(m.pad, Pad { l: 32, r: 32, t: 50, b: 50 });
        assert!(m.scaled());
    }

    #[test]
    fn scaled_sizes_round_like_python() {
        // Python: max(1, int(round(h * scale))), round half to even
        assert_eq!(scaled_hw(1080, 1920, 0.75), (810, 1440));
        assert_eq!(scaled_hw(1081, 1919, 0.5), (540, 960)); // 540.5 -> 540, 959.5 -> 960
        assert_eq!(scaled_hw(2160, 4096, 0.25), (540, 1024));
        assert_eq!(scaled_hw(3, 3, 0.1), (1, 1)); // 0.3 -> 0 -> at least 1
        assert_eq!(scaled_hw(200, 320, 1.0), (200, 320));
        assert_eq!(scaled_hw(5, 7, 0.5), (2, 4)); // 2.5 -> 2, 3.5 -> 4
    }

    #[test]
    fn start_frames_like_probe_video_meta() {
        // whole clip, or num_frames <= 0: always 0
        assert_eq!(start_frame(100, 100, -1, StartMode::Middle, 0), 0);
        assert_eq!(start_frame(100, 100, 100, StartMode::RandomMiddle, 3), 0);
        assert_eq!(start_frame(100, 10, 10, StartMode::Begin, 0), 0);
        assert_eq!(start_frame(100, 10, 10, StartMode::Middle, 0), 45);
        assert_eq!(start_frame(101, 10, 10, StartMode::Middle, 0), 45);
        // random_middle: within [max_start // 4, 3 * max_start // 4]
        let s = start_frame(100, 10, 10, StartMode::RandomMiddle, 0);
        assert!((22..=67).contains(&s), "{s}");
        assert_eq!(StartMode::parse("random_middle").map(|m| m.name()), Some("random_middle"));
        assert_eq!(StartMode::parse("end"), None);
    }
}
