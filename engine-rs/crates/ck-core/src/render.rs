//! Stage-2 logits -> the output frames (runtime._render_predictions_torch for video,
//! _render_predictions_exr_torch for EXR): crop the padding, alpha clamped, fg decoded from asinh to linear,
//! despill, the checker composite, the cutout.
use crate::color::{asinh_to_linear, despill, linear_to_srgb, srgb_to_linear, to_u16, LinearAdjust};
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
pub fn render(o: &RenderOpts, logits: &[f32], shape: (usize, usize), crop: (usize, usize), hw: (usize, usize), checker_srgb: &[f32]) -> Vec<(&'static str, Batch)> {
    let (sh, sw) = shape;
    let (t, l) = crop;
    let (h, w) = hw;
    let plane = sh * sw;
    let denom = crate::color::asinh_denom();
    let at = |c: usize, y: usize, x: usize| logits[c * plane + (t + y) * sw + (l + x)];
    let n = h * w;
    let want_color = o.fg || o.checker || o.cutout;
    let mut alpha_v: Vec<u16> = Vec::new();
    let mut alpha_f: Vec<f32> = Vec::new();
    let mut fg_v: Vec<u16> = Vec::new();
    let mut fg_f: Vec<f32> = Vec::new();
    let mut ck_v: Vec<u16> = Vec::new();
    let mut ck_f: Vec<f32> = Vec::new();
    let mut cu_v: Vec<u16> = Vec::new();
    let mut cu_f: Vec<f32> = Vec::new();
    let reserve = |n: usize, want: bool| if want { n } else { 0 };
    if o.exr {
        alpha_f.reserve(reserve(n, o.alpha));
        fg_f.reserve(reserve(n * 3, o.fg));
        ck_f.reserve(reserve(n * 3, o.checker));
        cu_f.reserve(reserve(n * 4, o.cutout));
    } else {
        alpha_v.reserve(reserve(n * 3, o.alpha));
        fg_v.reserve(reserve(n * 3, o.fg));
        ck_v.reserve(reserve(n * 3, o.checker));
        cu_v.reserve(reserve(n * 4, o.cutout));
    }
    // loop: HOT-PATH-OK — one pass per output frame over its pixels
    for y in 0..h {
        // loop: HOT-PATH-OK — one row
        for x in 0..w {
            let pa = at(0, y, x).clamp(0.0, 1.0);
            if o.exr {
                if o.alpha {
                    alpha_f.push(pa);
                }
            } else if o.alpha {
                let a = to_u16(pa);
                alpha_v.extend([a, a, a]);
            }
            if !want_color {
                continue;
            }
            let lin = [0, 1, 2].map(|c| o.adjust.invert(asinh_to_linear(at(1 + c, y, x), denom)));
            let bg = checker_srgb[y * w + x];
            if o.exr {
                if o.fg {
                    fg_f.extend([lin[2], lin[1], lin[0]]);
                }
                if o.cutout || o.checker {
                    let d = despill(lin, o.despill);
                    if o.cutout {
                        cu_f.extend([d[2], d[1], d[0], pa]);
                    }
                    if o.checker {
                        let bl = srgb_to_linear(bg);
                        let c = [0, 1, 2].map(|i| d[i] * pa + bl * (1.0 - pa));
                        ck_f.extend([c[2], c[1], c[0]]);
                    }
                }
                continue;
            }
            let pos = lin.map(|v| v.max(0.0));
            let pf = pos.map(|v| linear_to_srgb(v).clamp(0.0, 1.0));
            if o.fg {
                fg_v.extend([to_u16(pf[2]), to_u16(pf[1]), to_u16(pf[0])]);
            }
            if o.cutout {
                let d = if o.cutout_linear { despill(pos, o.despill).map(|v| v.clamp(0.0, 1.0)) } else { despill(pf, o.despill) };
                cu_v.extend([to_u16(d[2]), to_u16(d[1]), to_u16(d[0]), to_u16(pa)]);
            }
            if o.checker {
                let bl = srgb_to_linear(bg);
                let d = despill(pf, o.despill);
                let c = [0, 1, 2].map(|i| linear_to_srgb((srgb_to_linear(d[i]) * pa + bl * (1.0 - pa)).max(0.0)).clamp(0.0, 1.0));
                ck_v.extend([to_u16(c[2]), to_u16(c[1]), to_u16(c[0])]);
            }
        }
    }
    let mut out = Vec::new();
    if o.exr {
        if o.alpha {
            out.push(("alpha", Batch::F32(alpha_f)));
        }
        if o.fg {
            out.push(("fg", Batch::F32(fg_f)));
        }
        if o.checker {
            out.push(("checker", Batch::F32(ck_f)));
        }
        if o.cutout {
            out.push(("cutout", Batch::F32(cu_f)));
        }
    } else {
        if o.alpha {
            out.push(("alpha", Batch::U16(alpha_v)));
        }
        if o.fg {
            out.push(("fg", Batch::U16(fg_v)));
        }
        if o.checker {
            out.push(("checker", Batch::U16(ck_v)));
        }
        if o.cutout {
            out.push(("cutout", Batch::U16(cu_v)));
        }
    }
    out
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
