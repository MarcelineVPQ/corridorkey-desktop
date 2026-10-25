//! Stage-2 logits -> the output frames (runtime._render_predictions_torch for video,
//! _render_predictions_exr_torch for EXR): crop the padding, alpha clamped, fg decoded from asinh to linear,
//! despill, the checker composite, the cutout.
use crate::color::{asinh_to_linear, despill, linear_to_srgb, srgb_to_linear, to_u16, LinearAdjust, ToF32};
use crate::writers::Batch;

pub(crate) const OUTPUTS: [&str; 4] = ["alpha", "fg", "checker", "cutout"];

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
    /// EXR outputs (backlog row 29): linear Rec.709 -> the job's output colour space, applied to the foreground
    /// and the cutout's colour after despill (despill works in the model's space, as trained). Alpha is data and is
    /// never transformed; the checker preview stays as it is. None: linear Rec.709, as before.
    pub color_out: Option<crate::ocio::XformRef>,
    /// the output space is scene-linear: the EXR cutout is premultiplied there; in a log or display space it is
    /// straight colour + alpha (the Nuke convention; the study §6)
    pub out_linear: bool,
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
/// video: uint16 BGR (alpha as 3 equal channels), the cutout premultiplied in its own coding (sRGB-coded colour, or
/// linear with `cutout_linear`, × alpha): no video codec here carries alpha, its alpha is the matte output (row 26);
/// EXR: float32, scene-linear, unclamped colour, the cutout premultiplied (RGB x alpha) as EXR and Nuke expect.
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
        let ch = [3, 3, 3, 3];
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
    // loop: HOT-PATH-OK — one small array per output row (h ≤ 2160), per frame; the pixels go straight into the outputs
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
                if o.color_out.is_some() {
                    // straight here: the output processor and the premultiply follow for the whole row (below)
                    c[4 * x..4 * x + 4].copy_from_slice(&[d[2], d[1], d[0], pa]);
                } else {
                    // premultiplied, the EXR / Nuke convention (backlog row 30 c; the original writes straight colour)
                    c[4 * x..4 * x + 4].copy_from_slice(&[d[2] * pa, d[1] * pa, d[0] * pa, pa]);
                }
            }
            if let Some(k) = ck.as_deref_mut() {
                let bl = srgb_to_linear(checker_srgb[y * w + x]);
                let c = [0, 1, 2].map(|i| d[i] * pa + bl * (1.0 - pa));
                k[3 * x..3 * x + 3].copy_from_slice(&[c[2], c[1], c[0]]);
            }
        }
    }
    if let Some(xf) = &o.color_out {
        if let Some(f) = fg {
            apply_bgr(xf, f, 3);
        }
        if let Some(c) = cu {
            apply_bgr(xf, c, 4);
            if o.out_linear {
                // loop: HOT-PATH-OK — one output row
                for px in c.chunks_exact_mut(4) {
                    let a = px[3];
                    px[0] *= a;
                    px[1] *= a;
                    px[2] *= a;
                }
            }
        }
    }
}

/// An OCIO processor on one row of BGR(A) pixels (`stride` 3 or 4 floats; alpha untouched): to RGB order, the
/// processor, back to BGR.
fn apply_bgr(xf: &crate::ocio::Xform, row: &mut [f32], stride: usize) {
    // loop: HOT-PATH-OK — one output row, swapped in place
    row.chunks_exact_mut(stride).for_each(|px| px.swap(0, 2));
    xf.apply(row, stride);
    // loop: HOT-PATH-OK — and back
    row.chunks_exact_mut(stride).for_each(|px| px.swap(0, 2));
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
            // premultiplied in the file's own coding, which is what Nuke's and Resolve's "premultiplied" reads undo;
            // the colour clamped to the file's range first (despill can push it past 1), so unpremultiplying gives
            // the straight colour a file can hold
            let p = d.map(|v| v.clamp(0.0, 1.0) * pa);
            c[3 * x..3 * x + 3].copy_from_slice(&[to_u16(p[2]), to_u16(p[1]), to_u16(p[0])]);
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
        RenderOpts {
            alpha: true,
            fg: true,
            checker: true,
            cutout: true,
            despill: 0.5,
            cutout_linear: false,
            exr,
            adjust: LinearAdjust::default(),
            color_out: None,
            out_linear: true,
        }
    }

    #[test]
    fn exr_cutout_is_premultiplied() {
        // one pixel, alpha logit 0.25; colour logits that decode to a known linear colour
        let mut lg = vec![0f32; 4];
        lg[0] = 0.25;
        lg[1] = 0.4;
        lg[2] = 0.9;
        lg[3] = 0.1;
        let mut o = opts(true);
        o.despill = 0.0;
        let out = render(&o, &lg, (1, 1), (0, 0), (1, 1), &[0.75]);
        let Batch::F32(fg) = &out[1].1 else { panic!() };
        let Batch::F32(cu) = &out[3].1 else { panic!() };
        assert_eq!(out[3].0, "cutout");
        // straight colour (fg, despill 0) x alpha, exactly; alpha itself unchanged
        assert_eq!(cu.as_slice(), &[fg[0] * 0.25, fg[1] * 0.25, fg[2] * 0.25, 0.25]);
        assert!(fg[0] > 0.0 && cu[0] < fg[0]);
        // the video cutout: three channels, the sRGB-coded foreground (despill 0) x alpha (no alpha channel: the
        // matte output is its alpha)
        let mut v = opts(false);
        v.despill = 0.0;
        let vid = render(&v, &lg, (1, 1), (0, 0), (1, 1), &[0.75]);
        let (Batch::U16(vf), Batch::U16(vc)) = (&vid[1].1, &vid[3].1) else { panic!() };
        assert_eq!(vc.len(), 3);
        // loop: NOT-WORTH — three channels
        for c in 0..3 {
            let want = (vf[c] as f64 * 0.25).round() as i64;
            assert!((vc[c] as i64 - want).abs() <= 1, "c {c}: {} vs {want}", vc[c]);
        }
        assert!(vc[0] > 0 && vc[0] < vf[0]);
    }

    /// Test 6 (the study's plan): alpha is data, byte-identical for every output colour space; the foreground and the
    /// cutout's colour go through the output processor after despill; the cutout is premultiplied only in a linear
    /// output space.
    #[test]
    fn output_colour_space_changes_colour_never_alpha() {
        // 2x3 pixels; alpha logits across [0, 1] and beyond, colour logits signed
        let (h, w) = (2, 3);
        let n = h * w;
        // loop: NOT-WORTH — a 6-pixel test frame
        let lg: Vec<f32> = (0..4 * n).map(|i| if i < n { i as f32 * 0.3 - 0.2 } else { ((i * 37) % 23) as f32 / 23.0 - 0.3 }).collect();
        let ck = vec![0.75f32; n];
        let mut base = opts(true);
        base.despill = 0.5;
        let plain = render(&base, &lg, (h, w), (0, 0), (h, w), &ck);
        let alpha = |out: &Vec<(&'static str, Batch)>| match &out[0].1 {
            Batch::F32(a) => a.iter().map(|v| v.to_bits()).collect::<Vec<u32>>(),
            _ => panic!(),
        };
        // loop: NOT-WORTH — five output spaces
        for space in [crate::ocio::MODEL_SPACE, "ACEScg", "ACES2065-1", "ACEScct", "sRGB Encoded Rec.709 (sRGB)", "Raw"] {
            let j = crate::ocio::color_job(Some("ocio://studio-config-latest"), None, Some("ACEScg"), Some(space)).unwrap().unwrap();
            let mut o = base.clone();
            o.color_out = j.output.clone();
            o.out_linear = j.output_linear;
            let got = render(&o, &lg, (h, w), (0, 0), (h, w), &ck);
            assert_eq!(alpha(&got), alpha(&plain), "{space}: alpha changed");
            let (Batch::F32(fg0), Batch::F32(fg), Batch::F32(cu0), Batch::F32(cu)) = (&plain[1].1, &got[1].1, &plain[3].1, &got[3].1) else { panic!() };
            // the checker preview is not colour-managed
            let (Batch::F32(k0), Batch::F32(k)) = (&plain[2].1, &got[2].1) else { panic!() };
            assert_eq!(k0, k, "{space}: checker changed");
            let Batch::F32(a) = &plain[0].1 else { panic!() };
            match &j.output {
                None => {
                    // linear Rec.709 out: exactly today's outputs
                    assert_eq!((fg0, cu0), (fg, cu), "{space}");
                }
                Some(x) => {
                    // fg: the processor on today's linear fg (BGR rows)
                    let mut want = fg0.clone();
                    super::apply_bgr(x, &mut want, 3);
                    assert_eq!(fg.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), want.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{space}");
                    // cutout: today's premultiplied colour / alpha = the straight despilled colour, transformed
                    // loop: NOT-WORTH — six pixels
                    for i in 0..n {
                        let ai = a[i];
                        assert_eq!(cu[4 * i + 3].to_bits(), ai.to_bits());
                        if ai < 1e-3 {
                            continue;
                        }
                        let mut s = [cu0[4 * i] / ai, cu0[4 * i + 1] / ai, cu0[4 * i + 2] / ai];
                        super::apply_bgr(x, &mut s, 3);
                        let m = if j.output_linear { ai } else { 1.0 };
                        // loop: NOT-WORTH — three channels
                        for c in 0..3 {
                            let (g, e) = (cu[4 * i + c], s[c] * m);
                            assert!((g - e).abs() <= 1e-5 * e.abs().max(1.0), "{space} px {i} c {c}: {g} vs {e}");
                        }
                    }
                }
            }
        }
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
