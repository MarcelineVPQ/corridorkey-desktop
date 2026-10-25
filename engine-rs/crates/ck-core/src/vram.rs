//! Peak graphics memory per Hann window, measured for this engine on ONNX Runtime (CUDA), and the automatic window
//! chosen from it (runtime.select_vram_profile's search with this engine's numbers).
//!
//! The table is the measured peak (GiB: nvidia-smi over the engine's process tree, tools/engine_bench.mjs; RTX 5080,
//! ONNX Runtime 1.31 CUDA, 2026-10-24, docs/BACKLOG.md row 41) per padded model-input size (megapixels: 960x720,
//! 1280x1080, 1920x1080, 2560x1440, 3200x1800, 4096x2160) and window length, the highest of the clips and runs at
//! each point, rounded up to 0.01 GiB, then made monotone (never lower for a longer window or a larger size). A
//! window not measured at a size takes the next measured window's peak; past the largest one that ran, it is
//! proportional to the window, and at least 14 GiB where the 16 GB card ran out of memory (those runs had a 14 GiB
//! budget). It replaced the upstream runtime's PyTorch table, which was up to 32 % under real peaks and 73 % over.
//!
//! Read so that it stays an upper bound (estimate_peak_vram_gb):
//! - window: the next table window at or above (the peak never falls as the window grows); past the largest,
//!   proportional to the window;
//! - size: the next measured size at or above; below the smallest, the smallest's; above the largest, proportional
//!   to the megapixels;
//! - then UPLIFT on top: the largest spread between clips and runs at one point (5.3 %), rounded up.
//!
//! Every measured peak is in the tests (`measured_peaks_are_bounded`). Between the measured sizes the bound rests on
//! the peak growing with the size, which the measurements break at single points (cuDNN picks its algorithms per
//! shape: 1920x1080 at window 2 or 4 peaks higher than 2560x1440): an unmeasured size can be over the estimate.

/// (window lengths, rows of (megapixels, peak GiB per window length)) for low_vram false / true.
type Table = (&'static [usize], &'static [(f64, &'static [f64])]);

const NORMAL: Table = (
    &[8, 16, 24, 48, 80],
    &[
        (0.786432, &[4.37, 4.75, 5.55, 7.11, 8.00]),
        (1.47456, &[5.13, 5.90, 7.46, 10.54, 17.57]),
        (2.21184, &[5.90, 7.00, 9.31, 18.61, 31.01]),
        (3.93216, &[6.02, 7.91, 10.14, 20.28, 33.80]),
        (6.144, &[9.35, 18.70, 28.05, 56.09, 93.48]),
        (8.912896, &[11.02, 22.03, 33.04, 66.08, 110.12]),
    ],
);
const LOW: Table = (
    &[1, 2, 4, 8, 16, 24, 48, 56, 64, 80],
    &[
        (0.786432, &[1.91, 2.61, 2.61, 2.73, 3.30, 4.38, 6.80, 9.20, 9.20, 9.20]),
        (1.47456, &[1.91, 3.37, 3.58, 4.00, 4.96, 7.38, 8.47, 9.96, 10.65, 14.00]),
        (2.21184, &[1.91, 4.26, 4.51, 5.19, 6.98, 9.83, 11.35, 13.25, 15.14, 18.92]),
        (3.93216, &[2.21, 4.26, 4.51, 5.45, 8.68, 9.83, 17.22, 20.09, 22.96, 28.70]),
        (6.144, &[3.16, 4.26, 5.92, 9.87, 19.73, 29.59, 59.18, 69.05, 78.91, 98.64]),
        (8.912896, &[4.10, 4.45, 7.78, 9.87, 19.73, 29.59, 59.18, 69.05, 78.91, 98.64]),
    ],
);
/// On top of the table (the module header).
pub(crate) const UPLIFT: f64 = 0.06;
/// The automatic window's safety margin: the estimate x MARGIN_SCALE + MARGIN_GB must fit the budget
/// (Profile::fits). Kept at the upstream runtime's although the table is now a measured bound: a TensorRT job takes
/// the same window and its peaks are not in the table (row 41).
pub(crate) const MARGIN_SCALE: f64 = 1.1;
pub(crate) const MARGIN_GB: f64 = 0.3;
/// The windows the automatic choice tries, longest first (the upstream runtime's set), the normal mode only at
/// AUTO_NORMAL. The table has more windows (16, 56, 64) to bound manual windows and short clips.
const AUTO_WINDOWS: [usize; 7] = [80, 48, 24, 8, 4, 2, 1];
const AUTO_NORMAL: [usize; 4] = [8, 24, 48, 80];

fn table(low_vram: bool) -> Table {
    if low_vram {
        LOW
    } else {
        NORMAL
    }
}

/// Column `i`'s peak at `megapixels`: the next measured size at or above (the smallest's below them),
/// proportional to the megapixels above the largest.
fn at_size(rows: &[(f64, &[f64])], i: usize, megapixels: f64) -> f64 {
    match rows.iter().find(|(mp, _)| megapixels <= *mp) {
        Some((_, peaks)) => peaks[i],
        None => {
            let (mp, peaks) = rows[rows.len() - 1];
            peaks[i] * megapixels / mp
        }
    }
}

/// The peak graphics memory (GiB) of a job whose model input is `megapixels` (the padded size) with `frames` frames
/// per window (the window, capped at the clip's frames): an upper bound (the module header). One function for the
/// automatic window, the `memory` reply and the `estimate` command.
pub fn estimate_peak_vram_gb(megapixels: f64, frames: usize, low_vram: bool) -> f64 {
    let (windows, rows) = table(low_vram);
    let frames = frames.max(1);
    let peak = match windows.iter().position(|&w| frames <= w) {
        Some(i) => at_size(rows, i, megapixels),
        None => {
            let last = windows.len() - 1;
            at_size(rows, last, megapixels) * frames as f64 / windows[last] as f64
        }
    };
    peak * (1.0 + UPLIFT)
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

/// runtime.select_vram_profile's search: the largest window that fits `budget_gb` (a larger low-VRAM window beats a
/// smaller normal one, the normal mode first at the same window); a single-frame low-VRAM window when nothing fits.
/// `low_only` (a TensorRT job): low-VRAM mode only. The table's normal-mode peaks are measured on CUDA only, and
/// with them a 16 GB card's free memory would put HD 48/24 and 4K 8/4 in the normal mode, where TensorRT's peaks
/// are unmeasured; TensorRT keeps the low mode it had before the measured table (row 41) until they are measured.
/// The window is the same as CUDA's (a low-mode peak is never above the normal one at the same window).
pub fn select_vram_profile(shape_hw: (usize, usize), num_frames: usize, budget_gb: f64, low_only: bool) -> Profile {
    let mp = (shape_hw.0 * shape_hw.1) as f64 / 1e6;
    let mut estimate = 0.0;
    for chunk in AUTO_WINDOWS {
        // loop: NOT-WORTH — two modes
        for low in [false, true] {
            if !low && (low_only || !AUTO_NORMAL.contains(&chunk)) {
                continue;
            }
            let p = Profile { chunk, stride: (chunk / 2).max(1), low_vram: low, estimate_gb: estimate_peak_vram_gb(mp, chunk.min(num_frames), low) };
            estimate = p.estimate_gb;
            if p.fits(budget_gb) {
                return p;
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
        "estimate_basis": "onnxruntime-cuda-measured", "margin_scale": MARGIN_SCALE, "margin_gb": MARGIN_GB,
        "windows": window_estimates((meta.shape_h, meta.shape_w), meta.num_frames, windows, budget),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn table_points_and_reading() {
        let up = 1.0 + UPLIFT;
        // a measured size and window: the table's value plus the uplift
        assert!((estimate_peak_vram_gb(1.47456, 48, true) - 8.47 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(8.912896, 8, false) - 11.02 * up).abs() < 1e-12);
        // a window between table windows: the next one up; a normal-mode window below 8: the 8-frame one
        assert!((estimate_peak_vram_gb(1.47456, 50, true) - 9.96 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(1.47456, 4, false) - 5.13 * up).abs() < 1e-12);
        // a size between measured sizes: the next one up (2048x1152 -> 2560x1536); below the smallest: the smallest
        assert!((estimate_peak_vram_gb(2.359296, 8, true) - 5.45 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(0.1, 8, true) - 2.73 * up).abs() < 1e-12);
        // past the largest size and window: proportional
        assert!((estimate_peak_vram_gb(2.0 * 8.912896, 8, true) - 2.0 * 9.87 * up).abs() < 1e-9);
        assert!((estimate_peak_vram_gb(0.786432, 160, true) - 2.0 * 9.20 * up).abs() < 1e-9);
    }

    #[test]
    fn the_table_is_monotone() {
        // loop: NOT-WORTH — two small tables
        for (windows, rows) in [NORMAL, LOW] {
            for r in rows {
                assert_eq!(r.1.len(), windows.len());
                assert!(r.1.windows(2).all(|p| p[0] <= p[1]), "longer window, lower peak at {} MP", r.0);
            }
            for pair in rows.windows(2) {
                assert!(pair[0].0 < pair[1].0);
                assert!(pair[0].1.iter().zip(pair[1].1).all(|(a, b)| a <= b), "larger size, lower peak at {} MP", pair[1].0);
            }
        }
        // and so the estimate, over sizes and frame counts
        // loop: NOT-WORTH — a test's grid
        for low in [false, true] {
            let mut last_size = 0.0;
            for mp in [0.3, 0.786432, 1.0, 1.47456, 2.0, 2.21184, 3.0, 3.93216, 5.0, 6.144, 8.0, 8.912896, 12.0] {
                let e = estimate_peak_vram_gb(mp, 24, low);
                assert!(e >= last_size, "{mp} MP");
                last_size = e;
                let mut last = 0.0;
                for f in 1..=200 {
                    let e = estimate_peak_vram_gb(mp, f, low);
                    assert!(e >= last, "{mp} MP, {f} frames");
                    last = e;
                }
            }
        }
    }

    /// Every measured peak (row 41): (padded h x w, frames per window, low_vram, GiB) — 81 points
    const MEASURED: &[((usize, usize), usize, bool, f64)] = &[
        ((768, 1024), 1, true, 1.9043),
        ((768, 1024), 4, true, 2.6074),
        ((768, 1024), 8, true, 2.7227),
        ((768, 1024), 16, true, 3.2930),
        ((768, 1024), 24, true, 4.3789),
        ((768, 1024), 48, true, 6.7988),
        ((768, 1024), 80, true, 9.1992),
        ((1152, 1280), 1, true, 1.6992),
        ((1152, 1280), 2, true, 3.3672),
        ((1152, 1280), 4, true, 3.5762),
        ((1152, 1280), 8, true, 3.9902),
        ((1152, 1280), 8, true, 3.9902),
        ((1152, 1280), 8, true, 3.9277),
        ((1152, 1280), 8, true, 3.8672),
        ((1152, 1280), 16, true, 4.9453),
        ((1152, 1280), 16, true, 4.9453),
        ((1152, 1280), 16, true, 4.9473),
        ((1152, 1280), 16, true, 4.9531),
        ((1152, 1280), 24, true, 7.0449),
        ((1152, 1280), 24, true, 7.0449),
        ((1152, 1280), 24, true, 7.3789),
        ((1152, 1280), 24, true, 7.0781),
        ((1152, 1280), 24, true, 7.0469),
        ((1152, 1280), 48, true, 8.4668),
        ((1152, 1280), 48, true, 8.3828),
        ((1152, 1280), 48, true, 8.0723),
        ((1152, 1280), 48, true, 8.4238),
        ((1152, 1280), 50, true, 9.4375),
        ((1152, 1280), 56, true, 9.9570),
        ((1152, 1280), 64, true, 10.6426),
        ((1152, 1920), 1, true, 1.8203),
        ((1152, 1920), 2, true, 4.2559),
        ((1152, 1920), 4, true, 4.5020),
        ((1152, 1920), 8, true, 5.1855),
        ((1152, 1920), 16, true, 6.9727),
        ((1152, 1920), 24, true, 9.8262),
        ((1152, 1920), 48, true, 11.3496),
        ((1536, 2560), 1, true, 2.2090),
        ((1536, 2560), 2, true, 2.6543),
        ((1536, 2560), 4, true, 3.5332),
        ((1536, 2560), 8, true, 5.4414),
        ((1536, 2560), 16, true, 8.6719),
        ((1536, 2560), 24, true, 8.6074),
        ((1920, 3200), 1, true, 3.1543),
        ((1920, 3200), 2, true, 3.7227),
        ((1920, 3200), 4, true, 5.9180),
        ((1920, 3200), 8, true, 9.8633),
        ((2176, 4096), 1, true, 4.0996),
        ((2176, 4096), 2, true, 4.4434),
        ((2176, 4096), 4, true, 7.7734),
        ((2176, 4096), 4, true, 7.3789),
        ((2176, 4096), 8, true, 9.1500),
        ((2176, 4096), 8, true, 9.1300),
        ((2176, 4096), 8, true, 9.4180),
        ((2176, 4096), 8, true, 9.2200),
        ((2176, 4096), 8, true, 9.2129),
        ((2176, 4096), 8, true, 9.2900),
        ((768, 1024), 4, false, 4.1719),
        ((768, 1024), 8, false, 4.3652),
        ((768, 1024), 16, false, 4.7461),
        ((768, 1024), 24, false, 5.5449),
        ((768, 1024), 48, false, 7.1016),
        ((768, 1024), 80, false, 7.9902),
        ((1152, 1280), 1, false, 3.8848),
        ((1152, 1280), 4, false, 4.7461),
        ((1152, 1280), 8, false, 5.1270),
        ((1152, 1280), 8, false, 5.1270),
        ((1152, 1280), 16, false, 5.8945),
        ((1152, 1280), 24, false, 7.4512),
        ((1152, 1280), 24, false, 7.4512),
        ((1152, 1280), 48, false, 10.5391),
        ((1152, 1280), 48, false, 10.5391),
        ((1152, 1920), 8, false, 5.8965),
        ((1152, 1920), 16, false, 6.9980),
        ((1152, 1920), 24, false, 9.3008),
        ((1536, 2560), 8, false, 6.0156),
        ((1536, 2560), 16, false, 7.9004),
        ((1536, 2560), 24, false, 10.1387),
        ((1920, 3200), 8, false, 9.3477),
        ((2176, 4096), 8, false, 11.0117),
        ((2176, 4096), 8, false, 11.0117),
    ];
    /// The windows that ran out of memory on the 16 GB card with a 14 GiB budget — 15 points
    const OUT_OF_MEMORY: &[((usize, usize), usize, bool)] = &[
        ((1152, 1280), 80, true),
        ((1152, 1920), 80, true),
        ((1536, 2560), 48, true),
        ((1920, 3200), 16, true),
        ((1920, 3200), 24, true),
        ((1920, 3200), 48, true),
        ((2176, 4096), 16, true),
        ((1152, 1280), 80, false),
        ((1152, 1920), 48, false),
        ((1152, 1920), 80, false),
        ((1536, 2560), 48, false),
        ((1920, 3200), 16, false),
        ((1920, 3200), 24, false),
        ((1920, 3200), 48, false),
        ((2176, 4096), 16, false),
    ];

    #[test]
    fn measured_peaks_are_bounded() {
        let mp = |(h, w): (usize, usize)| (h * w) as f64 / 1e6;
        let mut worst = f64::MAX;
        // loop: NOT-WORTH — the measured points
        for &(shape, frames, low, peak) in MEASURED {
            let e = estimate_peak_vram_gb(mp(shape), frames, low);
            assert!(e >= peak, "{shape:?} {frames} frames low_vram={low}: estimate {e:.3} GiB under the measured {peak:.3}");
            worst = worst.min(e - peak);
        }
        assert!(worst >= 0.1, "the closest point is {worst:.3} GiB over");
        // loop: NOT-WORTH — the points that ran out of memory
        for &(shape, frames, low) in OUT_OF_MEMORY {
            let p = Profile { chunk: frames, stride: (frames / 2).max(1), low_vram: low, estimate_gb: estimate_peak_vram_gb(mp(shape), frames, low) };
            assert!(!p.fits(14.0), "{shape:?} {frames} frames low_vram={low} ran out of memory at a 14 GiB budget");
        }
    }

    #[test]
    fn automatic_windows_for_the_readme_clips_at_12_gib() {
        // the six HD clips and the four 4K plates (padded size, frames) at a 12 GiB budget, as before the measured
        // table except godiva_close, which now gets the normal mode at the same 80/40 window (row 41)
        let cases = [
            ((768, 1024), 349, (80, 40, false)),
            ((1152, 1280), 80, (48, 24, true)),
            ((1152, 1280), 139, (48, 24, true)),
            ((1152, 1280), 250, (48, 24, true)),
            ((1152, 1280), 314, (48, 24, true)),
            ((1152, 1280), 50, (80, 40, true)),
            ((2176, 4096), 120, (8, 4, true)),
        ];
        // loop: NOT-WORTH — seven cases
        for (shape, frames, want) in cases {
            let p = select_vram_profile(shape, frames, 12.0, false);
            assert_eq!((p.chunk, p.stride, p.low_vram), want, "{shape:?} {frames} frames");
        }
    }

    #[test]
    fn tensorrt_keeps_low_memory_mode() {
        // where the measured table puts CUDA in the normal mode (a 16 GB card's ~14.5 GiB free: HD 48/24, 4K 8/4;
        // godiva_close at 12 GiB), a TensorRT job takes the same window in low-VRAM mode (its normal-mode peaks
        // are unmeasured, row 41)
        let cases = [((1152, 1280), 250, 14.5, 48), ((2176, 4096), 120, 14.5, 8), ((768, 1024), 349, 12.0, 80)];
        // loop: NOT-WORTH — three cases
        for (shape, frames, budget, chunk) in cases {
            let cuda = select_vram_profile(shape, frames, budget, false);
            let trt = select_vram_profile(shape, frames, budget, true);
            assert_eq!((cuda.chunk, cuda.stride, cuda.low_vram), (chunk, chunk / 2, false), "CUDA {shape:?} {frames} frames");
            assert_eq!((trt.chunk, trt.stride, trt.low_vram), (chunk, chunk / 2, true), "TensorRT {shape:?} {frames} frames");
            assert!(trt.fits(budget));
        }
        // nothing fits: the single-frame low window either way
        assert_eq!(select_vram_profile((1152, 1920), 240, 1.0, true), select_vram_profile((1152, 1920), 240, 1.0, false));
    }

    #[test]
    fn selection_prefers_long_windows() {
        let p = select_vram_profile((1152, 1920), 240, 15.0, false);
        assert!(p.fits(15.0));
        let tiny = select_vram_profile((1152, 1920), 240, 1.0, false);
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
        let auto = select_vram_profile(shape, 240, 15.0, false);
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
