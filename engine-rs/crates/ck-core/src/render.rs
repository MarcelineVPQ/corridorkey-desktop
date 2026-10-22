//! Stage-2 logits -> the output frames (runtime._render_predictions_torch for video,
//! _render_predictions_exr_torch for EXR): crop the padding, alpha clamped, fg decoded from asinh to linear,
//! despill, the checker composite, the cutout.
use crate::color::{asinh_to_linear, despill, linear_to_srgb, srgb_to_linear, to_u16, LinearAdjust, ToF32};
use crate::writers::Batch;

pub const OUTPUTS: [&str; 4] = ["alpha", "fg", "checker", "cutout"];

#[derive(Clone, Debug, PartialEq)]
pub struct RenderOpts {
    pub alpha: bool,
    pub fg: bool,
    pub checker: bool,
    pub cutout: bool,
    pub despill: f32,
    pub cutout_linear: bool,
    pub exr: bool,
    pub adjust: LinearAdjust,
}

/// video_io.make_checker: 64 px squares, 0.75 / 0.5 grey, (3, h, w) as one plane (all three are equal).
pub fn make_checker(h: usize, w: usize) -> Vec<f32> {
    let mut v = vec![0f32; h * w];
    // loop: HOT-PATH-OK — once per job
    for y in 0..h {
        // loop: HOT-PATH-OK — one row
        for x in 0..w {
            v[y * w + x] = if ((y / 64) + (x / 64)) % 2 == 0 { 0.75 } else { 0.5 };
        }
    }
    v
}

/// Render one frame. `logits`: (4, H, W) for the padded shape; crop (t, l) and the native (h, w).
/// Returns (output name, one-frame batch) for each selected output, NHWC in BGR(A) / 1-channel order:
/// video: uint16 (alpha as 3 equal channels); EXR: float32, scene-linear, unclamped colour.
/// Rows render in parallel, each straight into its place in the outputs (no per-row buffers, no join copy).
/// `logits` are read in stage 2's own type (float16 or float32), each value converted as it is used (exact).
pub fn render<L: ToF32>(
    o: &RenderOpts,
    logits: &[L],
    shape: (usize, usize),
    crop: (usize, usize),
    hw: (usize, usize),
    checker_srgb: &[f32],
) -> Vec<(&'static str, Batch)> {
    let (h, w) = hw;
    let on = [o.alpha, o.fg, o.checker, o.cutout];
    if o.exr {
        let ch = [1, 3, 3, 4];
        let mut bufs: [Vec<f32>; 4] = std::array::from_fn(|i| if on[i] { vec![0f32; h * w * ch[i]] } else { Vec::new() });
        rows_parallel(&mut bufs, ch, h, w, |y, r| render_row_exr(o, logits, shape, crop, w, y, checker_srgb, r));
        // loop: NOT-WORTH — four outputs per frame
        OUTPUTS.iter().zip(bufs).zip(on).filter(|(_, on)| *on).map(|((n, b), _)| (*n, Batch::F32(b))).collect()
    } else {
        let ch = [3, 3, 3, 4];
        let mut bufs: [Vec<u16>; 4] = std::array::from_fn(|i| if on[i] { vec![0u16; h * w * ch[i]] } else { Vec::new() });
        rows_parallel(&mut bufs, ch, h, w, |y, r| render_row_video(o, logits, shape, crop, w, y, checker_srgb, r));
        // loop: NOT-WORTH — four outputs per frame
        OUTPUTS.iter().zip(bufs).zip(on).filter(|(_, on)| *on).map(|((n, b), _)| (*n, Batch::U16(b))).collect()
    }
}

/// One output row of each output (None: not selected), in OUTPUTS order.
type Row<'a, T> = [Option<&'a mut [T]>; 4];

/// Split each selected output into its rows and run `f(y, rows)` for every row in parallel.
fn rows_parallel<T: Send>(bufs: &mut [Vec<T>; 4], ch: [usize; 4], h: usize, w: usize, f: impl Fn(usize, Row<'_, T>) + Sync + Send) {
    use rayon::prelude::*;
    // loop: HOT-PATH-OK — one small array per output row (h ≤ 2160), per frame; the pixels go straight into the outputs (this pass: per-row vectors and a join copy)
    let mut rows: Vec<Row<'_, T>> = (0..h).map(|_| [None, None, None, None]).collect();
    // loop: HOT-PATH-OK — four outputs; each split into its h row slices (pointer work, no copies)
    for (i, b) in bufs.iter_mut().enumerate() {
        if b.is_empty() {
            continue;
        }
        // loop: HOT-PATH-OK — one slice per output row (h ≤ 2160)
        for (y, chunk) in b.chunks_mut(w * ch[i]).enumerate() {
            rows[y][i] = Some(chunk);
        }
    }
    // loop: HOT-PATH-OK — output rows in parallel, per frame
    rows.into_par_iter().enumerate().for_each(|(y, r)| f(y, r));
}

#[allow(clippy::too_many_arguments)]
fn render_row_exr<L: ToF32>(
    o: &RenderOpts,
    logits: &[L],
    shape: (usize, usize),
    crop: (usize, usize),
    w: usize,
    y: usize,
    checker_srgb: &[f32],
    r: Row<'_, f32>,
) {
    let (sh, sw) = shape;
    let (t, l) = crop;
    let plane = sh * sw;
    let denom = crate::color::asinh_denom();
    let at = |c: usize, x: usize| logits[c * plane + (t + y) * sw + (l + x)].to_f32();
    let want_color = o.fg || o.checker || o.cutout;
    let [mut alpha, mut fg, mut ck, mut cu] = r;
    // loop: HOT-PATH-OK — one output row
    for x in 0..w {
        let pa = at(0, x).clamp(0.0, 1.0);
        if let Some(a) = alpha.as_deref_mut() {
            a[x] = pa;
        }
        if !want_color {
            continue;
        }
        let lin = [0, 1, 2].map(|c| o.adjust.invert(asinh_to_linear(at(1 + c, x), denom)));
        if let Some(f) = fg.as_deref_mut() {
            f[3 * x..3 * x + 3].copy_from_slice(&[lin[2], lin[1], lin[0]]);
        }
        if o.cutout || o.checker {
            let d = despill(lin, o.despill);
            if let Some(c) = cu.as_deref_mut() {
                c[4 * x..4 * x + 4].copy_from_slice(&[d[2], d[1], d[0], pa]);
            }
            if let Some(k) = ck.as_deref_mut() {
                let bl = srgb_to_linear(checker_srgb[y * w + x]);
                let c = [0, 1, 2].map(|i| d[i] * pa + bl * (1.0 - pa));
                k[3 * x..3 * x + 3].copy_from_slice(&[c[2], c[1], c[0]]);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn render_row_video<L: ToF32>(
    o: &RenderOpts,
    logits: &[L],
    shape: (usize, usize),
    crop: (usize, usize),
    w: usize,
    y: usize,
    checker_srgb: &[f32],
    r: Row<'_, u16>,
) {
    let (sh, sw) = shape;
    let (t, l) = crop;
    let plane = sh * sw;
    let denom = crate::color::asinh_denom();
    let at = |c: usize, x: usize| logits[c * plane + (t + y) * sw + (l + x)].to_f32();
    let want_color = o.fg || o.checker || o.cutout;
    let [mut alpha, mut fg, mut ck, mut cu] = r;
    // loop: HOT-PATH-OK — one output row
    for x in 0..w {
        let pa = at(0, x).clamp(0.0, 1.0);
        if let Some(a) = alpha.as_deref_mut() {
            let v = to_u16(pa);
            a[3 * x..3 * x + 3].copy_from_slice(&[v, v, v]);
        }
        if !want_color {
            continue;
        }
        let lin = [0, 1, 2].map(|c| o.adjust.invert(asinh_to_linear(at(1 + c, x), denom)));
        let pos = lin.map(|v| v.max(0.0));
        let pf = pos.map(|v| linear_to_srgb(v).clamp(0.0, 1.0));
        if let Some(f) = fg.as_deref_mut() {
            f[3 * x..3 * x + 3].copy_from_slice(&[to_u16(pf[2]), to_u16(pf[1]), to_u16(pf[0])]);
        }
        if let Some(c) = cu.as_deref_mut() {
            let d = if o.cutout_linear { despill(pos, o.despill).map(|v| v.clamp(0.0, 1.0)) } else { despill(pf, o.despill) };
            c[4 * x..4 * x + 4].copy_from_slice(&[to_u16(d[2]), to_u16(d[1]), to_u16(d[0]), to_u16(pa)]);
        }
        if let Some(k) = ck.as_deref_mut() {
            let bl = srgb_to_linear(checker_srgb[y * w + x]);
            let d = despill(pf, o.despill);
            let c = [0, 1, 2].map(|i| linear_to_srgb((srgb_to_linear(d[i]) * pa + bl * (1.0 - pa)).max(0.0)).clamp(0.0, 1.0));
            k[3 * x..3 * x + 3].copy_from_slice(&[to_u16(c[2]), to_u16(c[1]), to_u16(c[0])]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(exr: bool) -> RenderOpts {
        RenderOpts { alpha: true, fg: true, checker: true, cutout: true, despill: 0.5, cutout_linear: false, exr, adjust: LinearAdjust::default() }
    }

    #[test]
    fn checker_squares() {
        let c = make_checker(130, 130);
        assert_eq!((c[0], c[64], c[64 * 130], c[64 * 130 + 64], c[129 * 130 + 129]), (0.75, 0.5, 0.5, 0.75, 0.75));
    }

    #[test]
    fn crop_and_alpha() {
        // shape 2x3, native 1x2 at (1, 1); alpha logits 2.0 (clamped to 1) and -1 (clamped to 0)
        let mut lg = vec![0f32; 4 * 6];
        lg[4] = 2.0;
        lg[5] = -1.0;
        let out = render(&opts(true), &lg, (2, 3), (1, 1), (1, 2), &[0.75, 0.75]);
        let Batch::F32(a) = &out[0].1 else { panic!() };
        assert_eq!((out[0].0, a.clone()), ("alpha", vec![1.0, 0.0]));
        let Batch::F32(f) = &out[1].1 else { panic!() };
        assert_eq!(f.len(), 6);
        assert!(f.iter().all(|v| v.abs() < 1e-12)); // asinh 0 -> linear 0
        let vid = render(&opts(false), &lg, (2, 3), (1, 1), (1, 2), &[0.75, 0.75]);
        let Batch::U16(a) = &vid[0].1 else { panic!() };
        assert_eq!(a, &vec![65535, 65535, 65535, 0, 0, 0]);
        // checker at alpha 0 is the background: 0.75 -> 49151
        let Batch::U16(c) = &vid[2].1 else { panic!() };
        assert!((c[3] as i32 - 49151).abs() <= 1, "{}", c[3]);
    }
}
