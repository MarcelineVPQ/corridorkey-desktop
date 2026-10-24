//! Stage 1 runs on overlapping temporal windows ("Hann windows"): video_io.window_starts / taper_weights and
//! the runtime's blend of each window's hidden state ("baton") into one per frame (hann_stage1_stream).
use crate::color::ToF32;
use std::collections::BTreeMap;

/// video_io.window_starts: windows of `chunk` frames every `stride`, the last one ending at the clip's end.
pub fn window_starts(t_all: usize, chunk: usize, stride: usize) -> Vec<usize> {
    if t_all <= chunk {
        return vec![0];
    }
    // loop: NOT-WORTH — window starts, once per job (≤ a few hundred)
    let mut starts: Vec<usize> = (0..=t_all - chunk).step_by(stride.max(1)).collect();
    if *starts.last().unwrap() != t_all - chunk {
        starts.push(t_all - chunk);
    }
    starts
}

/// video_io.taper_weights: 1 inside, a raised-cosine ramp over `overlap` frames at the ends that overlap a
/// neighbouring window (float32, as torch computes it).
pub fn taper_weights(tc: usize, overlap: usize, is_first: bool, is_last: bool) -> Vec<f32> {
    let mut w = vec![1.0f32; tc];
    if overlap == 0 || tc <= 1 {
        return w;
    }
    let n = overlap.min(tc);
    let pi = std::f64::consts::PI as f32;
    // loop: NOT-WORTH — ≤ 40 ramp weights, once per window
    let ramp: Vec<f32> = (0..n).map(|k| 0.5 * (1.0 - (pi * (k as f32 + 1.0) / (overlap as f32 + 1.0)).cos())).collect();
    if !is_first {
        w[..n].copy_from_slice(&ramp);
    }
    if !is_last {
        // loop: NOT-WORTH — ≤ 40 weights, once per window
        w[tc - n..].iter_mut().zip(ramp.iter().rev()).for_each(|(d, &r)| *d = r);
    }
    w
}

/// The weighted running sum of the batons per frame (live_acc / live_w): frames are released, as float16,
/// once no later window covers them.
#[derive(Default)]
pub(crate) struct BatonBlend {
    acc: BTreeMap<usize, (Vec<f32>, f64)>,
}

impl BatonBlend {
    /// Add frame `t`'s baton from one window with weight `w` (weighted = baton * w in float32). The baton is
    /// read in the type stage 1 made it (float16 or float32), converted value by value (exact).
    pub(crate) fn add<T: ToF32>(&mut self, t: usize, baton: &[T], w: f32) {
        use rayon::prelude::*;
        match self.acc.get_mut(&t) {
            Some((sum, wsum)) => {
                // loop: HOT-PATH-OK — one baton frame (2.9 M values at 1152x1280), parallel; reads stage 1's float16 directly (this pass: no float32 copy of the window's batons)
                sum.par_iter_mut().zip(baton.par_iter()).with_min_len(1 << 14).for_each(|(s, b)| *s += b.to_f32() * w);
                *wsum += w as f64;
            }
            None => {
                // loop: HOT-PATH-OK — first window covering a frame: its weighted baton is the accumulator (one allocation per frame, kept until the frame is final)
                self.acc.insert(t, (baton.par_iter().with_min_len(1 << 14).map(|b| b.to_f32() * w).collect(), w as f64));
            }
        }
    }

    /// Every frame before `t_limit`, in order: (t, acc / max(wsum, 1e-6) as float16, the runtime's memmap type).
    pub(crate) fn flush_before(&mut self, t_limit: usize) -> Vec<(usize, Vec<half::f16>)> {
        let keys: Vec<usize> = self.acc.range(..t_limit).map(|(k, _)| *k).collect();
        // loop: HOT-PATH-OK — the frames a window finishes (≤ stride); each frame's values in parallel
        keys.into_iter()
            .map(|k| {
                let (sum, wsum) = self.acc.remove(&k).unwrap();
                let d = wsum.max(1e-6) as f32;
                use rayon::prelude::*;
                // loop: HOT-PATH-OK — frames a window finishes (≤ stride), each frame parallel; output float16 (this pass: was float32 then rounded again)
                (k, sum.into_par_iter().with_min_len(1 << 14).map(|v| half::f16::from_f32(v / d)).collect())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_cover_the_clip() {
        assert_eq!(window_starts(8, 4, 2), vec![0, 2, 4]);
        assert_eq!(window_starts(9, 4, 2), vec![0, 2, 4, 5]);
        assert_eq!(window_starts(3, 4, 2), vec![0]);
        assert_eq!(window_starts(240, 80, 40), vec![0, 40, 80, 120, 160]);
        assert_eq!(window_starts(5, 1, 1), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn weights_sum_to_one_across_an_overlap() {
        let a = taper_weights(4, 2, true, false);
        let b = taper_weights(4, 2, false, true);
        assert_eq!(a[0], 1.0);
        assert!((a[2] + b[0] - 1.0).abs() < 1e-6 && (a[3] + b[1] - 1.0).abs() < 1e-6);
        assert_eq!(taper_weights(4, 0, false, false), vec![1.0; 4]);
    }

    #[test]
    fn blend_releases_in_order() {
        let mut b = BatonBlend::default();
        b.add(1, &[2.0f32], 0.5);
        b.add(0, &[1.0f32], 1.0);
        b.add(1, &[half::f16::from_f32(4.0)], 0.5);
        let out = b.flush_before(2);
        let h = |v: f32| vec![half::f16::from_f32(v)];
        assert_eq!(out, vec![(0, h(1.0)), (1, h(3.0))]);
        assert!(b.acc.is_empty());
    }
}
