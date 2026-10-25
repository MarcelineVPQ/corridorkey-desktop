//! Test 1 of the colour study's plan (docs/OCIO_STUDY_2026-10.md §7): every colour space of OCIO's built-in ACES
//! studio config, input space -> the model's linear Rec.709 -> back (the engine's own processors: output = input,
//! LOSSLESS), on a 64³ lattice, random signed HDR values and log codes. Pass:
//! - scene-linear spaces: within 4 float32 eps of the pixel's largest channel;
//! - log spaces: within 1e-3 of a 10-bit code on near-neutral codes whose linear value stays within 2^8 (the HDR
//!   range the linear spaces are tested over; ADX16, a film-scan density code with a 1D LUT in its definition, decodes
//!   codes above ~0.2 far past it, up to OCIO's 65504 clamp). The lattice and
//!   random codes include saturated colours, codes below a curve's floor (ACEScc) and float32 cancellation inside
//!   the gamut matrices (as in OCIO itself, the study §2): measured and printed, not asserted.
//!
//! Display-referred spaces (an inverse output transform on the way in) and data spaces are printed, not asserted:
//! neither is a keying input. Run with `--nocapture` to see the table.
use ck_core::ocio::{color_job, MODEL_SPACE};

/// A small deterministic generator (xorshift64*), so the inputs are the same on every run and every platform.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The 64³ lattice over [lo, hi] per channel, packed RGB.
fn lattice(lo: f32, hi: f32) -> Vec<f32> {
    let n = 64;
    let mut v = Vec::with_capacity(n * n * n * 3);
    // loop: NOT-WORTH — a test's 262 144 lattice points
    for r in 0..n {
        // loop: NOT-WORTH — as above
        for g in 0..n {
            // loop: NOT-WORTH — as above
            for b in 0..n {
                let s = |i: usize| lo + (hi - lo) * i as f32 / (n - 1) as f32;
                v.extend_from_slice(&[s(r), s(g), s(b)]);
            }
        }
    }
    v
}

/// `n` random signed HDR pixels: magnitudes 2^-14 to 2^8 (log-uniform), either sign.
fn signed_hdr(rng: &mut Rng, n: usize) -> Vec<f32> {
    // loop: NOT-WORTH — a test's random pixels
    (0..3 * n)
        .map(|_| {
            let m = (2f64).powf(-14.0 + 22.0 * rng.next());
            (if rng.next() < 0.5 { -m } else { m }) as f32
        })
        .collect()
}

/// `n` random code values in [0, 1] per channel (saturated colours included).
fn codes(rng: &mut Rng, n: usize) -> Vec<f32> {
    // loop: NOT-WORTH — a test's random pixels
    (0..3 * n).map(|_| rng.next() as f32).collect()
}

/// `n` near-neutral codes: a grey in [0.05, 0.95] with each channel within ±0.02 of it.
fn near_neutral(rng: &mut Rng, n: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(3 * n);
    // loop: NOT-WORTH — a test's random pixels
    for _ in 0..n {
        let g = 0.05 + 0.9 * rng.next();
        // loop: NOT-WORTH — three channels
        for _ in 0..3 {
            v.push((g + 0.04 * (rng.next() - 0.5)) as f32);
        }
    }
    v
}

/// The round trip of `x` through the job's input then output processor.
fn round_trip(j: &ck_core::ocio::ColorJob, x: &[f32]) -> Vec<f32> {
    let mut v = x.to_vec();
    if let Some(i) = &j.input {
        i.apply(&mut v, 3);
    }
    if let Some(o) = &j.output {
        o.apply(&mut v, 3);
    }
    v
}

/// The worst error in float32 eps of each pixel's largest channel (pixels whose round trip stays finite and whose
/// largest channel is above 2^-14: below that, eps of the channel is below OCIO's own denormal handling).
fn worst_eps(x: &[f32], y: &[f32]) -> f64 {
    let mut worst = 0f64;
    // loop: NOT-WORTH — a test's pixels
    for (a, b) in x.chunks_exact(3).zip(y.chunks_exact(3)) {
        let m = a.iter().fold(0f32, |m, v| m.max(v.abs()));
        if m < 2f32.powi(-14) {
            continue;
        }
        // loop: NOT-WORTH — three channels
        for c in 0..3 {
            worst = worst.max(((a[c] - b[c]).abs() / (f32::EPSILON * m)) as f64);
        }
    }
    worst
}

/// The worst error in 10-bit code values (1/1023).
fn worst_codes(x: &[f32], y: &[f32]) -> f64 {
    // loop: NOT-WORTH — a test's values
    x.iter().zip(y).fold(0f64, |w, (a, b)| w.max(((a - b).abs() * 1023.0) as f64))
}

/// The pixels of `x` whose linear value (the input processor's result) stays within 2^8, the HDR range the linear
/// spaces are tested over (ADX16 codes above ~0.2 decode to film densities far past it, up to OCIO's 65504 clamp),
/// and how many were left out.
fn in_hdr_range(j: &ck_core::ocio::ColorJob, x: &[f32]) -> (Vec<f32>, usize) {
    let mut lin = x.to_vec();
    if let Some(i) = &j.input {
        i.apply(&mut lin, 3);
    }
    let mut kept = Vec::with_capacity(x.len());
    // loop: NOT-WORTH — a test's pixels
    for (p, l) in x.chunks_exact(3).zip(lin.chunks_exact(3)) {
        if l.iter().all(|v| v.abs() <= 256.0) {
            kept.extend_from_slice(p);
        }
    }
    let dropped = (x.len() - kept.len()) / 3;
    (kept, dropped)
}

#[test]
fn every_studio_space_round_trips_through_the_model_space() {
    let cfg = "ocio://studio-config-latest";
    let d = ck_core::ocio::describe(Some(cfg), None).unwrap();
    let spaces = d["colorspaces"].as_array().unwrap();
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let hdr = signed_hdr(&mut rng, 1 << 20);
    let lat_lin = lattice(-1.0, 16.0);
    let lat_code = lattice(0.0, 1.0);
    let rnd_code = codes(&mut rng, 1 << 18);
    let grey = near_neutral(&mut rng, 1 << 18);
    let mut failures = Vec::new();
    let mut checked = (0, 0);
    println!("{:<44} {:<12} {:>12} {:>12} {:>12} {:>12}", "space", "encoding", "lattice", "random", "near-grey", "verdict");
    // loop: NOT-WORTH — the config's 57 spaces, once per test run
    for s in spaces {
        let name = s["name"].as_str().unwrap();
        let enc = s["encoding"].as_str().unwrap_or("");
        let j = match color_job(Some(cfg), None, Some(name), Some(name)) {
            Ok(Some(j)) => j,
            Ok(None) => unreachable!(),
            Err(e) => {
                println!("{name:<44} {enc:<12} no processor: {}", e.message);
                continue;
            }
        };
        let scene_linear = enc == "scene-linear" && !s["isdata"].as_bool().unwrap_or(false);
        let is_log = enc == "log";
        if scene_linear {
            let (a, b) = (worst_eps(&lat_lin, &round_trip(&j, &lat_lin)), worst_eps(&hdr, &round_trip(&j, &hdr)));
            let ok = a <= 4.0 && b <= 4.0;
            println!("{name:<44} {enc:<12} {a:>9.2} eps {b:>9.2} eps {:>12} {:>12}", "-", if ok { "pass" } else { "FAIL" });
            checked.0 += 1;
            if !ok {
                failures.push(format!("{name}: {a:.2} / {b:.2} eps"));
            }
        } else {
            let (grey_in, dropped) = in_hdr_range(&j, &grey);
            let (a, b, c) = (
                worst_codes(&lat_code, &round_trip(&j, &lat_code)),
                worst_codes(&rnd_code, &round_trip(&j, &rnd_code)),
                worst_codes(&grey_in, &round_trip(&j, &grey_in)),
            );
            let verdict = if is_log {
                checked.1 += 1;
                if c <= 1e-3 {
                    "pass (grey)"
                } else {
                    failures.push(format!("{name}: near-grey {c:.2e} codes"));
                    "FAIL"
                }
            } else {
                "not asserted"
            };
            let note = if dropped > 0 { format!(" ({dropped} grey pixels decoding above 2^8 left out)") } else { String::new() };
            println!("{name:<44} {enc:<12} {a:>8.2e} cd {b:>8.2e} cd {c:>8.2e} cd {verdict:>12}{note}");
        }
    }
    println!("checked: {} scene-linear spaces, {} log spaces ({MODEL_SPACE} is the model's space)", checked.0, checked.1);
    assert!(checked.0 >= 5 && checked.1 >= 5, "{checked:?}");
    assert!(failures.is_empty(), "{failures:#?}");
}
