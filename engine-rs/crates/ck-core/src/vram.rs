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
pub const MARGIN_SCALE: f64 = 1.1;
pub const MARGIN_GB: f64 = 0.3;

fn table(low_vram: bool) -> Table {
    if low_vram {
        LOW
    } else {
        NORMAL
    }
}

/// runtime._interp: piecewise-linear through the points, extrapolating past both ends.
fn interp(x: f64, points: &[(f64, f64)]) -> f64 {
    // loop: NOT-WORTH — at most seven points
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
    pub fn fits(&self, budget_gb: f64) -> bool {
        self.estimate_gb * MARGIN_SCALE + MARGIN_GB <= budget_gb
    }
}

/// runtime.select_vram_profile: the largest window that fits `budget_gb` (a larger low-VRAM window beats a
/// smaller normal one); a single-frame low-VRAM window when nothing fits.
pub fn select_vram_profile(shape_hw: (usize, usize), num_frames: usize, budget_gb: f64) -> Profile {
    let mp = (shape_hw.0 * shape_hw.1) as f64 / 1e6;
    let mut estimate = 0.0;
    // loop: NOT-WORTH — seven window lengths x two modes
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
