//! The ported math against the upstream Python functions' own outputs (tests/fixtures, made by
//! tools/gen_fixtures.py from a CorridorKey2.0 checkout). Each check prints its measured worst difference.
use ck_core::clip::{ClipMeta, Source};
use ck_core::color::*;
use ck_core::decode::{prep_frame, prep_hint, read_image_rgb, rgb8_to_planar, Still};
use ck_core::hann::{taper_weights, window_starts};
use ck_core::image::{center_pad, resize_area, resize_bilinear, resize_lanczos4, Planar};
use ck_core::render::{make_checker, render, RenderOpts};
use ck_core::vram::{estimate_peak_vram_gb, select_vram_profile};
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
        shape_h: sh,
        shape_w: sw,
        pad: center_pad(h, w, sh, sw),
        num_frames: 1,
        exr_linear: false,
        video_bits: 8,
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
    diff("lanczos4 up 64x96", &resize_lanczos4(&lz, 64, 96).data, &load("lanczos_64x96").1, 1e-5);
    diff("lanczos4 down 37x53", &resize_lanczos4(&lz, 37, 53).data, &load("lanczos_37x53").1, 1e-5);
}

#[test]
fn hint_frame_preprocessing() {
    let (_, rgb) = load("hint_rgb");
    let data: Vec<u8> = rgb.iter().map(|&v| v as u8).collect();
    let got = prep_hint(Still::U8 { ch: 3, h: 30, w: 40, data }, &meta(37, 53, 128, 128));
    diff("hint prep (gray, lanczos, pad, bf16)", &got, &load("hint_prep").1, 1.0 / 256.0 + 1e-6);
}

#[test]
fn windows_and_vram_table() {
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
    let mut n = 0;
    // loop: NOT-WORTH — a few hundred table cases
    for c in j["vram"].as_array().unwrap() {
        let hw = (c["hw"][0].as_u64().unwrap() as usize, c["hw"][1].as_u64().unwrap() as usize);
        let frames = c["frames"].as_u64().unwrap() as usize;
        if let Some(b) = c["budget"].as_f64() {
            let p = select_vram_profile(hw, frames, b);
            assert_eq!(
                (p.chunk, p.stride, p.low_vram),
                (c["chunk"].as_u64().unwrap() as usize, c["stride"].as_u64().unwrap() as usize, c["low_vram"].as_bool().unwrap()),
                "{c}"
            );
            assert!((p.estimate_gb - c["estimate"].as_f64().unwrap()).abs() < 1e-9, "{c}");
        } else {
            let e = estimate_peak_vram_gb((hw.0 * hw.1) as f64 / 1e6, frames, c["low_vram"].as_bool().unwrap());
            assert!((e - c["peak"].as_f64().unwrap()).abs() < 1e-9, "{c}");
        }
        n += 1;
    }
    println!("vram table: {n} cases identical");
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
    let checker = make_checker(30, 44);
    // loop: NOT-WORTH — three render modes
    for (exr, lin) in [(false, false), (false, true), (true, false)] {
        let o = RenderOpts { alpha: true, fg: true, checker: true, cutout: true, despill: 0.5, cutout_linear: lin, exr, adjust: LinearAdjust::default() };
        let out = render(&o, &logits, (40, 56), (5, 6), (30, 44), &checker);
        // loop: NOT-WORTH — four outputs
        for (name, b) in &out {
            if lin && *name != "cutout" {
                continue;
            }
            let fname = if exr {
                format!("render_exr_{name}")
            } else if lin {
                format!("render_video_{name}_lin")
            } else {
                format!("render_video_{name}")
            };
            // video: 16-bit samples, truncated: one step when a float32 product lands on the other side
            let tol = if exr { 2e-5 } else { 1.0 };
            let got = batch_f32(b);
            let mut want = load(&fname).1;
            if exr && *name == "cutout" {
                // the original writes the EXR cutout straight; ours is premultiplied on purpose (backlog row 30 c):
                // the reference's BGR x its own alpha
                // loop: HOT-PATH-OK — a 30x44 fixture, once
                for px in want.chunks_mut(4) {
                    let a = px[3];
                    // loop: NOT-WORTH — three channels
                    for v in &mut px[..3] {
                        *v *= a;
                    }
                }
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

#[test]
fn stills_as_cv2_reads_them() {
    let s = |n: &str| fx("stills").join(n);
    diff("still_rgb8_png", &read_image_rgb(&s("rgb8.png")).unwrap().data, &load("still_rgb8_png").1, 0.0);
    // 16-bit PNG: read at full depth (the film-quality path, 2026-10-24), where cv2 keeps only the high byte. So it
    // equals the file's own 16-bit samples / 65535 exactly, and differs from cv2 by less than one 8-bit step.
    let full = read_image_rgb(&s("rgb16.png")).unwrap().data;
    let Still::U16 { ch, h, w, data } = ck_core::decode::read_still(&s("rgb16.png")).unwrap() else { panic!("16-bit PNG not read as 16-bit") };
    assert_eq!(ch, 3, "the fixture is RGB");
    let n = h * w;
    // loop: NOT-WORTH — a small fixture
    let want: Vec<f32> = (0..3 * n).map(|i| data[(i % n) * 3 + i / n] as f32 / 65535.0).collect();
    diff("still_rgb16_png full depth", &full, &want, 0.0);
    diff("still_rgb16_png vs cv2's 8 bits", &full, &load("still_rgb16_png").1, 1.0 / 255.0);
    // JPEG through libjpeg-turbo, as cv2 (the test machine has libturbojpeg.so.0)
    diff("still_q90_jpg", &read_image_rgb(&s("q90.jpg")).unwrap().data, &load("still_q90_jpg").1, 0.0);
    let h = ck_core::decode::read_still(&s("hint16.png")).unwrap();
    let Still::U16 { data, .. } = h else { panic!("16-bit hint not read as 16-bit") };
    let got: Vec<f32> = data.iter().map(|&v| v as f32 / 65535.0).collect();
    diff("still_hint16", &got, &load("still_hint16").1, 0.0);
}
