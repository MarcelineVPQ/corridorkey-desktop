//! The ported math against the upstream Python functions' own outputs (tests/fixtures, made by
//! tools/gen_fixtures.py from a CorridorKey2.0 checkout). Each check prints its measured worst difference.
use ck_core::clip::{ClipMeta, Source};
use ck_core::color::*;
use ck_core::decode::{prep_frame, prep_hint, read_image_rgb, rgb8_to_planar, Still};
use ck_core::hann::{taper_weights, window_starts};
use ck_core::image::{center_pad, resize_area, resize_bilinear, resize_lanczos4, Planar};
use ck_core::render::{make_checker, render_scaled, RenderOpts};
use ck_core::writers::Batch;
use std::path::PathBuf;

/// the .npy reader for the fixtures (test-only: tests/npy)
mod npy;

fn fx(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn load(name: &str) -> (Vec<usize>, Vec<f32>) {
    npy::read(&fx(&format!("{name}.npy"))).unwrap()
}

/// max |a - b| and the count above `tol`
fn diff(name: &str, a: &[f32], b: &[f32], tol: f32) -> f32 {
    assert_eq!(a.len(), b.len(), "{name}: length");
    let mut worst = 0f32;
    let mut over = 0;
    // loop: HOT-PATH-OK — test comparison over a small fixture
    for (x, y) in a.iter().zip(b) {
        let d = (x - y).abs();
        if d > tol {
            over += 1;
        }
        worst = worst.max(d);
    }
    println!("{name}: max |diff| {worst:e} over {} values ({over} above {tol:e})", a.len());
    assert_eq!(over, 0, "{name}: {over} values differ by more than {tol}");
    worst
}

#[test]
fn colour_transforms() {
    let (_, x) = load("color_x");
    let d = asinh_denom();
    let rel = |a: Vec<f32>, b: Vec<f32>| -> Vec<f32> { a.iter().zip(&b).map(|(p, q)| (p - q) / q.abs().max(1.0)).collect() };
    let s2l = rel(x.iter().map(|&v| srgb_to_linear(v)).collect(), load("srgb_to_linear").1);
    diff("srgb_to_linear (relative)", &s2l, &vec![0.0; s2l.len()], 1e-6);
    diff("linear_to_srgb", &x.iter().map(|&v| linear_to_srgb(v)).collect::<Vec<_>>(), &load("linear_to_srgb").1, 2e-6);
    diff("linear_to_asinh", &x.iter().map(|&v| linear_to_asinh(v, d)).collect::<Vec<_>>(), &load("linear_to_asinh").1, 1e-6);
    // relative: sinh grows quickly
    let a: Vec<f32> = x.iter().map(|&v| asinh_to_linear(v, d)).collect();
    let b = load("asinh_to_linear").1;
    let rel: Vec<f32> = a.iter().zip(&b).map(|(p, q)| (p - q) / q.abs().max(1.0)).collect();
    diff("asinh_to_linear (relative)", &rel, &vec![0.0; rel.len()], 2e-6);
}

#[test]
fn despill_strengths() {
    let (s, v) = load("despill_in");
    let n = s[1];
    // loop: NOT-WORTH — three strengths
    for (st, name) in [(0.3f32, "despill_030"), (0.5, "despill_050"), (1.0, "despill_100")] {
        let mut got = vec![0f32; 3 * n];
        // loop: NOT-WORTH — 64 pixels
        for i in 0..n {
            let o = despill([v[i], v[n + i], v[2 * n + i]], st);
            (0..3).for_each(|c| got[c * n + i] = o[c]);
        }
        diff(name, &got, &load(name).1, 1e-6);
    }
}

fn meta(h: usize, w: usize, sh: usize, sw: usize) -> ClipMeta {
    ClipMeta {
        source: Source::Frames(vec![]),
        fps: 24.0,
        h,
        w,
        model_h: h,
        model_w: w,
        model_scale: 1.0,
        start_frame: 0,
        adjust: Default::default(),
        shape_h: sh,
        shape_w: sw,
        pad: center_pad(h, w, sh, sw),
        num_frames: 1,
        exr_linear: false,
        video_bits: 8,
        deep_input: false,
        color_in: None,
    }
}

#[test]
fn frame_preprocessing_matches_bf16_tensors() {
    let (_, rgb) = load("prep_frame_rgb");
    let bytes: Vec<u8> = rgb.iter().map(|&v| v as u8).collect();
    let m = meta(37, 53, 128, 128);
    let p = prep_frame(rgb8_to_planar(&bytes, 37, 53), false, &m, asinh_denom());
    let model: Vec<f32> = p.model.iter().map(|v| v.to_f32()).collect();
    let review: Vec<f32> = p.display.iter().map(|v| v.to_f32()).collect();
    diff("prep review (bf16)", &review, &load("prep_review").1, 0.0);
    // asinh in float32 can land on the other side of a bfloat16 rounding boundary: at most one bf16 step
    let want = load("prep_model").1;
    let steps = model.iter().zip(&want).filter(|(a, b)| a != b).count();
    println!("prep model (bf16): {steps} of {} values one bf16 step apart", model.len());
    diff("prep model (bf16)", &model, &want, 1.0 / 128.0 * 1.1);
    assert!(steps * 1000 < model.len(), "too many bf16 steps: {steps}");
}

#[test]
fn resamplers() {
    let (s, v) = load("resize_in");
    let img = Planar::from_vec(s[0], s[1], s[2], v);
    diff("area 32x48", &resize_area(&img, 32, 48).data, &load("area_32x48").1, 1e-6);
    diff("area 28x42 (MoGe 7/32)", &resize_area(&img, 28, 42).data, &load("area_28x42").1, 1e-6);
    diff("bilinear down 32x48", &resize_bilinear(&img, 32, 48).data, &load("bilinear_32x48").1, 1e-6);
    let (s, v) = load("bilinear_up_in");
    let small = Planar::from_vec(s[0], s[1], s[2], v);
    diff("bilinear up 128x192", &resize_bilinear(&small, 128, 192).data, &load("bilinear_up_128x192").1, 1e-6);
    let (s, v) = load("lanczos_in");
    let lz = Planar::from_vec(1, s[0], s[1], v);
    diff("lanczos4 up 64x96", &resize_lanczos4(&lz, 64, 96).data, &load("lanczos_64x96").1, 0.0);
    diff("lanczos4 down 37x53", &resize_lanczos4(&lz, 37, 53).data, &load("lanczos_37x53").1, 0.0);
}

#[test]
fn hint_frame_preprocessing() {
    let (_, rgb) = load("hint_rgb");
    let data: Vec<u8> = rgb.iter().map(|&v| v as u8).collect();
    let got = prep_hint(Still::U8 { ch: 3, h: 30, w: 40, data }, &meta(37, 53, 128, 128));
    diff("hint prep (gray, lanczos, pad, bf16)", &got, &load("hint_prep").1, 1.0 / 256.0 + 1e-6);
}

#[test]
fn windows() {
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fx("windows_vram.json")).unwrap()).unwrap();
    // loop: NOT-WORTH — eight cases
    for c in j["taper"].as_array().unwrap() {
        let w = taper_weights(
            c["tc"].as_u64().unwrap() as usize,
            c["overlap"].as_u64().unwrap() as usize,
            c["first"].as_bool().unwrap(),
            c["last"].as_bool().unwrap(),
        );
        let want: Vec<f32> = c["w"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
        diff(&format!("taper {c}"), &w, &want, 1e-7);
    }
    // loop: NOT-WORTH — seven cases
    for c in j["starts"].as_array().unwrap() {
        let got = window_starts(c["t"].as_u64().unwrap() as usize, c["chunk"].as_u64().unwrap() as usize, c["stride"].as_u64().unwrap() as usize);
        let want: Vec<usize> = c["starts"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(got, want, "{c}");
    }
    // the fixture's "vram" cases (the upstream PyTorch table) are no longer compared: the engine's table is its own
    // measured ONNX Runtime peaks since 2026-10-24 (docs/BACKLOG.md row 41; regression tests in src/vram.rs)
}

fn batch_f32(b: &Batch) -> Vec<f32> {
    match b {
        Batch::U16(v) => v.iter().map(|&x| x as f32).collect(),
        Batch::F32(v) => v.clone(),
    }
}

#[test]
fn render_paths() {
    let (_, logits) = load("render_logits");
    check_render("render", &logits, (30, 44), LinearAdjust::default());
}

/// The three render modes against `{prefix}_video_*` / `{prefix}_exr_*`: logits (4, 40, 56), the model's crop 30x44 at
/// (5, 6), the outputs `hw` (the crop's own size, or a model scale's native size).
fn check_render(prefix: &str, logits: &[f32], hw: (usize, usize), adjust: LinearAdjust) {
    let checker = make_checker(hw.0, hw.1);
    // loop: NOT-WORTH — three render modes
    for (exr, lin) in [(false, false), (false, true), (true, false)] {
        let o =
            RenderOpts { alpha: true, fg: true, checker: true, cutout: true, despill: 0.5, cutout_linear: lin, exr, adjust, color_out: None, out_linear: true };
        let out = render_scaled(&o, logits, (40, 56), (5, 6), (30, 44), hw, &checker);
        // loop: NOT-WORTH — four outputs
        for (name, b) in &out {
            if lin && *name != "cutout" {
                continue;
            }
            let fname = if exr {
                format!("{prefix}_exr_{name}")
            } else if lin {
                format!("{prefix}_video_{name}_lin")
            } else {
                format!("{prefix}_video_{name}")
            };
            // video: 16-bit samples, truncated: one step when a float32 product lands on the other side
            let tol = if exr { 2e-5 } else { 1.0 };
            let got = batch_f32(b);
            let mut want = load(&fname).1;
            if exr && *name == "cutout" {
                // the original writes the EXR cutout straight; ours is premultiplied on purpose (backlog row 30 c):
                // the reference's BGR x its own alpha
                // loop: HOT-PATH-OK — a small fixture, once
                for px in want.chunks_mut(4) {
                    let a = px[3];
                    // loop: NOT-WORTH — three channels
                    for v in &mut px[..3] {
                        *v *= a;
                    }
                }
            }
            let mut tol = tol;
            if !exr && *name == "cutout" {
                // the original's video cutout is straight BGRA (ProRes 4444); ours is three channels premultiplied in
                // the file's coding, its alpha the matte output (backlog row 26): the reference's BGR x its own
                // alpha, both 16-bit, so one more rounding step
                // loop: HOT-PATH-OK — a small fixture, once
                want = want.chunks(4).flat_map(|px| [px[0] * px[3] / 65535.0, px[1] * px[3] / 65535.0, px[2] * px[3] / 65535.0]).collect();
                tol = 2.0;
            }
            if exr {
                let rel: Vec<f32> = got.iter().zip(&want).map(|(a, w)| (a - w) / w.abs().max(1.0)).collect();
                diff(&format!("{fname} (relative)"), &rel, &vec![0.0; rel.len()], tol);
            } else {
                diff(&fname, &got, &want, tol);
            }
        }
    }
}

/// Backlog row 42: the render at a model scale (outputs 45x66 up and 20x29 down from the 30x44 crop), with the
/// linear adjust (row 45), against upstream's render with its output resize completed by upstream's own Lanczos
/// helper (tools/gen_fixtures.py `lanczos_out`).
#[test]
fn render_at_a_model_scale_with_the_linear_adjust() {
    let (_, logits) = load("render_logits");
    // loop: NOT-WORTH — two output sizes
    for (tag, hw) in [("up", (45, 66)), ("down", (20, 29))] {
        check_render(&format!("srender_{tag}"), &logits, hw, LinearAdjust::new(1.3, 0.9, 0.18));
    }
}

fn rows_42_45() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fx("rows_42_45.json")).unwrap()).unwrap()
}

/// cv2.resize(INTER_LANCZOS4) on float32: identical, every value (1 and 3 channels, up and down).
#[test]
fn lanczos4_bit_for_bit() {
    let j = rows_42_45();
    // loop: NOT-WORTH — six cases
    for (name, hw) in j["lanczos"].as_object().unwrap() {
        let (s, v) = load(&format!("lz_{name}_in"));
        let img = Planar::from_vec(s[0], s[1], s[2], v);
        let (ho, wo) = (hw[0].as_u64().unwrap() as usize, hw[1].as_u64().unwrap() as usize);
        let got = resize_lanczos4(&img, ho, wo);
        diff(&format!("lanczos4 {name}"), &got.data, &load(&format!("lz_{name}_out")).1, 0.0);
        let bits = got.data.iter().zip(&load(&format!("lz_{name}_out")).1).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
        assert_eq!(bits, 0, "lanczos4 {name}: {bits} values differ in their bits");
    }
}

/// video_io.apply_linear_adjust (numpy) and runtime._linear_adjust_inverse_torch (torch), float32.
#[test]
fn linear_adjust_both_ways() {
    let (_, x) = load("color_x");
    let j = rows_42_45();
    // loop: NOT-WORTH — two settings
    for (i, c) in j["adjust"].as_array().unwrap().iter().enumerate() {
        let a = LinearAdjust::new(c[0].as_f64().unwrap(), c[1].as_f64().unwrap(), c[2].as_f64().unwrap());
        diff(&format!("adjust apply {c}"), &x.iter().map(|&v| a.apply(v)).collect::<Vec<_>>(), &load(&format!("adjust_apply_{i}")).1, 0.0);
        let inv: Vec<f32> = x.iter().map(|&v| a.invert(v)).collect();
        let want = load(&format!("adjust_invert_{i}")).1;
        let rel: Vec<f32> = inv.iter().zip(&want).map(|(p, q)| (p - q) / q.abs().max(1.0)).collect();
        diff(&format!("adjust invert {c} (relative)"), &rel, &vec![0.0; rel.len()], 2e-7);
    }
    assert!(LinearAdjust::new(1.0000005, 1.0, 0.5).is_identity());
    assert!(!LinearAdjust::new(1.00001, 1.0, 0.5).is_identity());
}

fn smeta(source: Source, hw: (usize, usize), model: (usize, usize), adjust: LinearAdjust) -> ClipMeta {
    let mut m = meta(hw.0, hw.1, 128, 128);
    m.source = source;
    (m.model_h, m.model_w) = model;
    m.model_scale = model.0 as f64 / hw.0 as f64;
    m.pad = center_pad(model.0, model.1, 128, 128);
    m.adjust = adjust;
    m
}

/// bf16 views: the display view exact; the model view within one bf16 step where asinh lands on a rounding boundary.
fn check_prep(name: &str, p: &ck_core::decode::Prepped) {
    let model: Vec<f32> = p.model.iter().map(|v| v.to_f32()).collect();
    let display: Vec<f32> = p.display.iter().map(|v| v.to_f32()).collect();
    diff(&format!("{name} display (bf16)"), &display, &load(&format!("{name}_display")).1, 0.0);
    let want = load(&format!("{name}_model")).1;
    let steps = model.iter().zip(&want).filter(|(a, b)| a != b).count();
    println!("{name} model (bf16): {steps} of {} values one bf16 step apart", model.len());
    diff(&format!("{name} model (bf16)"), &model, &want, 1.0 / 128.0 * 1.1);
    assert!(steps * 1000 < model.len(), "{name}: too many bf16 steps: {steps}");
}

/// preprocess_video_frame_views at a model scale (37x53 -> 28x40) with and without the adjust, and the adjust alone.
#[test]
fn video_frames_at_a_model_scale_and_adjusted() {
    let (_, rgb) = load("scaled_frame_rgb");
    let bytes: Vec<u8> = rgb.iter().map(|&v| v as u8).collect();
    let video = || Source::Video(PathBuf::from("/c/clip.mp4"));
    let d = asinh_denom();
    let cases = [
        ("scaled_video", (28, 40), LinearAdjust::new(1.5, 1.2, 0.18)),
        ("scaled_video_id", (28, 40), LinearAdjust::default()),
        ("adjusted_video", (37, 53), LinearAdjust::new(0.7, 1.4, 0.3)),
    ];
    // loop: NOT-WORTH — three cases
    for (name, model, adj) in cases {
        let m = smeta(video(), (37, 53), model, adj);
        let p = prep_frame(rgb8_to_planar(&bytes, 37, 53), false, &m, d);
        let fix = |v: &str| if name == "scaled_video_id" { format!("scaled_video_{v}_id") } else { format!("{name}_{v}") };
        let model_v: Vec<f32> = p.model.iter().map(|v| v.to_f32()).collect();
        let display: Vec<f32> = p.display.iter().map(|v| v.to_f32()).collect();
        diff(&format!("{name} display (bf16)"), &display, &load(&fix("display")).1, 0.0);
        let want = load(&fix("model")).1;
        let steps = model_v.iter().zip(&want).filter(|(a, b)| a != b).count();
        diff(&format!("{name} model (bf16)"), &model_v, &want, 1.0 / 128.0 * 1.1);
        assert!(steps * 1000 < model_v.len(), "{name}: too many bf16 steps: {steps}");
    }
}

/// preprocess_frame_dir_path at a model scale (24x32 -> 18x24): a display-coded PNG and a scene-linear EXR.
#[test]
fn folder_frames_at_a_model_scale() {
    let s = |n: &str| fx("stills").join(n);
    let d = asinh_denom();
    // loop: NOT-WORTH — two files
    for (name, file, linear) in [("scaled_dir_png", "rgb8.png", false), ("scaled_dir_exr", "linear.exr", true)] {
        let mut m = smeta(Source::Frames(vec![]), (24, 32), (18, 24), LinearAdjust::default());
        m.exr_linear = linear;
        let p = prep_frame(read_image_rgb(&s(file), false).unwrap(), linear, &m, d);
        check_prep(name, &p);
    }
}

/// preprocess_hint_frame (30x40 -> the model's 22x30) and load_initial_hint_frame (the clip's 24x32 -> 18x24).
#[test]
fn hints_at_a_model_scale() {
    let (_, rgb) = load("hint_rgb");
    let data: Vec<u8> = rgb.iter().map(|&v| v as u8).collect();
    let m = smeta(Source::Frames(vec![]), (30, 40), (22, 30), LinearAdjust::default());
    let got = prep_hint(Still::U8 { ch: 3, h: 30, w: 40, data }, &m);
    diff("scaled hint prep", &got, &load("scaled_hint_prep").1, 1.0 / 256.0 + 1e-6);
    let m = smeta(Source::Frames(vec![]), (24, 32), (18, 24), LinearAdjust::default());
    let got = ck_core::decode::load_initial_hint(&fx("stills").join("hint16.png"), &m).unwrap();
    diff("scaled initial hint", &got, &load("scaled_initial_hint").1, 0.0);
}

/// np.random.default_rng(seed).integers(lo, hi + 1), the draw `--start_mode random_middle` makes.
#[test]
fn numpy_integers() {
    let j = rows_42_45();
    let mut n = 0;
    // loop: NOT-WORTH — a few hundred draws
    for c in j["draws"].as_array().unwrap() {
        let seed: u64 = c["seed"].as_str().unwrap().parse().unwrap();
        let (lo, hi) = (c["lo"].as_i64().unwrap(), c["hi"].as_i64().unwrap());
        assert_eq!(ck_core::rng::numpy_integers(seed, lo, hi), c["v"].as_i64().unwrap(), "{c}");
        n += 1;
    }
    println!("numpy integers: {n} draws identical");
}

#[test]
fn stills_as_cv2_reads_them() {
    let s = |n: &str| fx("stills").join(n);
    diff("still_rgb8_png", &read_image_rgb(&s("rgb8.png"), false).unwrap().data, &load("still_rgb8_png").1, 0.0);
    // 16-bit PNG, the default: as cv2.imread(IMREAD_COLOR) reads it (the high byte / 255), exactly
    diff("still_rgb16_png as cv2", &read_image_rgb(&s("rgb16.png"), false).unwrap().data, &load("still_rgb16_png").1, 0.0);
    // input_bit_depth 16 (the film-quality path, opt-in): the file's own 16-bit samples / 65535 exactly, less than
    // one 8-bit step from cv2's read
    let full = read_image_rgb(&s("rgb16.png"), true).unwrap().data;
    let Still::U16 { ch, h, w, data } = ck_core::decode::read_still(&s("rgb16.png")).unwrap() else { panic!("16-bit PNG not read as 16-bit") };
    assert_eq!(ch, 3, "the fixture is RGB");
    let n = h * w;
    // loop: NOT-WORTH — a small fixture
    let want: Vec<f32> = (0..3 * n).map(|i| data[(i % n) * 3 + i / n] as f32 / 65535.0).collect();
    diff("still_rgb16_png full depth", &full, &want, 0.0);
    diff("still_rgb16_png full depth vs cv2's 8 bits", &full, &load("still_rgb16_png").1, 1.0 / 255.0);
    // JPEG through libjpeg-turbo, as cv2 (the test machine has libturbojpeg.so.0)
    diff("still_q90_jpg", &read_image_rgb(&s("q90.jpg"), false).unwrap().data, &load("still_q90_jpg").1, 0.0);
    let h = ck_core::decode::read_still(&s("hint16.png")).unwrap();
    let Still::U16 { data, .. } = h else { panic!("16-bit hint not read as 16-bit") };
    let got: Vec<f32> = data.iter().map(|&v| v as f32 / 65535.0).collect();
    diff("still_hint16", &got, &load("still_hint16").1, 0.0);
}
