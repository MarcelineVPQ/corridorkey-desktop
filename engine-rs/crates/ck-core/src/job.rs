//! A `run` request's options (docs/ENGINE_PROTOCOL.md), read with the defaults and checks of
//! engine/ck_engine.py's `configs` (= infer.py's defaults). A bad option is an `input` error.
use crate::writers::{VideoCodec, WriterConfig};
use crate::Error;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct JobConfig {
    pub id: String,
    pub input: String,
    pub output_dir: PathBuf,
    pub temp_dir: PathBuf,
    pub hint_first_frame: Option<String>,
    pub hint_video: Option<String>,
    pub hint_quality: f64,
    pub carry_hint: bool,
    pub carry_hint_quality: f64,
    pub hann_chunk: usize,
    pub hann_stride: usize,
    /// a window was given (hann_chunk / hann_stride / low_vram): no automatic choice
    pub manual: bool,
    pub low_vram: bool,
    /// sorted, as the runtime iterates sorted(cfg.outputs)
    pub outputs: Vec<String>,
    /// a video cutout without the alpha output asked for: the engine added it (the cutout's alpha; backlog row 26)
    pub alpha_for_cutout: bool,
    pub exr: bool,
    pub exr_float: bool,
    pub despill_strength: f64,
    pub cutout_linear: bool,
    pub frame_dir_fps: f64,
    pub frame_dir_linear: bool,
    pub num_frames: i64,
    /// `--model_scale` (backlog row 42): > 0, 1.0 = native
    pub model_scale: f64,
    /// `--start_mode` / `--seed` (backlog row 45): which part of a video `num_frames` takes
    pub start_mode: crate::clip::StartMode,
    pub seed: u64,
    /// `--linear_brightness` / `--linear_contrast` / `--linear_contrast_pivot` as given (backlog row 45; video inputs)
    pub linear_brightness: f64,
    pub linear_contrast: f64,
    pub linear_contrast_pivot: f64,
    pub writer: WriterConfig,
    /// opt-in TensorRT (docs/BACKLOG.md row 12); off by default
    pub tensorrt: bool,
    /// a TensorRT job may build its range's engines (default); false: a range not built yet runs on CUDA, exactly as
    /// a job without TensorRT (the app builds ranges in the background with `trt_build`, never inside a job)
    pub tensorrt_build: bool,
    /// graphics memory this job may use (GB): caps the automatic window's budget and the providers' arenas;
    /// None = the free memory (the engine's CK_ENGINE_VRAM_BUDGET_GB, config.rs, is applied by Pipeline::run)
    pub vram_budget_gb: Option<f64>,
    /// colour management (backlog row 29, ocio.rs): the OCIO config (a path or an `ocio://` name; None = `$OCIO`,
    /// else the built-in ACES studio config), the clip's colour space (None = read as CorridorKey 2.0 reads it) and
    /// the EXR outputs' colour space (None = the input's own space when one is given, else linear Rec.709)
    pub color_config: Option<String>,
    pub input_colorspace: Option<String>,
    pub output_colorspace: Option<String>,
}

fn num(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<f64>, Error> {
    let v = match o.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::String(s)) => Some(s.trim().parse::<f64>().map_err(|_| Error::input(format!("{k}: not a number: {s:?}")))?),
        Some(v) => return Err(Error::input(format!("{k}: not a number: {v}"))),
    };
    // "nan", "inf" (as strings: JSON numbers can't be) would pass every range check below and reach the networks
    match v {
        Some(x) if !x.is_finite() => Err(Error::bad_request(format!("{k}: must be a finite number, got {x}"))),
        _ => Ok(v),
    }
}

/// An option documented as 0-1 (docs/ENGINE_PROTOCOL.md): `default` when absent, a bad request outside the range.
fn unit(o: &serde_json::Map<String, Value>, k: &str, default: f64) -> Result<f64, Error> {
    match num(o, k)? {
        None => Ok(default),
        Some(v) if (0.0..=1.0).contains(&v) => Ok(v),
        Some(v) => Err(Error::bad_request(format!("{k} must be between 0 and 1, got {v}"))),
    }
}

/// The linear adjust's gain and contrast: `default` when absent, a bad request at 0 or below (upstream divides by
/// both in its inverse: 0 gives infinite colour, a negative value turns the image inside out).
fn positive(o: &serde_json::Map<String, Value>, k: &str, default: f64) -> Result<f64, Error> {
    match num(o, k)? {
        None => Ok(default),
        Some(v) if v > 0.0 => Ok(v),
        Some(v) => Err(Error::bad_request(format!("{k} must be above 0, got {v}"))),
    }
}

fn int(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<i64>, Error> {
    Ok(num(o, k)?.map(|v| v.trunc() as i64))
}

/// Python's bool(): false, 0, "", null are false.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn boolean(o: &serde_json::Map<String, Value>, k: &str, default: bool) -> bool {
    o.get(k).map(truthy).unwrap_or(default)
}

fn string(o: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    match o.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(v) => Some(v.to_string()),
    }
}

/// libx264's presets (`ffmpeg -h encoder=libx264`, x264 --preset).
pub(crate) const X264_PRESETS: [&str; 10] = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"];
/// The pixel formats ffmpeg's libx264 encoder takes (`ffmpeg -h encoder=libx264`, "Supported pixel formats"), and
/// their bit depth (x264's CRF scale goes to 51 at 8 bits, 63 at 10).
pub(crate) const X264_PIX_FMTS: [(&str, u32); 15] = [
    ("yuv420p", 8),
    ("yuvj420p", 8),
    ("yuv422p", 8),
    ("yuvj422p", 8),
    ("yuv444p", 8),
    ("yuvj444p", 8),
    ("nv12", 8),
    ("nv16", 8),
    ("nv21", 8),
    ("gray", 8),
    ("yuv420p10le", 10),
    ("yuv422p10le", 10),
    ("yuv444p10le", 10),
    ("nv20le", 10),
    ("gray10le", 10),
];

/// The video writer's settings against what libx264 takes: a bad-request before any model loads (it was an
/// ffmpeg failure after the whole RVM pass).
fn check_writer(w: &WriterConfig) -> Result<(), Error> {
    if !X264_PRESETS.contains(&w.preset.as_str()) {
        return Err(Error::bad_request(format!("preset {:?} isn't one of libx264's: {}", w.preset, X264_PRESETS.join(", "))));
    }
    // loop: NOT-WORTH — fifteen pixel formats, once per job
    let Some(&(_, depth)) = X264_PIX_FMTS.iter().find(|(f, _)| *f == w.pix_fmt) else {
        // loop: NOT-WORTH — fifteen names for the message
        let names: Vec<&str> = X264_PIX_FMTS.iter().map(|(f, _)| *f).collect();
        return Err(Error::bad_request(format!("pix_fmt {:?} isn't one libx264 takes: {}", w.pix_fmt, names.join(", "))));
    };
    let max = if depth > 8 { 63 } else { 51 };
    if !(0..=max).contains(&w.crf) {
        return Err(Error::bad_request(format!("crf must be between 0 and {max} for {}, got {}", w.pix_fmt, w.crf)));
    }
    Ok(())
}

/// `model_scale` (a run option and an `estimate` field): absent = 1.0; any finite number above 0 (video_io.scaled_hw
/// refuses 0 and below), at most MAX_MODEL_SCALE.
pub fn model_scale(o: &serde_json::Map<String, Value>) -> Result<f64, Error> {
    match num(o, "model_scale")? {
        None => Ok(1.0),
        Some(v) if v > 0.0 && v <= MAX_MODEL_SCALE => Ok(v),
        Some(v) => Err(Error::bad_request(format!("model_scale must be above 0 and at most {MAX_MODEL_SCALE}, got {v}"))),
    }
}

/// The largest model scale taken: the original has no ceiling; 2x the native size is already 4x the pixels (a 4K
/// clip at 2.0 is 8K inside the networks), and a scale far past it only fails later, out of memory.
pub const MAX_MODEL_SCALE: f64 = 2.0;

/// Parse a run request (it already has id, input, output_dir and temp_dir: the engine checked them).
pub fn parse(req: &Value) -> Result<JobConfig, Error> {
    let s = |k: &str| req.get(k).and_then(|v| v.as_str().map(|x| x.to_string()).or_else(|| (!v.is_null()).then(|| v.to_string())));
    let id = s("id").ok_or_else(|| Error::input("id missing".into()))?;
    let input = s("input").ok_or_else(|| Error::input("input missing".into()))?;
    let output_dir = PathBuf::from(s("output_dir").ok_or_else(|| Error::input("output_dir missing".into()))?);
    let temp_dir = PathBuf::from(s("temp_dir").ok_or_else(|| Error::input("temp_dir missing".into()))?);
    let empty = serde_json::Map::new();
    let o = match req.get("options") {
        Some(Value::Object(m)) => m,
        None | Some(Value::Null) => &empty,
        Some(v) => return Err(Error::input(format!("options must be an object, got {v}"))),
    };
    let mut outputs: Vec<String> = match o.get("outputs") {
        // loop: NOT-WORTH — ≤ four output names, once per job
        Some(Value::Array(a)) if !a.is_empty() => a.iter().map(|v| v.as_str().map(|x| x.to_string()).unwrap_or_else(|| v.to_string())).collect(),
        _ => vec!["alpha".into(), "fg".into()],
    };
    outputs.sort();
    outputs.dedup();
    // loop: NOT-WORTH — ≤ four output names, once per job
    let bad: Vec<&String> = outputs.iter().filter(|x| !crate::render::OUTPUTS.contains(&x.as_str())).collect();
    if !bad.is_empty() {
        return Err(Error::input(format!("unsupported outputs: {bad:?}")));
    }
    let manual = o.contains_key("hann_chunk") || o.contains_key("hann_stride") || boolean(o, "low_vram", false);
    let chunk = match int(o, "hann_chunk")? {
        Some(c) if c != 0 => c,
        _ => 80,
    };
    let stride = match int(o, "hann_stride")? {
        Some(s) if s != 0 => s,
        _ => (chunk / 2).max(1),
    };
    if chunk < 1 || stride < 1 {
        return Err(Error::input(format!("hann_chunk and hann_stride must be at least 1 (got {chunk}, {stride})")));
    }
    // a stride past the window leaves frames no window covers: measured (CPU, 8 frames at 2/4), normal mode wrote
    // 6 of 8 frames and reported success; low-VRAM rendered the uncovered frames from never-written (zero) states
    if stride > chunk {
        return Err(Error::input(format!(
            "hann_stride ({stride}) must not be larger than hann_chunk ({chunk}): frames between the windows would get no matte"
        )));
    }
    let output_format = string(o, "output_format").unwrap_or_else(|| "video".into());
    if output_format != "video" && output_format != "exr" {
        return Err(Error::input(format!("unsupported output format: {output_format}")));
    }
    let exr_dtype = string(o, "exr_dtype").unwrap_or_else(|| "half".into());
    if exr_dtype != "half" && exr_dtype != "float" {
        return Err(Error::input(format!("exr dtype must be 'half' or 'float', got {exr_dtype:?}")));
    }
    let codec_name = string(o, "video_codec");
    let codec = codec_name.as_deref().map(|n| VideoCodec::parse(n).ok_or(n)).unwrap_or(Ok(VideoCodec::H264Crf12));
    let mut writer = WriterConfig {
        crf: int(o, "crf")?.unwrap_or(12),
        preset: string(o, "preset").unwrap_or_else(|| "medium".into()),
        pix_fmt: string(o, "pix_fmt").unwrap_or_else(|| "yuv444p10le".into()),
        ..WriterConfig::default()
    };
    // (EXR jobs don't use the video writer's settings)
    let mut alpha_for_cutout = false;
    if output_format == "video" {
        writer.codec = codec.map_err(|n| Error::bad_request(format!("video_codec {n:?} isn't one of: {}", VideoCodec::NAMES.join(", "))))?;
        check_writer(&writer)?;
        // no video codec here carries alpha: the video cutout is premultiplied colour and its alpha is the matte
        // output, written with it (backlog row 26)
        if outputs.iter().any(|x| x == "cutout") && !outputs.iter().any(|x| x == "alpha") {
            outputs.push("alpha".into());
            outputs.sort();
            alpha_for_cutout = true;
        }
    }
    Ok(JobConfig {
        id,
        input,
        output_dir,
        temp_dir,
        hint_first_frame: string(o, "hint_first_frame"),
        hint_video: string(o, "hint_video"),
        hint_quality: unit(o, "hint_quality", 0.95)?,
        carry_hint: boolean(o, "carry_hint", true),
        carry_hint_quality: unit(o, "carry_hint_quality", 0.95)?,
        hann_chunk: chunk as usize,
        hann_stride: stride as usize,
        manual,
        low_vram: boolean(o, "low_vram", false),
        outputs,
        alpha_for_cutout,
        exr: output_format == "exr",
        exr_float: exr_dtype == "float",
        despill_strength: unit(o, "despill_strength", 0.5)?,
        cutout_linear: boolean(o, "cutout_linear", false),
        frame_dir_fps: num(o, "frame_dir_fps")?.unwrap_or(24.0),
        frame_dir_linear: boolean(o, "frame_dir_linear", false),
        num_frames: int(o, "num_frames")?.unwrap_or(-1),
        model_scale: model_scale(o)?,
        start_mode: match string(o, "start_mode") {
            None => crate::clip::StartMode::Begin,
            Some(s) => {
                crate::clip::StartMode::parse(&s).ok_or_else(|| Error::bad_request(format!("start_mode must be begin, middle or random_middle, got {s:?}")))?
            }
        },
        seed: match num(o, "seed")? {
            None => 0,
            // numpy's SeedSequence takes non-negative integers only
            Some(v) if v >= 0.0 && v.fract() == 0.0 && v < 18446744073709551616.0 => v as u64,
            Some(v) => return Err(Error::bad_request(format!("seed must be a whole number 0 or above, got {v}"))),
        },
        linear_brightness: positive(o, "linear_brightness", 1.0)?,
        linear_contrast: positive(o, "linear_contrast", 1.0)?,
        linear_contrast_pivot: num(o, "linear_contrast_pivot")?.unwrap_or(0.18),
        writer,
        tensorrt: boolean(o, "tensorrt", false),
        tensorrt_build: boolean(o, "tensorrt_build", true),
        vram_budget_gb: match num(o, "vram_budget_gb")? {
            Some(v) if v > 0.0 => Some(v),
            Some(v) => return Err(Error::input(format!("vram_budget_gb must be above 0, got {v}"))),
            // the engine-wide default (CK_ENGINE_VRAM_BUDGET_GB) is the pipeline's to apply: parsing reads no environment
            None => None,
        },
        // an empty string is absent (the app may send "" for "not set")
        color_config: string(o, "color_config").filter(|s| !s.trim().is_empty()),
        input_colorspace: string(o, "input_colorspace").filter(|s| !s.trim().is_empty()),
        output_colorspace: string(o, "output_colorspace").filter(|s| !s.trim().is_empty()),
    })
}

impl JobConfig {
    /// The linear adjust as the runtime applies it (identity at brightness = contrast = 1).
    pub fn adjust(&self) -> crate::color::LinearAdjust {
        crate::color::LinearAdjust::new(self.linear_brightness, self.linear_contrast, self.linear_contrast_pivot)
    }
    /// What the video probe takes from the job.
    pub fn probe_opts(&self) -> crate::clip::ProbeOpts {
        crate::clip::ProbeOpts {
            num_frames: self.num_frames,
            model_scale: self.model_scale,
            start_mode: self.start_mode,
            seed: self.seed,
            adjust: self.adjust(),
        }
    }
}

/// The file-name suffix of an output (runtime.run_inference's `suffix`).
pub(crate) fn suffix(name: &str, despill: f64) -> String {
    if name == "checker" {
        // f"{int(cfg.despill_strength * 100):03d}"
        format!("checker_comp_despill{:03}", (despill * 100.0).trunc() as i64)
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(o: Value) -> Value {
        json!({"cmd":"run","id":"j1","input":"/c/a.mp4","output_dir":"/o","temp_dir":"/t","options":o})
    }

    #[test]
    fn defaults_are_infer_py_defaults() {
        let c = parse(&req(json!({}))).unwrap();
        assert_eq!((c.hann_chunk, c.hann_stride, c.manual, c.low_vram), (80, 40, false, false));
        assert_eq!(c.outputs, vec!["alpha", "fg"]);
        assert_eq!((c.hint_quality, c.carry_hint, c.carry_hint_quality, c.despill_strength), (0.95, true, 0.95, 0.5));
        assert_eq!((c.exr, c.exr_float, c.num_frames, c.frame_dir_fps, c.tensorrt), (false, false, -1, 24.0, false));
        assert_eq!((c.writer.crf, c.writer.preset.as_str(), c.writer.pix_fmt.as_str()), (12, "medium", "yuv444p10le"));
        assert_eq!((c.color_config, c.input_colorspace, c.output_colorspace), (None, None, None));
    }

    #[test]
    fn colour_fields() {
        let c = parse(&req(json!({"color_config": "ocio://studio-config-latest", "input_colorspace": "ACEScg", "output_colorspace": ""}))).unwrap();
        assert_eq!(c.color_config.as_deref(), Some("ocio://studio-config-latest"));
        assert_eq!(c.input_colorspace.as_deref(), Some("ACEScg"));
        assert_eq!(c.output_colorspace, None);
    }

    #[test]
    fn manual_window() {
        let c = parse(&req(json!({"hann_chunk": 24}))).unwrap();
        assert_eq!((c.hann_chunk, c.hann_stride, c.manual), (24, 12, true));
        let c = parse(&req(json!({"low_vram": true}))).unwrap();
        assert_eq!((c.hann_chunk, c.hann_stride, c.manual, c.low_vram), (80, 40, true, true));
        // the app sends low_vram false with a manual window
        let c = parse(&req(json!({"hann_chunk": 8, "hann_stride": 4, "low_vram": false}))).unwrap();
        assert_eq!((c.hann_chunk, c.hann_stride, c.manual, c.low_vram), (8, 4, true, false));
        assert!(!parse(&req(json!({"low_vram": false}))).unwrap().manual);
    }

    #[test]
    fn bad_options_are_input_errors() {
        assert_eq!(parse(&req(json!({"outputs": ["alpha", "matte"]}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"hann_chunk": "x"}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"output_format": "gif"}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"exr_dtype": "int"}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"vram_budget_gb": 0}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"hann_chunk": 2, "hann_stride": 4}))).unwrap_err().code.as_str(), "input");
        assert_eq!(parse(&req(json!({"hann_chunk": 4, "hann_stride": 4}))).unwrap().hann_stride, 4);
        assert_eq!(parse(&req(json!({"vram_budget_gb": 12}))).unwrap().vram_budget_gb, Some(12.0));
        let c = parse(&req(json!({"outputs": ["fg", "checker", "alpha"], "tensorrt": true}))).unwrap();
        assert_eq!((c.outputs.join(","), c.tensorrt), ("alpha,checker,fg".to_string(), true));
        // `tensorrt_build` (additive): absent = a job may build its range, as before
        assert!(c.tensorrt_build);
        assert!(!parse(&req(json!({"tensorrt": true, "tensorrt_build": false}))).unwrap().tensorrt_build);
    }

    #[test]
    fn documented_ranges_and_finite_numbers() {
        // the ends of 0-1 are fine
        let c = parse(&req(json!({"hint_quality": 0, "carry_hint_quality": 1, "despill_strength": "1.0"}))).unwrap();
        assert_eq!((c.hint_quality, c.carry_hint_quality, c.despill_strength), (0.0, 1.0, 1.0));
        // loop: NOT-WORTH — a test's few options
        for o in [json!({"hint_quality": 1.01}), json!({"despill_strength": -1}), json!({"carry_hint_quality": "NaN"}), json!({"num_frames": "inf"})] {
            assert_eq!(parse(&req(o.clone())).unwrap_err().code.as_str(), "bad-request", "{o}");
        }
        // not a number at all stays an input error
        assert_eq!(parse(&req(json!({"despill_strength": "lots"}))).unwrap_err().code.as_str(), "input");
    }

    #[test]
    fn writer_settings_are_checked_before_anything_runs() {
        let c = parse(&req(json!({"preset": "slow", "pix_fmt": "yuv420p", "crf": 51}))).unwrap();
        assert_eq!((c.writer.preset.as_str(), c.writer.pix_fmt.as_str(), c.writer.crf), ("slow", "yuv420p", 51));
        assert_eq!(parse(&req(json!({"crf": 63}))).unwrap().writer.crf, 63); // 10-bit default: x264's longer scale
                                                                             // loop: NOT-WORTH — a test's few options
        for o in [json!({"preset": "warp"}), json!({"pix_fmt": "rgb24"}), json!({"pix_fmt": "yuv420p", "crf": 52}), json!({"crf": 64}), json!({"crf": -1})] {
            assert_eq!(parse(&req(o.clone())).unwrap_err().code.as_str(), "bad-request", "{o}");
        }
        // an EXR job doesn't use them
        assert!(parse(&req(json!({"output_format": "exr", "preset": "warp"}))).is_ok());
    }

    #[test]
    fn video_codec_and_the_cutouts_alpha() {
        // absent: today's H.264 CRF 12 (the PyTorch engine's and infer.py's output)
        assert_eq!(parse(&req(json!({}))).unwrap().writer.codec, VideoCodec::H264Crf12);
        assert_eq!(parse(&req(json!({"video_codec": "h264-lossless"}))).unwrap().writer.codec, VideoCodec::H264Lossless);
        assert_eq!(parse(&req(json!({"video_codec": "dnxhr444"}))).unwrap().writer.codec, VideoCodec::Dnxhr444);
        let e = parse(&req(json!({"video_codec": "prores"}))).unwrap_err();
        assert_eq!(e.code.as_str(), "bad-request");
        assert!(e.message.contains("h264-lossless, dnxhr444, h264-crf12"), "{}", e.message);
        assert!(parse(&req(json!({"output_format": "exr", "video_codec": "prores"}))).is_ok());
        // a video cutout brings its alpha (the matte output); EXR cutouts carry their own
        let c = parse(&req(json!({"outputs": ["cutout"], "video_codec": "dnxhr444"}))).unwrap();
        assert_eq!((c.outputs.join(","), c.alpha_for_cutout), ("alpha,cutout".to_string(), true));
        let c = parse(&req(json!({"outputs": ["cutout", "alpha"]}))).unwrap();
        assert_eq!((c.outputs.join(","), c.alpha_for_cutout), ("alpha,cutout".to_string(), false));
        let c = parse(&req(json!({"outputs": ["cutout"], "output_format": "exr"}))).unwrap();
        assert_eq!((c.outputs.join(","), c.alpha_for_cutout), ("cutout".to_string(), false));
    }

    #[test]
    fn model_scale_start_mode_and_linear_adjust() {
        let c = parse(&req(json!({}))).unwrap();
        assert_eq!((c.model_scale, c.start_mode, c.seed), (1.0, crate::clip::StartMode::Begin, 0));
        assert_eq!((c.linear_brightness, c.linear_contrast, c.linear_contrast_pivot), (1.0, 1.0, 0.18));
        assert!(c.adjust().is_identity());
        let c = parse(&req(json!({"model_scale": 0.5, "start_mode": "random_middle", "seed": 7, "linear_brightness": 2, "linear_contrast": "1.25", "linear_contrast_pivot": 0.1}))).unwrap();
        assert_eq!((c.model_scale, c.start_mode, c.seed), (0.5, crate::clip::StartMode::RandomMiddle, 7));
        assert_eq!((c.linear_brightness, c.linear_contrast, c.linear_contrast_pivot), (2.0, 1.25, 0.1));
        assert!(!c.adjust().is_identity());
        assert_eq!(c.probe_opts().model_scale, 0.5);
        // loop: NOT-WORTH — a test's few options
        for o in [
            json!({"model_scale": 0}),
            json!({"model_scale": -0.5}),
            json!({"model_scale": 2.5}),
            json!({"start_mode": "end"}),
            json!({"seed": -1}),
            json!({"seed": 1.5}),
            json!({"linear_brightness": 0}),
            json!({"linear_contrast": -1}),
            json!({"linear_contrast_pivot": "inf"}),
        ] {
            assert_eq!(parse(&req(o.clone())).unwrap_err().code.as_str(), "bad-request", "{o}");
        }
    }

    #[test]
    fn suffixes() {
        assert_eq!(suffix("checker", 0.5), "checker_comp_despill050");
        assert_eq!(suffix("checker", 1.0), "checker_comp_despill100");
        assert_eq!(suffix("checker", 0.29), "checker_comp_despill028"); // int(28.999999999999996)
        assert_eq!(suffix("alpha", 0.5), "alpha");
    }
}
