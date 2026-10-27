//! Peak graphics memory per Hann window, measured for this engine on ONNX Runtime (CUDA), and the automatic window
//! chosen from it (runtime.select_vram_profile's search with this engine's numbers).
//!
//! The table is the measured peak (GiB: nvidia-smi over the engine's process tree, tools/engine_bench.mjs; RTX 5080,
//! ONNX Runtime 1.31 CUDA, docs/BACKLOG.md row 41) on model set 2.0.0-onnx.4, the set the app ships (measured
//! 2026-10-26, engine 1afed1c: 69 points ran, 16 ran out of memory), per padded model-input size (megapixels:
//! 960x720, 1280x1080, 1920x1080, 2560x1440, 3200x1800, 4096x2160) and window length, the highest of the clips and
//! runs at each point, rounded up to 0.01 GiB, then made monotone (never lower for a longer window or a larger size).
//! A window not measured at a size takes the next measured window's peak; past the largest one that ran, it is
//! proportional to the window (from the highest peak measured at that size up to that window), and at least 14 GiB
//! where the 16 GB card ran out of memory (those runs had a 14 GiB budget). One exception: 960x720 low-VRAM at 8, 16
//! and 24 frames, measured on onnx.3 (2.73 / 3.30 / 4.38) but not on onnx.4, whose measured neighbours there rose up
//! to 26 % (48 frames 6.80 -> 8.43, 80 frames 9.20 -> 11.58), so onnx.3's values are no longer shown to be a bound;
//! they take 1280x1080's measured onnx.4 peaks at the same windows (3.95 / 5.51 / 8.04, 45-84 % above onnx.3's), the
//! reading for an unmeasured size, rather than the next measured window's 8.43, which the size rule would have
//! carried into 1280x1080's short windows. The onnx.3 table (2026-10-24) was under onnx.4's measured peaks at 31 of
//! 69 points, up to 16 %, and let the automatic window pick 1920x1080 48/24 low-VRAM, which runs out of memory on
//! onnx.4. The first measured table replaced the upstream runtime's PyTorch table, which was up to 32 % under real
//! peaks and 73 % over.
//!
//! Read so that it stays an upper bound (estimate_peak_vram_gb):
//! - window: the next table window at or above (the peak never falls as the window grows); past the largest,
//!   proportional to the window;
//! - size: the next measured size at or above; below the smallest, the smallest's; above the largest, proportional
//!   to the megapixels;
//! - then UPLIFT on top: the largest spread between clips and runs at one point (5.3 % on onnx.3, 2.8 % on onnx.4;
//!   kept at onnx.3's), rounded up.
//!
//! Where memory is tight a job peaks lower (TIGHT_*): an RTX 2070 SUPER 8 GB (2026-10-27, onnx.4, engines 1e7cf76
//! and fc927ec, 7.0 / 7.4 GiB budgets, 68 runs) peaked up to 2.7 GiB under the 16 GB card's table at the same points
//! (at 1280x1080 low-VRAM 16/8 0.14 GiB over it, inside the uplift), and at 1280x1080 low-VRAM 24/12 (5.34 GiB) under
//! its own 16/8 (5.65 GiB), so it is not a fixed per-card offset.
//! What makes the difference (cuDNN's workspace, ONNX Runtime's arenas, the architecture) is not measured. The
//! TIGHT rows are those runs' highest peak per point, rounded up to 0.01 GiB and made monotone, at 960x720, 1280x1080
//! and 1920x1080; every cell they didn't measure is the table's (1920x1080 16/8 low-VRAM too: it ran at 5.45 GiB but
//! took 394 s for 32 frames, 8x its 8/4's time per frame, so it doesn't count as fitting); 960x720 low-VRAM 2/1 and
//! 8/4-24/12 take 1280x1080's (the size rule above). The estimate is the table's peak, but no more than the budget
//! lets a window peak (Profile::fits) as long as the TIGHT peak fits it, else the TIGHT peak: a window fits a budget
//! when its TIGHT peak does. That rests on a job that ran within 7.4 GiB running within any larger budget (more
//! memory free) and within a smaller one its TIGHT peak plus the margin fits (less free): an assumption, not measured
//! below 7.0 GiB. The margin is Profile::fits' (x 1.1 + 0.3 GiB on top of the +6 % uplift): a window needs at least
//! its highest measured peak + 16.6 % + 0.3 GiB of budget.
//!
//! Every measured peak is in the tests (`measured_peaks_are_bounded`). Between the measured sizes the bound rests on
//! the peak growing with the size, which the measurements break at single points (cuDNN picks its algorithms per
//! shape: 1920x1080 at window 2 or 4 peaks higher than 2560x1440, 3200x1800 at 8 low-VRAM 2.5 GiB higher than
//! 4096x2160, which the 4096x2160 row therefore carries): an unmeasured size can be over the estimate.

/// (window lengths, rows of (megapixels, peak GiB per window length)) for low_vram false / true.
type Table = (&'static [usize], &'static [(f64, &'static [f64])]);

const NORMAL: Table = (
    &[8, 16, 24, 48, 80],
    &[
        (0.786432, &[4.54, 5.09, 6.06, 8.12, 9.84]),
        (1.47456, &[5.33, 6.29, 8.05, 11.73, 19.54]),
        (2.21184, &[6.17, 7.57, 10.16, 20.31, 33.84]),
        (3.93216, &[6.44, 9.34, 12.24, 24.47, 40.79]),
        (6.144, &[10.23, 20.45, 30.68, 61.35, 102.25]),
        (8.912896, &[10.83, 21.65, 32.47, 64.93, 108.21]),
    ],
);
const LOW: Table = (
    &[1, 2, 4, 8, 16, 24, 48, 56, 64, 80],
    &[
        (0.786432, &[1.92, 2.61, 2.61, 3.95, 5.51, 8.04, 8.43, 11.59, 11.59, 11.59]),
        (1.47456, &[1.92, 3.37, 3.57, 3.95, 5.51, 8.04, 9.07, 11.59, 11.59, 14.31]),
        (2.21184, &[1.93, 4.29, 4.48, 5.15, 7.81, 11.08, 22.15, 25.84, 29.53, 36.91]),
        (3.93216, &[2.18, 4.29, 4.48, 6.34, 10.61, 11.08, 22.15, 25.84, 29.53, 36.91]),
        (6.144, &[3.29, 4.29, 5.98, 11.80, 23.59, 35.39, 70.77, 82.57, 94.36, 117.95]),
        (8.912896, &[4.25, 4.61, 7.80, 11.80, 23.59, 35.39, 70.77, 82.57, 94.36, 117.95]),
    ],
);
/// The peaks where memory is tight (the module header): the 8 GB card's, the table's where it didn't measure; up to
/// 1920x1080, the table's above.
const TIGHT_NORMAL: Table = (
    &[8, 16, 24, 48, 80],
    &[(0.786432, &[3.54, 4.38, 5.39, 8.12, 9.84]), (1.47456, &[4.03, 5.31, 8.05, 11.73, 19.54]), (2.21184, &[4.93, 7.57, 10.16, 20.31, 33.84])],
);
const TIGHT_LOW: Table = (
    &[1, 2, 4, 8, 16, 24, 48, 56, 64, 80],
    &[
        (0.786432, &[1.39, 1.75, 1.78, 3.18, 5.66, 5.66, 8.43, 11.59, 11.59, 11.59]),
        (1.47456, &[1.51, 1.75, 2.27, 3.18, 5.66, 5.66, 9.07, 11.59, 11.59, 14.31]),
        (2.21184, &[1.59, 2.08, 2.91, 4.44, 7.81, 11.08, 22.15, 25.84, 29.53, 36.91]),
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

/// `table`'s peak at `megapixels` and `frames` per window, read upward (the module header).
fn read((windows, rows): Table, megapixels: f64, frames: usize) -> f64 {
    let frames = frames.max(1);
    match windows.iter().position(|&w| frames <= w) {
        Some(i) => at_size(rows, i, megapixels),
        None => {
            let last = windows.len() - 1;
            at_size(rows, last, megapixels) * frames as f64 / windows[last] as f64
        }
    }
}

/// The most a window may peak at to fit `budget_gb` (Profile::fits).
fn max_peak(budget_gb: f64) -> f64 {
    (budget_gb - MARGIN_GB) / MARGIN_SCALE
}

/// The peak graphics memory (GiB) of a job whose model input is `megapixels` (the padded size) with `frames` frames
/// per window (the window, capped at the clip's frames), with `budget_gb` for the job (None: no reading, the table's
/// peak): an upper bound (the module header). One function for the automatic window, the `memory` reply and the
/// `estimate` command.
pub fn estimate_peak_vram_gb(megapixels: f64, frames: usize, low_vram: bool, budget_gb: Option<f64>) -> f64 {
    let (roomy, tight) = if low_vram { (LOW, TIGHT_LOW) } else { (NORMAL, TIGHT_NORMAL) };
    let table = read(roomy, megapixels, frames);
    let tight = if megapixels <= tight.1[tight.1.len() - 1].0 { read(tight, megapixels, frames) } else { table };
    let (tight, table) = (tight * (1.0 + UPLIFT), table.max(tight) * (1.0 + UPLIFT));
    let cap = budget_gb.map_or(f64::INFINITY, max_peak);
    if tight <= cap {
        table.min(cap)
    } else {
        tight
    }
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
        // the same expression as the estimate's cap, so a window estimated at the cap fits
        self.estimate_gb <= max_peak(budget_gb)
    }
}

/// runtime.select_vram_profile's search: the largest window that fits `budget_gb` (a larger low-VRAM window beats a
/// smaller normal one, the normal mode first at the same window); a single-frame low-VRAM window when nothing fits.
/// `low_only` (a TensorRT job): low-VRAM mode only. The table's normal-mode peaks are measured on CUDA only, and
/// with them a 16 GB card's free memory would put HD 48/24 and 4K 8/4 in the normal mode, where TensorRT's peaks
/// are unmeasured; TensorRT keeps the low mode it had before the measured table (row 41) until they are measured.
/// The window is CUDA's, or shorter where the low mode's measured peak is above the normal one's (onnx.4: 960x720 at
/// 80 frames).
pub fn select_vram_profile(shape_hw: (usize, usize), num_frames: usize, budget_gb: f64, low_only: bool) -> Profile {
    let mp = (shape_hw.0 * shape_hw.1) as f64 / 1e6;
    let mut estimate = 0.0;
    for chunk in AUTO_WINDOWS {
        // loop: NOT-WORTH — two modes
        for low in [false, true] {
            if !low && (low_only || !AUTO_NORMAL.contains(&chunk)) {
                continue;
            }
            let p = Profile {
                chunk,
                stride: (chunk / 2).max(1),
                low_vram: low,
                estimate_gb: estimate_peak_vram_gb(mp, chunk.min(num_frames), low, Some(budget_gb)),
            };
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
            let p = Profile { chunk, stride, low_vram: low, estimate_gb: estimate_peak_vram_gb(mp, frames, low, budget.map(|b| b as f64 / GIB)) };
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
pub fn estimate(
    input: &str,
    num_frames: i64,
    model_scale: f64,
    windows: &[Window],
    mem: Option<CardMemory>,
    cap_gb: Option<f64>,
) -> Result<serde_json::Value, crate::Error> {
    let meta = crate::clip::probe_size(std::path::Path::new(input), num_frames, model_scale)?;
    let budget = mem.map(|m| match cap_gb {
        Some(cap) if m.source == "gpu" => m.budget.min((cap * GIB) as u64),
        _ => m.budget,
    });
    Ok(serde_json::json!({
        "type": "estimate",
        "width": meta.w, "height": meta.h, "model_scale": meta.model_scale, "model_w": meta.model_w, "model_h": meta.model_h, "shape_w": meta.shape_w, "shape_h": meta.shape_h, "frames": meta.num_frames,
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
        assert!((estimate_peak_vram_gb(1.47456, 48, true, None) - 9.07 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(8.912896, 8, false, None) - 10.83 * up).abs() < 1e-12);
        // a window between table windows: the next one up; a normal-mode window below 8: the 8-frame one
        assert!((estimate_peak_vram_gb(1.47456, 50, true, None) - 11.59 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(1.47456, 4, false, None) - 5.33 * up).abs() < 1e-12);
        // a size between measured sizes: the next one up (2048x1152 -> 2560x1536); below the smallest: the smallest
        assert!((estimate_peak_vram_gb(2.359296, 8, true, None) - 6.34 * up).abs() < 1e-12);
        assert!((estimate_peak_vram_gb(0.1, 8, true, None) - 3.95 * up).abs() < 1e-12);
        // past the largest size and window: proportional
        assert!((estimate_peak_vram_gb(2.0 * 8.912896, 8, true, None) - 2.0 * 11.80 * up).abs() < 1e-9);
        assert!((estimate_peak_vram_gb(0.786432, 160, true, None) - 2.0 * 11.59 * up).abs() < 1e-9);
    }

    #[test]
    fn the_table_is_monotone() {
        // loop: NOT-WORTH — four small tables
        for (windows, rows) in [NORMAL, LOW, TIGHT_NORMAL, TIGHT_LOW] {
            for r in rows {
                assert_eq!(r.1.len(), windows.len());
                assert!(r.1.windows(2).all(|p| p[0] <= p[1]), "longer window, lower peak at {} MP", r.0);
            }
            for pair in rows.windows(2) {
                assert!(pair[0].0 < pair[1].0);
                assert!(pair[0].1.iter().zip(pair[1].1).all(|(a, b)| a <= b), "larger size, lower peak at {} MP", pair[1].0);
            }
        }
        // and so the estimate, over sizes and frame counts, at any one budget
        // loop: NOT-WORTH — a test's grid
        for budget in [None, Some(4.0), Some(5.5), Some(7.0), Some(7.4), Some(9.3), Some(11.2), Some(14.5)] {
            for low in [false, true] {
                let mut last_size = 0.0;
                for mp in [0.3, 0.786432, 1.0, 1.47456, 2.0, 2.21184, 3.0, 3.93216, 5.0, 6.144, 8.0, 8.912896, 12.0] {
                    let e = estimate_peak_vram_gb(mp, 24, low, budget);
                    assert!(e >= last_size, "{mp} MP at {budget:?}");
                    last_size = e;
                    let mut last = 0.0;
                    for f in 1..=200 {
                        let e = estimate_peak_vram_gb(mp, f, low, budget);
                        assert!(e >= last, "{mp} MP, {f} frames at {budget:?}");
                        last = e;
                    }
                }
            }
        }
    }

    /// Every measured peak on model set onnx.4 (2026-10-26, row 41): (padded h x w, frames per window, low_vram,
    /// GiB) — 69 points
    const MEASURED: &[((usize, usize), usize, bool, f64)] = &[
        ((768, 1024), 1, true, 1.9121),
        ((768, 1024), 4, true, 2.6035),
        ((768, 1024), 48, true, 8.4277),
        ((768, 1024), 80, true, 11.5840),
        ((1152, 1280), 1, true, 1.5918),
        ((1152, 1280), 2, true, 3.3633),
        ((1152, 1280), 4, true, 3.5605),
        ((1152, 1280), 8, true, 3.9473),
        ((1152, 1280), 16, true, 5.5059),
        ((1152, 1280), 24, true, 8.0371),
        ((1152, 1280), 24, true, 7.8984),
        ((1152, 1280), 24, true, 7.8887),
        ((1152, 1280), 48, true, 9.0684),
        ((1152, 1280), 48, true, 9.0684),
        ((1152, 1280), 48, true, 8.8203),
        ((1152, 1280), 48, true, 9.0684),
        ((1152, 1280), 50, true, 10.0566),
        ((1152, 1280), 56, true, 10.6582),
        ((1152, 1280), 64, true, 11.4434),
        ((1152, 1920), 1, true, 1.9219),
        ((1152, 1920), 2, true, 4.2852),
        ((1152, 1920), 4, true, 4.4785),
        ((1152, 1920), 8, true, 5.1406),
        ((1152, 1920), 16, true, 7.8047),
        ((1152, 1920), 24, true, 11.0723),
        ((1536, 2560), 1, true, 2.1777),
        ((1536, 2560), 2, true, 2.8965),
        ((1536, 2560), 4, true, 3.7715),
        ((1536, 2560), 8, true, 6.3359),
        ((1536, 2560), 16, true, 10.6074),
        ((1536, 2560), 24, true, 9.4102),
        ((1920, 3200), 1, true, 3.2852),
        ((1920, 3200), 2, true, 3.7656),
        ((1920, 3200), 4, true, 5.9746),
        ((1920, 3200), 8, true, 11.7949),
        ((2176, 4096), 1, true, 4.2402),
        ((2176, 4096), 2, true, 4.6055),
        ((2176, 4096), 4, true, 7.7969),
        ((2176, 4096), 4, true, 7.7266),
        ((2176, 4096), 8, true, 9.2910),
        ((2176, 4096), 8, true, 9.2910),
        ((2176, 4096), 8, true, 9.2910),
        ((2176, 4096), 8, true, 9.2910),
        ((2176, 4096), 8, true, 9.2891),
        ((2176, 4096), 8, true, 9.2891),
        ((768, 1024), 4, false, 4.2598),
        ((768, 1024), 8, false, 4.5352),
        ((768, 1024), 16, false, 5.0820),
        ((768, 1024), 24, false, 6.0527),
        ((768, 1024), 48, false, 8.1172),
        ((768, 1024), 80, false, 9.8359),
        ((1152, 1280), 1, false, 3.9043),
        ((1152, 1280), 4, false, 4.8535),
        ((1152, 1280), 8, false, 5.3242),
        ((1152, 1280), 8, false, 5.3242),
        ((1152, 1280), 16, false, 6.2871),
        ((1152, 1280), 24, false, 8.0410),
        ((1152, 1280), 24, false, 8.0410),
        ((1152, 1280), 48, false, 11.7207),
        ((1152, 1280), 48, false, 11.7207),
        ((1152, 1920), 8, false, 6.1602),
        ((1152, 1920), 16, false, 7.5625),
        ((1152, 1920), 24, false, 10.1504),
        ((1536, 2560), 8, false, 6.4375),
        ((1536, 2560), 16, false, 9.3359),
        ((1536, 2560), 24, false, 12.2344),
        ((1920, 3200), 8, false, 10.2246),
        ((2176, 4096), 8, false, 10.8203),
        ((2176, 4096), 8, false, 10.8203),
    ];
    /// The windows that ran out of memory on the 16 GB card with a 14 GiB budget (onnx.4) — 16 points
    const OUT_OF_MEMORY: &[((usize, usize), usize, bool)] = &[
        ((1152, 1280), 80, true),
        ((1152, 1920), 48, true),
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
            // at the budget the runs had, and with no reading
            for budget in [Some(14.0), None] {
                let e = estimate_peak_vram_gb(mp(shape), frames, low, budget);
                assert!(e >= peak, "{shape:?} {frames} frames low_vram={low}: estimate {e:.3} GiB under the measured {peak:.3}");
                worst = worst.min(e - peak);
            }
        }
        assert!(worst >= 0.1, "the closest point is {worst:.3} GiB over");
        // loop: NOT-WORTH — the points that ran out of memory
        for &(shape, frames, low) in OUT_OF_MEMORY {
            let p =
                Profile { chunk: frames, stride: (frames / 2).max(1), low_vram: low, estimate_gb: estimate_peak_vram_gb(mp(shape), frames, low, Some(14.0)) };
            assert!(!p.fits(14.0), "{shape:?} {frames} frames low_vram={low} ran out of memory at a 14 GiB budget");
        }
    }

    /// Every peak measured on the RTX 2070 SUPER 8 GB (2026-10-27, onnx.4, 7.0 / 7.4 GiB budgets and three 14 GiB
    /// runs; the highest per point): (padded h x w, frames per window, low_vram, GiB) — 23 points
    const MEASURED_8GB: &[((usize, usize), usize, bool, f64)] = &[
        ((768, 1024), 1, true, 1.3887),
        ((768, 1024), 4, true, 1.7734),
        ((768, 1024), 4, false, 3.2500),
        ((768, 1024), 8, false, 3.5391),
        ((768, 1024), 16, false, 4.3750),
        ((768, 1024), 24, false, 5.3867),
        ((1152, 1280), 1, true, 1.5020),
        ((1152, 1280), 2, true, 1.7402),
        ((1152, 1280), 4, true, 2.2617),
        ((1152, 1280), 8, true, 3.1777),
        ((1152, 1280), 16, true, 5.6523),
        ((1152, 1280), 24, true, 5.3438),
        ((1152, 1280), 1, false, 3.1543),
        ((1152, 1280), 4, false, 3.5117),
        ((1152, 1280), 8, false, 4.0215),
        ((1152, 1280), 16, false, 5.3047),
        ((1152, 1920), 1, true, 1.5840),
        ((1152, 1920), 2, true, 2.0723),
        ((1152, 1920), 4, true, 2.9023),
        ((1152, 1920), 8, true, 4.4336),
        ((1152, 1920), 8, false, 4.9219),
        ((1536, 2560), 1, true, 1.8945),
        ((1920, 3200), 1, true, 2.9785),
    ];
    /// On the 8 GB card at a 7.4 GiB budget: out of memory, and 1920x1080 16/8 low-VRAM, which ran at 5.45 GiB but
    /// took 394 s for 32 frames (8x its 8/4's time per frame), so it doesn't count as fitting
    const DID_NOT_FIT_8GB: &[((usize, usize), usize, bool)] =
        &[((768, 1024), 48, false), ((1152, 1280), 24, false), ((1152, 1920), 16, false), ((1152, 1920), 16, true)];

    #[test]
    fn the_8_gb_cards_peaks_are_bounded_at_any_budget() {
        let mp = |(h, w): (usize, usize)| (h * w) as f64 / 1e6;
        // loop: NOT-WORTH — the measured points x a few budgets
        for &(shape, frames, low, peak) in MEASURED_8GB {
            for budget in [None, Some(4.0), Some(5.5), Some(7.0), Some(7.4), Some(9.3), Some(14.5)] {
                let e = estimate_peak_vram_gb(mp(shape), frames, low, budget);
                assert!(e >= peak, "{shape:?} {frames} frames low_vram={low} at {budget:?}: estimate {e:.3} GiB under the measured {peak:.3}");
            }
            // the margin: a window fits only a budget at least 0.3 GiB over its measured peak
            let need = estimate_peak_vram_gb(mp(shape), frames, low, Some(0.0)) * MARGIN_SCALE + MARGIN_GB;
            assert!(need >= peak + 0.3, "{shape:?} {frames} frames low_vram={low}: needs {need:.3} GiB, measured {peak:.3}");
        }
        // loop: NOT-WORTH — four points
        for &(shape, frames, low) in DID_NOT_FIT_8GB {
            let p = Profile { chunk: frames, stride: frames / 2, low_vram: low, estimate_gb: estimate_peak_vram_gb(mp(shape), frames, low, Some(7.4)) };
            assert!(!p.fits(7.4), "{shape:?} {frames} frames low_vram={low} didn't fit 7.4 GiB on the 8 GB card");
        }
    }

    #[test]
    fn an_8_gb_card_gets_the_window_it_ran() {
        // the 8 GB card's free memory (7.4 GiB measured; 7.0 with more of the desktop on the card): 1280x1080 runs
        // 24/12 low-VRAM (measured 5.34 GiB at 7.4; the table's 8.04 put it at 8/4), 1920x1080 8/4 normal (measured
        // 4.92; the table's 6.17 put it in low-VRAM mode); 1920x1080 16/8 low-VRAM starved and 24/12 is unmeasured
        // loop: NOT-WORTH — four cases
        for (budget, shape, want) in
            [(7.4, (1152, 1280), (24, 12, true)), (7.0, (1152, 1280), (24, 12, true)), (7.4, (1152, 1920), (8, 4, false)), (7.0, (1152, 1920), (8, 4, false))]
        {
            let p = select_vram_profile(shape, 240, budget, false);
            assert_eq!((p.chunk, p.stride, p.low_vram), want, "{shape:?} at {budget} GiB");
            assert!(p.fits(budget));
            let peak = MEASURED_8GB.iter().filter(|m| m.0 == shape && m.1 == p.chunk && m.2 == p.low_vram).map(|m| m.3).fold(f64::NAN, f64::max);
            assert!(peak + 0.3 <= budget, "{shape:?}: measured {peak} GiB (NaN: not measured)");
        }
    }

    #[test]
    fn larger_cards_keep_their_windows() {
        // 12 and 16 GB cards (11.2 / 12 / 14.5 GiB free): the windows the 16 GB card's table picked, unchanged
        // (the 8 GB card's rows only lower windows the table already fit there)
        let cases = [
            (11.2, (1152, 1280), (48, 24, true)),
            (11.2, (1152, 1920), (8, 4, false)),
            (11.2, (2176, 4096), (4, 2, true)),
            (12.0, (768, 1024), (80, 40, false)),
            (14.5, (768, 1024), (80, 40, false)),
            (14.5, (1152, 1280), (48, 24, false)),
            (14.5, (1152, 1920), (24, 12, false)),
            (14.5, (2176, 4096), (8, 4, false)),
        ];
        // loop: NOT-WORTH — eight cases
        for (budget, shape, want) in cases {
            let p = select_vram_profile(shape, 240, budget, false);
            assert_eq!((p.chunk, p.stride, p.low_vram), want, "{shape:?} at {budget} GiB");
        }
    }

    #[test]
    fn a_16_gb_card_gets_a_measured_1080p_window() {
        // a 1920x1080 clip with a 16 GB card's ~14.5 GiB free: 48/24 low ran out of memory on onnx.4 at a 14 GiB
        // budget, so the automatic window is one that ran, with its measured peak inside the budget
        let shape = (1152, 1920);
        let p = select_vram_profile(shape, 240, 14.5, false);
        assert!(!OUT_OF_MEMORY.contains(&(shape, p.chunk, p.low_vram)), "{p:?} ran out of memory");
        let peak = MEASURED.iter().filter(|m| m.0 == shape && m.1 == p.chunk && m.2 == p.low_vram).map(|m| m.3).fold(f64::NAN, f64::max);
        assert!(peak <= 14.5, "{p:?}: measured peak {peak} GiB (NaN: not measured)");
    }

    #[test]
    fn automatic_windows_for_the_readme_clips_at_12_gib() {
        // the six HD clips and the four 4K plates (padded size, frames) at a 12 GiB budget, as before the measured
        // table except godiva_close, which now gets the normal mode at the same 80/40 window (row 41); on the onnx.4
        // table with_motion_blur (50 frames, the 56-frame column) takes 48/24 and 4K 4/2 (its 8/4 low column is
        // 3200x1800's 11.80 GiB: the table never falls for a larger size)
        let cases = [
            ((768, 1024), 349, (80, 40, false)),
            ((1152, 1280), 80, (48, 24, true)),
            ((1152, 1280), 139, (48, 24, true)),
            ((1152, 1280), 250, (48, 24, true)),
            ((1152, 1280), 314, (48, 24, true)),
            ((1152, 1280), 50, (48, 24, true)),
            ((2176, 4096), 120, (4, 2, true)),
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
        // are unmeasured, row 41), or a shorter one where the low mode's measured peak is higher (onnx.4: 960x720
        // at 80 frames, 11.58 GiB low vs 9.84 normal)
        let cases = [((1152, 1280), 250, 14.5, 48, 48), ((2176, 4096), 120, 14.5, 8, 8), ((768, 1024), 349, 12.0, 80, 48)];
        // loop: NOT-WORTH — three cases
        for (shape, frames, budget, chunk, trt_chunk) in cases {
            let cuda = select_vram_profile(shape, frames, budget, false);
            let trt = select_vram_profile(shape, frames, budget, true);
            assert_eq!((cuda.chunk, cuda.stride, cuda.low_vram), (chunk, chunk / 2, false), "CUDA {shape:?} {frames} frames");
            assert_eq!((trt.chunk, trt.stride, trt.low_vram), (trt_chunk, trt_chunk / 2, true), "TensorRT {shape:?} {frames} frames");
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
        assert!((peak(0) - estimate_peak_vram_gb(mp, 24, false, Some(15.0))).abs() < 1e-6);
        assert!((peak(1) - estimate_peak_vram_gb(mp, 48, true, Some(15.0))).abs() < 1e-6);
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
        let r = estimate(dir.to_str().unwrap(), -1, 1.0, &[(8, 4, false)], Some(mem), Some(10.0)).unwrap();
        let size = (r["width"].as_u64(), r["height"].as_u64(), r["shape_w"].as_u64(), r["shape_h"].as_u64(), r["frames"].as_u64());
        assert_eq!(size, (Some(200), Some(130), Some(256), Some(256), Some(3)));
        assert_eq!(r["budget_bytes"].as_u64(), Some(10 << 30), "the cap wins over the free memory");
        assert_eq!((r["total_bytes"].as_u64(), r["free_bytes"].as_u64()), (Some(16 << 30), Some(12 << 30)));
        assert_eq!(r["windows"][0]["frames"], json!(3));
        let r2 = estimate(dir.to_str().unwrap(), 2, 1.0, &[(8, 4, false)], None, None).unwrap();
        assert_eq!((r2["frames"].as_u64(), r2["total_bytes"].clone(), r2["windows"][0]["fits"].clone()), (Some(2), Value::Null, Value::Null));
        // model scale (backlog row 42): the estimate is the scaled, padded size's (200x130 at 2.0 -> 400x260 -> 512x384)
        let r3 = estimate(dir.to_str().unwrap(), -1, 2.0, &[(8, 4, false)], None, None).unwrap();
        let s3 = (r3["width"].as_u64(), r3["model_w"].as_u64(), r3["model_h"].as_u64(), r3["shape_w"].as_u64(), r3["shape_h"].as_u64());
        assert_eq!(s3, (Some(200), Some(400), Some(260), Some(512), Some(384)));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(estimate("/no/such/clip.mov", -1, 1.0, &[(8, 4, false)], None, None).unwrap_err().code.as_str(), "input");
    }
}
