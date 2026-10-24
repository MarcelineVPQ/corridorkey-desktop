//! Planar float32 images (C, H, W) and the resamplers the runtime uses:
//!  - reflect-101 padding to the shape quantum and the crop back (video_io.center_pad_to_shape, cv2
//!    BORDER_REFLECT_101; runtime._crop_native_torch);
//!  - area resize = torch `F.interpolate(mode="area")` (adaptive average pooling) for the C-RADIO / MoGe inputs;
//!  - bilinear resize = torch `F.interpolate(mode="bilinear", align_corners=False)` for the RVM input and the
//!    carry-hint upsample;
//!  - Lanczos-4 = cv2.resize(INTER_LANCZOS4) on float32, for hint frames whose size differs from the model's.

#[derive(Clone, Debug, PartialEq)]
pub struct Planar {
    pub c: usize,
    pub h: usize,
    pub w: usize,
    pub data: Vec<f32>,
}

impl Planar {
    pub fn new(c: usize, h: usize, w: usize) -> Planar {
        Planar { c, h, w, data: vec![0.0; c * h * w] }
    }
    pub fn from_vec(c: usize, h: usize, w: usize, data: Vec<f32>) -> Planar {
        assert_eq!(data.len(), c * h * w, "planar size");
        Planar { c, h, w, data }
    }
    #[inline]
    pub(crate) fn plane(&self, c: usize) -> &[f32] {
        &self.data[c * self.h * self.w..(c + 1) * self.h * self.w]
    }
    #[inline]
    pub(crate) fn plane_mut(&mut self, c: usize) -> &mut [f32] {
        let n = self.h * self.w;
        &mut self.data[c * n..(c + 1) * n]
    }
    pub(crate) fn map(&mut self, f: impl Fn(f32) -> f32) {
        // loop: HOT-PATH-OK — one pass over a small image (RVM input, carry hint, hint); clamp / round
        self.data.iter_mut().for_each(|v| *v = f(*v));
    }
}

/// The padding of the runtime's probe: (pad_l, pad_r, pad_t, pad_b) to the next multiple of `q` (at least q).
pub(crate) fn ceil_to_multiple(x: usize, q: usize) -> usize {
    q.max(x.div_ceil(q) * q)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pad {
    pub l: usize,
    pub r: usize,
    pub t: usize,
    pub b: usize,
}

/// video_io: centre padding of an (h, w) image to (h_out, w_out).
pub fn center_pad(h: usize, w: usize, h_out: usize, w_out: usize) -> Pad {
    let t = (h_out - h) / 2;
    let l = (w_out - w) / 2;
    Pad { l, r: w_out - w - l, t, b: h_out - h - t }
}

/// cv2.borderInterpolate for BORDER_REFLECT_101 (gfedcb|abcdefgh|gfedcba).
#[inline]
pub(crate) fn reflect101(mut p: isize, len: usize) -> usize {
    let n = len as isize;
    if n == 1 {
        return 0;
    }
    // loop: HOT-PATH-OK — one or two steps unless the pad is wider than the image
    while p < 0 || p >= n {
        if p < 0 {
            p = -p;
        } else {
            p = 2 * n - 2 - p;
        }
    }
    p as usize
}

/// Rows per rayon task in the per-frame image passes (a 1280-wide row is ~1 µs of work).
pub(crate) const ROWS_MIN: usize = 8;

/// cv2.copyMakeBorder(BORDER_REFLECT_101) of every plane.
pub(crate) fn pad_reflect101(img: &Planar, pad: Pad) -> Planar {
    if pad == (Pad { l: 0, r: 0, t: 0, b: 0 }) {
        return img.clone();
    }
    let (ho, wo) = (img.h + pad.t + pad.b, img.w + pad.l + pad.r);
    // loop: NOT-WORTH — the column table, once per padded frame (≤ 4096 entries)
    let xs: Vec<usize> = (0..wo).map(|x| reflect101(x as isize - pad.l as isize, img.w)).collect();
    let mut out = Planar::new(img.c, ho, wo);
    use rayon::prelude::*;
    // loop: HOT-PATH-OK — once per frame and plane (3); the rows of a plane in parallel
    for c in 0..img.c {
        let src = img.plane(c);
        let dst = out.plane_mut(c);
        // loop: HOT-PATH-OK — rows of one plane in parallel (this pass: were one thread); a gather over the column table
        dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).enumerate().for_each(|(y, drow)| {
            let sy = reflect101(y as isize - pad.t as isize, img.h);
            let srow = &src[sy * img.w..(sy + 1) * img.w];
            // loop: HOT-PATH-OK — one row's gather (≤ 4096)
            drow.iter_mut().zip(&xs).for_each(|(d, &sx)| *d = srow[sx]);
        });
    }
    out
}

/// x[..., t:t+h, l:l+w] (runtime._crop_native_torch / video_io.crop_chw_to_native); the render crops its rows
/// itself, so only the tests use this (the pad / crop round trip).
#[cfg(test)]
fn crop(img: &Planar, t: usize, l: usize, h: usize, w: usize) -> Planar {
    let mut out = Planar::new(img.c, h, w);
    // loop: HOT-PATH-OK — once per output frame and plane
    for c in 0..img.c {
        let src = img.plane(c);
        let dst = out.plane_mut(c);
        // loop: HOT-PATH-OK — row copies
        for y in 0..h {
            dst[y * w..(y + 1) * w].copy_from_slice(&src[(t + y) * img.w + l..(t + y) * img.w + l + w]);
        }
    }
    out
}

/// torch adaptive pooling bounds: [start, end) of output cell `o` of `n_out` over `n_in` inputs.
#[inline]
fn adaptive_range(o: usize, n_out: usize, n_in: usize) -> (usize, usize) {
    let start = (o * n_in) / n_out;
    let end = ((o + 1) * n_in).div_ceil(n_out);
    (start, end)
}

/// torch F.interpolate(mode="area") = adaptive_avg_pool2d: each output is the mean of its input cell
/// (`sum / kh / kw` in float32, as the CPU kernel).
pub fn resize_area(img: &Planar, ho: usize, wo: usize) -> Planar {
    let mut out = Planar::new(img.c, ho, wo);
    // loop: NOT-WORTH — the row table, once per resize (≤ 960 entries)
    let ys: Vec<(usize, usize)> = (0..ho).map(|o| adaptive_range(o, ho, img.h)).collect();
    // loop: NOT-WORTH — the column table, once per resize (≤ 960 entries)
    let xs: Vec<(usize, usize)> = (0..wo).map(|o| adaptive_range(o, wo, img.w)).collect();
    use rayon::prelude::*;
    // loop: HOT-PATH-OK — per frame and plane (3); the output rows of a plane in parallel
    for c in 0..img.c {
        let src = img.plane(c);
        let dst = out.plane_mut(c);
        // loop: HOT-PATH-OK — output rows in parallel (this pass: were one thread)
        dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(|(drow, &(y0, y1))| {
            // loop: HOT-PATH-OK — output columns of one row (wo ≤ 960)
            for (ox, &(x0, x1)) in xs.iter().enumerate() {
                let mut sum = 0.0f32;
                // loop: HOT-PATH-OK — the cell's rows (4 for C-RADIO, ~5 for MoGe)
                for y in y0..y1 {
                    // loop: HOT-PATH-OK — one cell row (4-5 values)
                    sum += src[y * img.w + x0..y * img.w + x1].iter().fold(0.0f32, |a, &v| a + v);
                }
                drow[ox] = sum / (y1 - y0) as f32 / (x1 - x0) as f32;
            }
        });
    }
    out
}

/// One axis of torch's bilinear (align_corners=False, no antialias): (i0, i1, w0, w1) per output index.
fn bilinear_axis(n_in: usize, n_out: usize) -> Vec<(usize, usize, f32, f32)> {
    let scale = n_in as f32 / n_out as f32;
    (0..n_out)
        .map(|d| {
            let src = (scale * (d as f32 + 0.5) - 0.5).max(0.0);
            let i0 = src as usize;
            let l1 = (src - i0 as f32).min(1.0);
            let i1 = if i0 < n_in - 1 { i0 + 1 } else { i0 };
            (i0, i1, 1.0 - l1, l1)
        })
        .collect()
}

/// torch F.interpolate(mode="bilinear", align_corners=False) of every plane.
pub fn resize_bilinear(img: &Planar, ho: usize, wo: usize) -> Planar {
    let mut out = Planar::new(img.c, ho, wo);
    resize_bilinear_into(img, ho, wo, &mut out.data);
    out
}

/// `resize_bilinear` into `dst` (c * ho * wo).
pub(crate) fn resize_bilinear_into(img: &Planar, ho: usize, wo: usize, dst_all: &mut [f32]) {
    let ys = bilinear_axis(img.h, ho);
    let xs = bilinear_axis(img.w, wo);
    use rayon::prelude::*;
    // loop: HOT-PATH-OK — per frame and plane (3, or 1 for a carry hint); the output rows in parallel
    for c in 0..img.c {
        let src = img.plane(c);
        let dst = &mut dst_all[c * ho * wo..(c + 1) * ho * wo];
        // loop: HOT-PATH-OK — output rows in parallel (this pass: were one thread)
        dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(|(drow, &(y0, y1, wy0, wy1))| {
            let r0 = &src[y0 * img.w..(y0 + 1) * img.w];
            let r1 = &src[y1 * img.w..(y1 + 1) * img.w];
            // loop: HOT-PATH-OK — one output row (≤ 2176)
            drow.iter_mut().zip(&xs).for_each(|(d, &(x0, x1, wx0, wx1))| {
                *d = (r0[x0] * wx0 + r0[x1] * wx1) * wy0 + (r1[x0] * wx0 + r1[x1] * wx1) * wy1;
            });
        });
    }
}

/// OpenCV's Lanczos-4 coefficients for fractional offset `fx` (imgproc resize.cpp interpolateLanczos4).
fn lanczos4_coeffs(fx: f32) -> [f32; 8] {
    const S45: f64 = std::f64::consts::FRAC_1_SQRT_2; // 0.7071067811865476, the same double as OpenCV's literal
    const CS: [[f64; 2]; 8] = [[1.0, 0.0], [-S45, -S45], [0.0, 1.0], [S45, -S45], [-1.0, 0.0], [S45, S45], [0.0, -1.0], [-S45, S45]];
    let mut c = [0f32; 8];
    if fx < f32::EPSILON {
        c[3] = 1.0;
        return c;
    }
    let fx = fx as f64;
    let y0 = -(fx + 3.0) * std::f64::consts::PI * 0.25;
    let (s0, c0) = (y0.sin(), y0.cos());
    let mut sum = 0.0f64;
    // loop: NOT-WORTH — eight taps
    for i in 0..8 {
        let y = -(fx + 3.0 - i as f64) * std::f64::consts::PI * 0.25;
        let v = (CS[i][0] * s0 + CS[i][1] * c0) / (y * y);
        c[i] = v as f32;
        sum += v;
    }
    let inv = 1.0 / sum;
    // loop: NOT-WORTH — eight taps
    c.iter_mut().for_each(|v| *v = (*v as f64 * inv) as f32);
    c
}

/// One axis of cv2's Lanczos-4: (first source index, 8 coefficients); taps outside clamp to the edge.
fn lanczos4_axis(n_in: usize, n_out: usize) -> Vec<(isize, [f32; 8])> {
    let scale = n_in as f64 / n_out as f64;
    (0..n_out)
        .map(|d| {
            let f = ((d as f64 + 0.5) * scale - 0.5) as f32;
            let s = f.floor();
            (s as isize - 3, lanczos4_coeffs(f - s))
        })
        .collect()
}

/// cv2.resize(..., interpolation=INTER_LANCZOS4) on float32 planes (separable: horizontal, then vertical).
pub fn resize_lanczos4(img: &Planar, ho: usize, wo: usize) -> Planar {
    if img.h == ho && img.w == wo {
        return img.clone();
    }
    let xs = lanczos4_axis(img.w, wo);
    let ys = lanczos4_axis(img.h, ho);
    let clampi = |p: isize, n: usize| p.clamp(0, n as isize - 1) as usize;
    let mut out = Planar::new(img.c, ho, wo);
    let mut tmp = vec![0f32; img.h * wo];
    // loop: HOT-PATH-OK — per hint frame and plane
    for c in 0..img.c {
        let src = img.plane(c);
        // loop: HOT-PATH-OK — horizontal pass over the source rows
        for y in 0..img.h {
            let row = &src[y * img.w..(y + 1) * img.w];
            // loop: HOT-PATH-OK — output columns
            for (ox, (s, k)) in xs.iter().enumerate() {
                let mut v = 0.0f32;
                // loop: NOT-WORTH — eight taps
                for (j, kj) in k.iter().enumerate() {
                    v += row[clampi(s + j as isize, img.w)] * kj;
                }
                tmp[y * wo + ox] = v;
            }
        }
        let dst = out.plane_mut(c);
        // loop: HOT-PATH-OK — vertical pass, output rows
        for (oy, (s, k)) in ys.iter().enumerate() {
            // loop: HOT-PATH-OK — output columns
            for ox in 0..wo {
                let mut v = 0.0f32;
                // loop: NOT-WORTH — eight taps
                for (j, kj) in k.iter().enumerate() {
                    v += tmp[clampi(s + j as isize, img.h) * wo + ox] * kj;
                }
                dst[oy * wo + ox] = v;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflect_101_indices() {
        // gfedcb|abcdefgh|gfedcba
        let v: Vec<usize> = (-3..11).map(|p| reflect101(p, 8)).collect();
        assert_eq!(v, vec![3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4]);
        assert_eq!(reflect101(-5, 1), 0);
        assert_eq!(reflect101(7, 3), 1); // pad wider than the image keeps reflecting
    }

    #[test]
    fn pad_then_crop_is_identity() {
        let img = Planar::from_vec(2, 3, 5, (0..30).map(|v| v as f32).collect());
        let pad = center_pad(3, 5, 8, 8);
        assert_eq!(pad, Pad { l: 1, r: 2, t: 2, b: 3 });
        let p = pad_reflect101(&img, pad);
        assert_eq!((p.h, p.w), (8, 8));
        assert_eq!(crop(&p, pad.t, pad.l, 3, 5), img);
    }

    #[test]
    fn quantum() {
        assert_eq!(ceil_to_multiple(200, 128), 256);
        assert_eq!(ceil_to_multiple(1080, 128), 1152);
        assert_eq!(ceil_to_multiple(1920, 128), 1920);
        assert_eq!(ceil_to_multiple(0, 128), 128);
    }

    #[test]
    fn area_of_exact_factor_is_block_mean() {
        let img = Planar::from_vec(1, 4, 4, (0..16).map(|v| v as f32).collect());
        let a = resize_area(&img, 1, 2);
        assert_eq!(a.data, vec![(0. + 1. + 4. + 5. + 8. + 9. + 12. + 13.) / 8.0, (2. + 3. + 6. + 7. + 10. + 11. + 14. + 15.) / 8.0]);
    }

    #[test]
    fn lanczos_identity_and_constant() {
        let img = Planar::from_vec(1, 6, 7, vec![0.25; 42]);
        let r = resize_lanczos4(&img, 9, 4);
        assert!(r.data.iter().all(|v| (v - 0.25).abs() < 1e-6));
        assert_eq!(resize_lanczos4(&img, 6, 7), img);
    }
}
