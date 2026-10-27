//! `--report file.json`: the run as data (docs/CLI.md "Report"; schema `corridorkey-report/1`). Written however the
//! run ends, so a farm keeps the reason of a failure with the task.
use crate::progress::Seen;
use serde_json::{json, Value};
use std::path::Path;

pub const SCHEMA: &str = "corridorkey-report/1";

/// One run, as the report tells it.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub command: &'static str,
    pub exit: i32,
    /// why it failed (None: it didn't)
    pub message: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    /// the models folder and its set's version (manifest.json)
    pub models_dir: Option<String>,
    pub model_set: Option<String>,
    pub onnxruntime: Option<String>,
    /// {"name", "driver", "vram_total_mb"}
    pub gpu: Option<Value>,
    /// the frames asked for (empty: the whole shot)
    pub requested: Vec<u64>,
    /// the shot's numbers of the frames the engine writes, in order (its `frames` count runs over these)
    pub span: Vec<u64>,
    /// the frames put at their final names
    pub kept: Vec<u64>,
    /// `verify`: the files missing or not whole
    pub missing: Vec<String>,
    /// a frame folder: read scene-linear or not, and why (`--linear`, `--no-linear`, `--job`, or the default by its
    /// first frame); None for a video
    pub frame_dir_linear: Option<(bool, &'static str)>,
    /// `--skip-existing` found every frame whole: nothing ran
    pub skipped: bool,
    pub seconds: f64,
    pub seen: Seen,
}

fn first_last(v: &[u64]) -> Value {
    match (v.first(), v.last()) {
        (Some(a), Some(b)) => json!({"first": a, "last": b, "count": v.len()}),
        _ => Value::Null,
    }
}

impl Report {
    pub fn to_json(&self) -> Value {
        let s = &self.seen;
        let field = |v: &Option<Value>, k: &str| v.as_ref().and_then(|m| m.get(k)).cloned().unwrap_or(Value::Null);
        let window = s.window.as_ref().map(|m| json!({"chunk": m["hann_chunk"], "stride": m["hann_stride"], "low_vram": m["low_vram"], "auto": m["auto"]}));
        let keyed = match s.clip.as_ref().and_then(|c| c.get("range")) {
            Some(r) => json!({"first": r["keyed_first"], "last": r["keyed_last"]}),
            // a whole-shot job keys exactly the frames it writes
            None => match (s.clip.is_some(), self.span.first(), self.span.last()) {
                (true, Some(a), Some(b)) => json!({"first": a, "last": b}),
                _ => Value::Null,
            },
        };
        // loop: NOT-WORTH — one entry per written frame, once per run
        let times: Vec<Value> = self.span.iter().zip(&s.frame_done_s).map(|(f, t)| json!({"frame": f, "done_s": (t * 1000.0).round() / 1000.0})).collect();
        json!({
            "schema": SCHEMA,
            "corridorkey": crate::VERSION,
            "command": self.command,
            "exit_code": self.exit,
            "exit_reason": crate::exit::reason(self.exit),
            "message": self.message,
            "input": self.input,
            "output": self.output,
            "frame_dir_linear": self.frame_dir_linear.map(|(v, why)| json!({"value": v, "why": why})),
            "models": {"dir": self.models_dir, "set": self.model_set},
            "onnxruntime": self.onnxruntime,
            "provider": field(&s.provider, "provider"),
            "precision": field(&s.provider, "precision"),
            "provider_fallback": field(&s.provider, "fallback_reason"),
            "gpu": self.gpu,
            "window": window,
            "frames": {
                "requested": if self.requested.is_empty() { Value::Null } else { json!(self.requested) },
                "keyed": keyed,
                "written": first_last(&self.kept),
            },
            "frame_times": times,
            "seconds": (self.seconds * 1000.0).round() / 1000.0,
            "skipped": self.skipped,
            "missing": self.missing,
        })
    }

    /// Write it to `path` (a temporary name, then renamed: a reader never sees half a report). Err: why not.
    pub fn write(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.to_json()).unwrap_or_default() + "\n";
        // its folder too: a run that fails before the output folder exists still leaves its report
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("can't write the report {}: {e}", path.display()))?;
        }
        let part = path.with_file_name(format!(".{}.partial", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        std::fs::write(&part, text).and_then(|()| std::fs::rename(&part, path)).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("can't write the report {}: {e}", path.display())
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_report_creates_its_folder() {
        // farm submitters point --report into folders that may not exist yet (a run failing before the output folder)
        let d = std::env::temp_dir().join(format!("ck-report-dir-{}", std::process::id()));
        let path = d.join("not").join("yet").join("r.json");
        Report::default().write(&path).unwrap();
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&d);
    }

    use super::*;

    #[test]
    fn a_render_report_has_every_field_of_its_schema() {
        let seen = Seen {
            provider: Some(json!({"type": "provider", "provider": "cuda", "precision": "fp16", "tensorrt_requested": false})),
            window: Some(json!({"type": "memory", "hann_chunk": 24, "hann_stride": 12, "low_vram": false, "auto": true, "budget_gb": 14.2})),
            clip: Some(json!({"type": "clip", "width": 1920, "height": 1080, "fps": 24.0, "frames": 6,
                "range": {"first": 1003, "last": 1005, "keyed_first": 1001, "keyed_last": 1006, "written": 3}})),
            frame_done_s: vec![1.0, 1.0, 2.5],
        };
        let r = Report {
            command: "render",
            exit: 0,
            input: Some("/plates/sh010".into()),
            output: Some("/out/key.####.exr".into()),
            models_dir: Some("/m".into()),
            model_set: Some("2.0.0-onnx.4".into()),
            onnxruntime: Some("1.31.0".into()),
            gpu: Some(json!({"name": "NVIDIA GeForce RTX 5080", "driver": "615.1", "vram_total_mb": 16303})),
            requested: vec![1003, 1005],
            span: vec![1003, 1004, 1005],
            kept: vec![1003, 1005],
            seconds: 12.3456,
            frame_dir_linear: Some((true, "default: EXR plates")),
            seen,
            ..Report::default()
        };
        let j = r.to_json();
        assert_eq!(j["schema"], "corridorkey-report/1");
        assert_eq!((j["exit_code"].as_i64(), j["exit_reason"].as_str()), (Some(0), Some("done")));
        assert_eq!(j["message"], Value::Null);
        assert_eq!((j["provider"].as_str(), j["precision"].as_str()), (Some("cuda"), Some("fp16")));
        assert_eq!(j["window"], json!({"chunk": 24, "stride": 12, "low_vram": false, "auto": true}));
        assert_eq!(j["frames"]["requested"], json!([1003, 1005]));
        assert_eq!(j["frames"]["keyed"], json!({"first": 1001, "last": 1006}));
        assert_eq!(j["frames"]["written"], json!({"first": 1003, "last": 1005, "count": 2}));
        assert_eq!(j["frame_times"], json!([{"frame": 1003, "done_s": 1.0}, {"frame": 1004, "done_s": 1.0}, {"frame": 1005, "done_s": 2.5}]));
        assert_eq!((j["seconds"].as_f64(), j["skipped"].as_bool()), (Some(12.346), Some(false)));
        assert_eq!(j["models"], json!({"dir": "/m", "set": "2.0.0-onnx.4"}));
        assert_eq!(j["gpu"]["name"], "NVIDIA GeForce RTX 5080");
        assert_eq!(j["frame_dir_linear"], json!({"value": true, "why": "default: EXR plates"}));
        // loop: NOT-WORTH — the schema's top-level keys
        for k in ["corridorkey", "command", "input", "output", "onnxruntime", "provider_fallback", "missing"] {
            assert!(j.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn a_whole_shot_is_keyed_over_its_span_and_a_failure_carries_its_reason() {
        let seen = Seen { clip: Some(json!({"type": "clip", "frames": 3})), ..Seen::default() };
        let r =
            Report { command: "render", exit: 6, message: Some("The graphics card ran out of memory".into()), span: vec![1, 2, 3], seen, ..Report::default() };
        let j = r.to_json();
        assert_eq!(j["frames"]["keyed"], json!({"first": 1, "last": 3}));
        assert_eq!((j["exit_reason"].as_str(), j["message"].as_str()), (Some("out-of-graphics-memory"), Some("The graphics card ran out of memory")));
        assert_eq!((j["frames"]["requested"].clone(), j["frames"]["written"].clone(), j["window"].clone()), (Value::Null, Value::Null, Value::Null));
        // nothing ran: no keyed range
        assert_eq!(Report { command: "render", exit: 7, ..Report::default() }.to_json()["frames"]["keyed"], Value::Null);
    }
}
