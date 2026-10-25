//! Automatic Hann window from free graphics memory (runtime.select_vram_profile / estimate_peak_vram_gb):
//! the same table and margins as the upstream runtime.
//!
//! The table is PyTorch's measured peak (GiB) per megapixel of model input at each window length. It is used
//! unchanged for ONNX Runtime until the GPU measurements say otherwise (docs/ENGINE_RUST.md, "What's left").

/// (window lengths, rows of (megapixels, peaks per window length)) for low_vram false / true.
type Table = (&'static [usize], &'static [(f64, &'static [f64])]);

const NORMAL: Table = (
    &[8, 24, 48, 80],
    &[(0.98, &[6.19, 7.52, 9.77, 12.89]), (2.21, &[7.50, 11.33, 18.66, 24.89]), (3.93, &[9.06, 14.78, 23.92, 33.19]), (8.36, &[13.94, 25.96, 45.15, 70.45])],
);
const LOW: Table = (
    &[1, 2, 4, 8, 24, 48, 80],
    &[
        (0.98, &[2.71, 2.78, 2.94, 3.25, 4.54, 6.57, 9.50]),
        (2.21, &[2.80, 2.97, 3.35, 4.12, 7.69, 13.20, 20.56]),
        (3.93, &[2.92, 3.23, 3.85, 5.09, 10.09, 17.57, 27.75]),
        (8.36, &[3.25, 3.92, 5.28, 8.38, 20.78, 39.66, 64.65]),
    ],
);
pub(crate) const MARGIN_SCALE: f64 = 1.1;
pub(crate) const MARGIN_GB: f64 = 0.3;

fn table(low_vram: bool) -> Table {
    if low_vram {
        LOW
    } else {
        NORMAL
    }
}

/// runtime._interp: piecewise-linear through the points, extrapolating past both ends.
fn interp(x: f64, points: &[(f64, f64)]) -> f64 {
    for i in 0..points.len().saturating_sub(1) {
        let ((x0, y0), (x1, y1)) = (points[i], points[i + 1]);
        if x <= x1 || i + 2 == points.len() {
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    points[0].1
}

/// runtime.estimate_peak_vram_gb.
pub fn estimate_peak_vram_gb(megapixels: f64, frames: usize, low_vram: bool) -> f64 {
    let (chunks, rows) = table(low_vram);
    let frames = frames.max(chunks[0]) as f64;
    let per_chunk: Vec<(f64, f64)> = (0..chunks.len())
        .map(|i| {
            // loop: NOT-WORTH — the table's rows (≤ 10), once per job
            let pts: Vec<(f64, f64)> = rows.iter().map(|(mp, peaks)| (*mp, peaks[i])).collect();
            (chunks[i] as f64, interp(megapixels, &pts).max(rows[0].1[i]))
        })
        .collect();
    interp(frames, &per_chunk)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub chunk: usize,
    pub stride: usize,
    pub low_vram: bool,
    pub estimate_gb: f64,
}

impl Profile {
    pub(crate) fn fits(&self, budget_gb: f64) -> bool {
        self.estimate_gb * MARGIN_SCALE + MARGIN_GB <= budget_gb
    }
}

/// runtime.select_vram_profile: the largest window that fits `budget_gb` (a larger low-VRAM window beats a
/// smaller normal one); a single-frame low-VRAM window when nothing fits.
pub fn select_vram_profile(shape_hw: (usize, usize), num_frames: usize, budget_gb: f64) -> Profile {
    let mp = (shape_hw.0 * shape_hw.1) as f64 / 1e6;
    let mut estimate = 0.0;
    for &chunk in LOW.0.iter().rev() {
        // loop: NOT-WORTH — two modes
        for low in [false, true] {
            if !table(low).0.contains(&chunk) {
                continue;
            }
            estimate = estimate_peak_vram_gb(mp, chunk.min(num_frames), low);
            if estimate * MARGIN_SCALE + MARGIN_GB <= budget_gb {
                return Profile { chunk, stride: (chunk / 2).max(1), low_vram: low, estimate_gb: estimate };
            }
        }
    }
    Profile { chunk: 1, stride: 1, low_vram: true, estimate_gb: estimate }
}

/// GiB, the unit of the table and of the memory reply's `*_gb` fields.
const GIB: f64 = 1073741824.0;

/// The memory the estimate is weighed against (Backend::card_memory): what the automatic window sees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CardMemory {
    /// the card's total (None: the host on the CPU provider, where only the free memory is read)
    pub total: Option<u64>,
    /// free now
    pub free: u64,
    /// free plus what this engine already holds (its loaded networks count for it): the automatic window's budget
    pub budget: u64,
    /// `gpu`, or `host` on the CPU provider
    pub source: &'static str,
    pub provider: &'static str,
}

/// One window to estimate: (hann_chunk, hann_stride, low_vram).
pub type Window = (usize, usize, bool);

/// At most this many windows per `estimate` request (the app asks for its 6 choices x 2 modes).
pub const MAX_WINDOWS: usize = 64;

/// The `estimate` command's windows, checked as a run's are (job.rs): chunk and stride at least 1, the stride not
/// past the chunk.
pub fn parse_windows(v: Option<&serde_json::Value>) -> Result<Vec<Window>, crate::Error> {
    let bad = crate::Error::bad_request;
    let arr = v
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| bad("estimate needs windows: [[hann_chunk, hann_stride, low_vram], ...]".into()))?;
    if arr.len() > MAX_WINDOWS {
        return Err(bad(format!("estimate takes at most {MAX_WINDOWS} windows (got {})", arr.len())));
    }
    // loop: NOT-WORTH — at most MAX_WINDOWS windows, once per estimate request
    arr.iter()
        .map(|w| {
            let t = w.as_array().filter(|t| t.len() == 3).ok_or_else(|| bad(format!("a window is [hann_chunk, hann_stride, low_vram], got {w}")))?;
            match (t[0].as_u64(), t[1].as_u64(), t[2].as_bool()) {
                (Some(c), Some(s), Some(low)) if c >= 1 && s >= 1 && s <= c && c <= 4096 => Ok((c as usize, s as usize, low)),
                _ => Err(bad(format!("a window is [hann_chunk >= 1, 1 <= hann_stride <= hann_chunk, low_vram true|false], got {w}"))),
            }
        })
        .collect()
}

/// The `estimate` reply's windows: per window, the same peak estimate the automatic window and the `memory` reply
/// use (estimate_peak_vram_gb over the padded shape, the window capped at the clip's frames), in bytes; what the
/// automatic window requires of the budget for it (the estimate x MARGIN_SCALE + MARGIN_GB, Profile::fits); and
/// whether that fits `budget` (None: no memory reading, so no verdict).
pub fn window_estimates(shape_hw: (usize, usize), num_frames: usize, windows: &[Window], budget: Option<u64>) -> Vec<serde_json::Value> {
    let mp = (shape_hw.0 * shape_hw.1) as f64 / 1e6;
    // loop: NOT-WORTH — at most MAX_WINDOWS windows, once per estimate request
    windows
        .iter()
        .map(|&(chunk, stride, low)| {
            let frames = chunk.min(num_frames);
            let p = Profile { chunk, stride, low_vram: low, estimate_gb: estimate_peak_vram_gb(mp, frames, low) };
            let needs = p.estimate_gb * MARGIN_SCALE + MARGIN_GB;
            serde_json::json!({
                "hann_chunk": chunk, "hann_stride": stride, "low_vram": low, "frames": frames,
                "peak_bytes": (p.estimate_gb * GIB).round() as u64,
                "needs_bytes": (needs * GIB).round() as u64,
                "fits": budget.map(|b| p.fits(b as f64 / GIB)),
            })
        })
        .collect()
}

/// The `estimate` command (docs/ENGINE_PROTOCOL.md): the clip probed for its size and frame count only (no
/// decoding, no model), then the peak estimate per window against the card's memory. `cap_gb`: the request's
/// `vram_budget_gb`, else the engine's CK_ENGINE_VRAM_BUDGET_GB, capping the budget as it caps a run's.
pub fn estimate(input: &str, num_frames: i64, windows: &[Window], mem: Option<CardMemory>, cap_gb: Option<f64>) -> Result<serde_json::Value, crate::Error> {
    let meta = crate::clip::probe_size(std::path::Path::new(input), num_frames)?;
    let budget = mem.map(|m| match cap_gb {
        Some(cap) if m.source == "gpu" => m.budget.min((cap * GIB) as u64),
        _ => m.budget,
    });
    Ok(serde_json::json!({
        "type": "estimate",
        "width": meta.w, "height": meta.h, "shape_w": meta.shape_w, "shape_h": meta.shape_h, "frames": meta.num_frames,
        "total_bytes": mem.and_then(|m| m.total), "free_bytes": mem.map(|m| m.free), "budget_bytes": budget,
        "budget_source": mem.map(|m| m.source), "budget_cap_gb": cap_gb, "provider": mem.map(|m| m.provider),
        "estimate_basis": "pytorch-bf16-table", "margin_scale": MARGIN_SCALE, "margin_gb": MARGIN_GB,
        "windows": window_estimates((meta.shape_h, meta.shape_w), meta.num_frames, windows, budget),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn table_points_are_exact() {
        assert!((estimate_peak_vram_gb(0.98, 8, false) - 6.19).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(8.36, 80, true) - 64.65).abs() < 1e-12);
        // below the smallest window: clamped to it
        assert!((estimate_peak_vram_gb(0.98, 1, false) - 6.19).abs() < 1e-12);
    }

    #[test]
    fn selection_prefers_long_windows() {
        let p = select_vram_profile((1152, 1920), 240, 15.0);
        assert!(p.fits(15.0));
        let tiny = select_vram_profile((1152, 1920), 240, 1.0);
        assert_eq!((tiny.chunk, tiny.stride, tiny.low_vram), (1, 1, true));
    }

    #[test]
    fn window_estimates_are_the_auto_windows_numbers() {
        // 1920x1080 pads to 1920x1152; the same function the automatic window and the memory reply use
        let shape = (1152, 1920);
        let mp = (1152.0 * 1920.0) / 1e6;
        let w = window_estimates(shape, 240, &[(24, 12, false), (48, 24, true), (80, 40, true)], Some((15.0 * GIB) as u64));
        assert_eq!(w.len(), 3);
        let peak = |i: usize| w[i]["peak_bytes"].as_u64().unwrap() as f64 / GIB;
        assert!((peak(0) - estimate_peak_vram_gb(mp, 24, false)).abs() < 1e-6);
        assert!((peak(1) - estimate_peak_vram_gb(mp, 48, true)).abs() < 1e-6);
        // needs = peak x 1.1 + 0.3 GiB; the verdict is Profile::fits against the budget
        let needs = w[0]["needs_bytes"].as_u64().unwrap() as f64 / GIB;
        assert!((needs - (peak(0) * MARGIN_SCALE + MARGIN_GB)).abs() < 1e-6);
        assert_eq!(w[0]["fits"], json!(needs <= 15.0));
        assert_eq!(w[2]["fits"], json!(false), "80 frames at HD don't fit 15 GiB");
        // the window the automatic choice picks for 15 GiB fits by the same rule, with the same estimate
        let auto = select_vram_profile(shape, 240, 15.0);
        let a = window_estimates(shape, 240, &[(auto.chunk, auto.stride, auto.low_vram)], Some((15.0 * GIB) as u64));
        assert_eq!(a[0]["fits"], json!(true));
        assert!((a[0]["peak_bytes"].as_u64().unwrap() as f64 / GIB - auto.estimate_gb).abs() < 1e-6);
    }

    #[test]
    fn a_window_longer_than_the_clip_is_capped_and_no_reading_gives_no_verdict() {
        let w = window_estimates((768, 1024), 10, &[(48, 24, false), (8, 4, false)], None);
        assert_eq!(w[0]["frames"], json!(10));
        assert_eq!(w[0]["fits"], Value::Null);
        // 10 frames: between the table's 8 and 24 columns, so above the 8-frame window
        assert!(w[0]["peak_bytes"].as_u64() > w[1]["peak_bytes"].as_u64());
    }

    #[test]
    fn windows_are_checked() {
        assert_eq!(parse_windows(Some(&json!([[24, 12, false], [1, 1, true]]))).unwrap(), vec![(24, 12, false), (1, 1, true)]);
        // loop: NOT-WORTH — a test's few bad inputs
        for bad in [json!(null), json!([]), json!([[24, 12]]), json!([[0, 1, false]]), json!([[4, 8, false]]), json!([[4, 2, "no"]]), json!("x")] {
            assert_eq!(parse_windows(Some(&bad)).unwrap_err().code.as_str(), "bad-request", "{bad}");
        }
        assert!(parse_windows(None).is_err());
        let many: Vec<Value> = (0..=MAX_WINDOWS).map(|_| json!([8, 4, false])).collect();
        assert!(parse_windows(Some(&Value::Array(many))).is_err());
    }

    #[test]
    fn estimate_probes_a_frame_folder_and_caps_the_budget() {
        let dir = std::env::temp_dir().join(format!("ck-estimate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // loop: NOT-WORTH — three tiny test frames
        for i in 1..=3 {
            image::RgbImage::new(200, 130).save(dir.join(format!("f_{i:04}.png"))).unwrap();
        }
        let mem = CardMemory { total: Some(16 << 30), free: 12 << 30, budget: 12 << 30, source: "gpu", provider: "cuda" };
        let r = estimate(dir.to_str().unwrap(), -1, &[(8, 4, false)], Some(mem), Some(10.0)).unwrap();
        let size = (r["width"].as_u64(), r["height"].as_u64(), r["shape_w"].as_u64(), r["shape_h"].as_u64(), r["frames"].as_u64());
        assert_eq!(size, (Some(200), Some(130), Some(256), Some(256), Some(3)));
        assert_eq!(r["budget_bytes"].as_u64(), Some(10 << 30), "the cap wins over the free memory");
        assert_eq!((r["total_bytes"].as_u64(), r["free_bytes"].as_u64()), (Some(16 << 30), Some(12 << 30)));
        assert_eq!(r["windows"][0]["frames"], json!(3));
        let r2 = estimate(dir.to_str().unwrap(), 2, &[(8, 4, false)], None, None).unwrap();
        assert_eq!((r2["frames"].as_u64(), r2["total_bytes"].clone(), r2["windows"][0]["fits"].clone()), (Some(2), Value::Null, Value::Null));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(estimate("/no/such/clip.mov", -1, &[(8, 4, false)], None, None).unwrap_err().code.as_str(), "input");
    }
}
