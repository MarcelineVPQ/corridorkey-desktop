//! `<clip>_settings.txt`, written as runtime.run_inference writes it (Python's str() of each value).

/// Python's repr of a float: shortest round trip, always with a dot or an exponent ("1.0", "0.95", "1e-07").
pub(crate) fn py_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let a = v.abs();
    if a != 0.0 && !(1e-4..1e16).contains(&a) {
        // Python switches to exponent notation: mantissa digits as the shortest round trip
        let s = format!("{v:e}"); // "1e-7", "1.5e16"
        let (m, e) = s.split_once('e').unwrap();
        let exp: i32 = e.parse().unwrap();
        return format!("{m}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs());
    }
    let s = format!("{v}");
    if s.contains('.') {
        s
    } else {
        format!("{s}.0")
    }
}

pub(crate) fn py_bool(b: bool) -> &'static str {
    if b {
        "True"
    } else {
        "False"
    }
}

pub(crate) fn py_opt(s: Option<&str>) -> String {
    s.map(|x| x.to_string()).unwrap_or_else(|| "None".into())
}

/// The values the settings log lists.
pub(crate) struct SettingsLog<'a> {
    pub(crate) input: &'a str,
    pub(crate) output_dir: &'a str,
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) fps: f64,
    pub(crate) outputs: &'a [String],
    pub(crate) output_format: &'a str,
    pub(crate) exr_dtype: &'a str,
    pub(crate) hint_first_frame: Option<&'a str>,
    pub(crate) hint_video: Option<&'a str>,
    pub(crate) hint_quality: f64,
    pub(crate) carry_hint: bool,
    pub(crate) carry_hint_quality: f64,
    pub(crate) despill_strength: f64,
    pub(crate) cutout_linear: bool,
    pub(crate) frame_dir_linear: bool,
    pub(crate) hann_chunk: usize,
    pub(crate) hann_stride: usize,
    pub(crate) low_vram: bool,
    pub(crate) num_frames: i64,
    /// the decoders the frames are read with (additive lines at the end)
    pub(crate) decoders: &'a crate::decode::Decoders,
    /// EXR jobs: how the frames are numbered (clip.rs FrameNumbers::describe; an additive line at the end)
    pub(crate) exr_frames: Option<String>,
    /// colour-managed jobs: the OCIO lines (ocio::ColorJob::settings_lines; additive lines at the end)
    pub(crate) color: Option<String>,
}

pub(crate) fn settings_text(s: &SettingsLog) -> String {
    // loop: NOT-WORTH — ≤ four outputs, once per job
    let mut sorted: Vec<&String> = s.outputs.iter().collect();
    sorted.sort();
    let mut t = String::new();
    t.push_str("CorridorKey v2 Inference Settings Log\n");
    t.push_str("====================================\n");
    t.push_str(&format!("Input: {}\n", s.input));
    t.push_str(&format!("Output Directory: {}\n", s.output_dir));
    t.push_str(&format!("Resolution: {}x{}\n", s.w, s.h));
    t.push_str(&format!("FPS: {}\n", py_float(s.fps)));
    // loop: NOT-WORTH — ≤ four outputs, once per job
    t.push_str(&format!("Outputs: {}\n", sorted.iter().map(|x| x.as_str()).collect::<Vec<_>>().join(", ")));
    t.push_str(&format!("Output Format: {}\n", s.output_format));
    if s.output_format == "exr" {
        t.push_str(&format!("EXR Pixel Type: {}\n", s.exr_dtype));
    }
    t.push_str(&format!("Hint First Frame: {}\n", py_opt(s.hint_first_frame)));
    t.push_str(&format!("Hint Video: {}\n", py_opt(s.hint_video)));
    t.push_str(&format!("Hint Quality (Trust): {}\n", py_float(s.hint_quality)));
    t.push_str(&format!("Carry Hint: {}\n", py_bool(s.carry_hint)));
    t.push_str(&format!("Carry Hint Quality: {}\n", py_float(s.carry_hint_quality)));
    t.push_str(&format!("Despill Strength: {}\n", py_float(s.despill_strength)));
    t.push_str(&format!("Cutout Linear: {}\n", py_bool(s.cutout_linear)));
    t.push_str(&format!("Frame Dir Linear: {}\n", py_bool(s.frame_dir_linear)));
    t.push_str(&format!("Hann Chunk: {}\n", s.hann_chunk));
    t.push_str(&format!("Hann Stride: {}\n", s.hann_stride));
    t.push_str(&format!("Low VRAM: {}\n", py_bool(s.low_vram)));
    t.push_str("Model Scale: 1.0\n");
    t.push_str(&format!("Num Frames: {}\n", s.num_frames));
    t.push_str("Start Mode: begin\n");
    t.push_str("Seed: 0\n");
    t.push_str("Linear Brightness: 1.0\n");
    t.push_str("Linear Contrast: 1.0\n");
    t.push_str("Linear Contrast Pivot: 0.18\n");
    t.push_str(&format!("JPEG Decoder: {}\n", s.decoders.jpeg));
    t.push_str(&format!("FFmpeg: {}\n", s.decoders.ffmpeg));
    t.push_str(&format!("FFprobe: {}\n", s.decoders.ffprobe));
    if let Some(f) = &s.exr_frames {
        t.push_str(&format!("EXR Frame Numbers: {f}\n"));
    }
    if let Some(c) = &s.color {
        t.push_str(c);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exr_frame_numbers_line() {
        let d = crate::decode::Decoders { jpeg: "j".into(), ffmpeg: "8.0".into(), ffprobe: "8.0".into() };
        let log = |exr_frames: Option<String>| {
            settings_text(&SettingsLog {
                input: "/c/a",
                output_dir: "/o",
                w: 8,
                h: 8,
                fps: 24.0,
                outputs: &["alpha".to_string()],
                output_format: "exr",
                exr_dtype: "half",
                hint_first_frame: None,
                hint_video: None,
                hint_quality: 0.95,
                carry_hint: true,
                carry_hint_quality: 0.95,
                despill_strength: 0.5,
                cutout_linear: false,
                frame_dir_linear: false,
                hann_chunk: 4,
                hann_stride: 2,
                low_vram: false,
                num_frames: -1,
                decoders: &d,
                exr_frames,
                color: None,
            })
        };
        assert!(log(Some("source (65-184)".into())).ends_with("FFprobe: 8.0\nEXR Frame Numbers: source (65-184)\n"));
        assert!(log(None).ends_with("FFprobe: 8.0\n"));
    }

    #[test]
    fn python_float_repr() {
        assert_eq!(py_float(1.0), "1.0");
        assert_eq!(py_float(0.95), "0.95");
        assert_eq!(py_float(23.976023976023978), "23.976023976023978");
        assert_eq!(py_float(24.0), "24.0");
        assert_eq!(py_float(1e-7), "1e-07");
        assert_eq!(py_float(0.0001), "0.0001");
        assert_eq!(py_float(-2.5e20), "-2.5e+20");
        assert_eq!(py_float(0.0), "0.0");
    }
}
