//! A `run` request's options (docs/ENGINE_PROTOCOL.md), read with the defaults and checks of
//! engine/ck_engine.py's `configs` (= infer.py's defaults). A bad option is an `input` error.
use crate::writers::WriterConfig;
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
    pub exr: bool,
    pub exr_float: bool,
    pub despill_strength: f64,
    pub cutout_linear: bool,
    pub frame_dir_fps: f64,
    pub frame_dir_linear: bool,
    pub num_frames: i64,
    pub writer: WriterConfig,
    /// opt-in TensorRT (docs/BACKLOG.md row 12); off by default
    pub tensorrt: bool,
    /// graphics memory this job may use (GB): caps the automatic window's budget and the providers' arenas;
    /// None = the free memory (CK_ENGINE_VRAM_BUDGET_GB sets an engine-wide default)
    pub vram_budget_gb: Option<f64>,
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
    let writer = WriterConfig {
        crf: int(o, "crf")?.unwrap_or(12),
        preset: string(o, "preset").unwrap_or_else(|| "medium".into()),
        pix_fmt: string(o, "pix_fmt").unwrap_or_else(|| "yuv444p10le".into()),
        ..WriterConfig::default()
    };
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
        exr: output_format == "exr",
        exr_float: exr_dtype == "float",
        despill_strength: unit(o, "despill_strength", 0.5)?,
        cutout_linear: boolean(o, "cutout_linear", false),
        frame_dir_fps: num(o, "frame_dir_fps")?.unwrap_or(24.0),
        frame_dir_linear: boolean(o, "frame_dir_linear", false),
        num_frames: int(o, "num_frames")?.unwrap_or(-1),
        writer,
        tensorrt: boolean(o, "tensorrt", false),
        vram_budget_gb: match num(o, "vram_budget_gb")? {
            Some(v) if v > 0.0 => Some(v),
            Some(v) => return Err(Error::input(format!("vram_budget_gb must be above 0, got {v}"))),
            None => std::env::var("CK_ENGINE_VRAM_BUDGET_GB").ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| *v > 0.0),
        },
    })
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
        assert_eq!(parse(&req(json!({"outputs": ["alpha", "matte"]}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"hann_chunk": "x"}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"output_format": "gif"}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"exr_dtype": "int"}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"vram_budget_gb": 0}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"hann_chunk": 2, "hann_stride": 4}))).unwrap_err().code, "input");
        assert_eq!(parse(&req(json!({"hann_chunk": 4, "hann_stride": 4}))).unwrap().hann_stride, 4);
        assert_eq!(parse(&req(json!({"vram_budget_gb": 12}))).unwrap().vram_budget_gb, Some(12.0));
        let c = parse(&req(json!({"outputs": ["fg", "checker", "alpha"], "tensorrt": true}))).unwrap();
        assert_eq!((c.outputs.join(","), c.tensorrt), ("alpha,checker,fg".to_string(), true));
    }

    #[test]
    fn documented_ranges_and_finite_numbers() {
        // the ends of 0-1 are fine
        let c = parse(&req(json!({"hint_quality": 0, "carry_hint_quality": 1, "despill_strength": "1.0"}))).unwrap();
        assert_eq!((c.hint_quality, c.carry_hint_quality, c.despill_strength), (0.0, 1.0, 1.0));
        // loop: NOT-WORTH — a test's few options
        for o in [json!({"hint_quality": 1.01}), json!({"despill_strength": -1}), json!({"carry_hint_quality": "NaN"}), json!({"num_frames": "inf"})] {
            assert_eq!(parse(&req(o.clone())).unwrap_err().code, "bad-request", "{o}");
        }
        // not a number at all stays an input error
        assert_eq!(parse(&req(json!({"despill_strength": "lots"}))).unwrap_err().code, "input");
    }

    #[test]
    fn suffixes() {
        assert_eq!(suffix("checker", 0.5), "checker_comp_despill050");
        assert_eq!(suffix("checker", 1.0), "checker_comp_despill100");
        assert_eq!(suffix("checker", 0.29), "checker_comp_despill028"); // int(28.999999999999996)
        assert_eq!(suffix("alpha", 0.5), "alpha");
    }
}
